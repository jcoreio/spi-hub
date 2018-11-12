#!/usr/bin/env node

'use strict'

const assert = require('assert')

const _ = require('lodash')
const fs = require('fs')
const ipc = require('socket-ipc')
const wpi = require('wiring-pi')

const { readSerialNumberAndAccessCode } = require('./readSerialNumber')

const DEVICE_INFO_CM8 = { model: 'iron-pi-cm8', version: '1.0.0' }
const DEVICE_INFO_IO16 = { model: 'iron-pi-io16', version: '1.0.0' }
const DEVICES_ALL = _.flatten([
  DEVICE_INFO_CM8,
  _.range(4).map(() => DEVICE_INFO_IO16)
]).map((info, idx) => ({ id: idx + 1, info }))

const DEFAULT_POLL_MSG_LENGTH = 40

const DEFAULT_SPI_SPEED = 1000000 // 1MHz
const CONFIG_FILE_PATH = '/etc/spi-hub.json'

const IPC_PROTO_VERSION = 2
const IPC_MESSAGE_TO_DEVICE_OVERHEAD = 4
const IPC_MESSAGE_FROM_DEVICE_OVERHEAD = 7

const IPC_MESSAGE_TO_DEVICE_PREAMBLE = 0xA3

// Commands that are valid both on the SPI bus and on the IPC socket
const SPI_HUB_CMD_NONE = 0
const SPI_HUB_CMD_MSG_TO_DEVICE = 1
const SPI_HUB_CMD_MSG_FROM_DEVICE = 2
// Commands that are only valid on the IPC socket
const SPI_HUB_CMD_DEVICES_LIST = 100

const SPI_MSG_TO_DEVICE_OVERHEAD = 6
const SPI_MSG_FROM_DEVICE_OVERHEAD = 9

const MESSAGE_GAP_MIN = 2 // milliseconds minimum between messages

let ipcServer

const busMap = new Map() // busId -> Map<deviceId, deviceInfo>

let devicesListMessage

const sleep = (time) => new Promise((resolve) => setTimeout(resolve, time))

async function main () {
  let configExists = false
  try {
    fs.accessSync(CONFIG_FILE_PATH)
    configExists = true
  } catch (err) { }

  let buses
  if (configExists) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH).toString())
    buses = config.buses
  } else {
    let busDevEntryPaths = process.argv.slice(2)
    if (!busDevEntryPaths.length) {
      busDevEntryPaths = fs.readdirSync('/dev')
        .filter(entry => entry.startsWith('spi'))
        .map(entry => `/dev/${entry}`)
        .slice(0, 1)
      if (!busDevEntryPaths.length) throw new Error('no spi devices found in /dev')
    }
    buses = busDevEntryPaths.map(path => ({ path }))
  }

  ipcServer = new ipc.MessageServer('/tmp/socket-spi-hub', { binary: true })
  ipcServer.on('message', onIPCMessage)
  ipcServer.on('connection', onIPCConnection)
  ipcServer.on('error', err => console.error('ipc server error: ', err.stack || err))
  ipcServer.start()
  console.log('started message server')

  for (let busIdx = 0; busIdx < buses.length; ++busIdx) {
    await initSPIBus({...buses[busIdx], id: busIdx})
  }
  devicesListMessage = await createDevicesListMessage()
}

let _serviceBusesRepeat = false
let _serviceBusesInProgress = false

async function serviceBuses({isPoll} = {}) {
  if (_serviceBusesInProgress) {
    if (!isPoll)
      _serviceBusesRepeat = true
    return
  }
  try {
    _serviceBusesInProgress = true
    let sanityCount = 10
    do {
      _serviceBusesRepeat = false
      if (--sanityCount <= 0)
        throw Error('infinite loop in serviceBuses()')
      for (const bus of busMap.values()) {
        await serviceBus(bus)
      }
    } while (_serviceBusesRepeat)
  } finally {
    _serviceBusesInProgress = false
  }
}

async function serviceBus (bus, opts = {}) {
  const {detect} = opts
  const detectedDevices = detect ? new Set() : null
  const devicesArr = bus.devicesArr
  let isFirstMessage = true
  for (let deviceIdx = 0; deviceIdx < devicesArr.length; ++deviceIdx) {
    const device = devicesArr[deviceIdx]
    let spiBuf
    if (bus.nextDeviceId !== device.id) {
      // Select the device
      spiBuf = encodeMessageToDevice({ deviceId: 0, nextDeviceId: device.id, cmd: SPI_HUB_CMD_NONE })
      // console.log('initial request to device', spiBuf)

      if (!isFirstMessage)
        await sleep(MESSAGE_GAP_MIN)
      isFirstMessage = false

      wpi.wiringPiSPIDataRW(bus.id, spiBuf)
    }

    const txQueue = device.txQueue
    do {
      let txMessage = txQueue[0]
      if (txQueue.length)
        txQueue.splice(0, 1)
      let nextDeviceIdx = txQueue.length ? deviceIdx : deviceIdx + 1
      if (nextDeviceIdx >= devicesArr.length)
        nextDeviceIdx = 0
      const nextDevice = devicesArr[nextDeviceIdx]
      spiBuf = encodeMessageToDevice({
        ...txMessage,
        deviceId: device.id,
        nextDeviceId: nextDevice.id,
        cmd: txMessage ? SPI_HUB_CMD_MSG_TO_DEVICE : SPI_HUB_CMD_NONE,
        msgLen: device.nextMsgLen || DEFAULT_POLL_MSG_LENGTH
      })

      if (!isFirstMessage)
        await sleep(MESSAGE_GAP_MIN)
      isFirstMessage = false

      // console.log('sending to device: ', spiBuf);
      wpi.wiringPiSPIDataRW(bus.id, spiBuf)
      // console.log('raw device response:', spiBuf);

      const response = decodeMessageFromDevice(spiBuf)
      const deviceMatches = response.deviceId === device.id
      device.nextMsgLen = deviceMatches ? response.nextMsgLen : undefined
      // console.log('response from device: ', response)
      if (!response.errCode) {
        if (deviceMatches) {
          handleResponseFromDevice(bus, response)
          if (detect)
            detectedDevices.add(device.id)
          // console.log(`got valid response from device ${device.id}`)
        } else {
          if (!detect)
            console.log(`wrong device id in response from device: expected ${device.id}, got ${response.deviceId}`)
        }
      } else {
        //if (!detect)
          console.log(`error code ${response.errCode} when decoding response from device ${device.id}: ${response.errMsg}`)
      }

      bus.nextDeviceId = nextDevice.id
    } while(txQueue.length)
  }

  if (detect) {
    bus.devicesArr = devicesArr.filter(device => detectedDevices.has(device.id))
    bus.devicesMap.clear()
    bus.devicesArr.forEach(device => bus.devicesMap.set(device.id, device))
    for (const device of bus.devicesArr) {
      console.log(`detected: id ${device.id} model ${device.info.model}`)
    }
  }
}

let gpioInitialized = false

async function initSPIBus (bus) {
  try {
    wpi.wiringPiSPISetup(bus.id, bus.speed || DEFAULT_SPI_SPEED)

    if (bus.irqPin != null) {
      if (!gpioInitialized) {
        wpi.setup('gpio')
        gpioInitialized = true
      }
      wpi.pinMode(bus.irqPin, wpi.INPUT)
      const activeLow = (bus.irqActive || '').toLowerCase() === 'low'
      wpi.wiringPiISR(bus.irqPin, activeLow ? wpi.INT_EDGE_FALLING : wpi.INT_EDGE_RISING, () => spiBusIRQ(bus))
    }

    const devicesArr = DEVICES_ALL.map((deviceDef) => ({ ...deviceDef, txQueue: [] }))

    const busMapEntry = {
      id: bus.id,
      config: bus,
      devicesArr,
      devicesMap: new Map(),
    }
    busMap.set(bus.id, busMapEntry)
    await serviceBus(busMapEntry, {detect: true})
  } catch (err) {
    console.error(`could not initialize SPI bus at ${bus.path}:`, err.stack)
  }
}

const busIRQs = []

function spiBusIRQ (bus) {
  if (!_.includes(busIRQs, bus.id)) { busIRQs.push(bus.id) }
  // TODO: Wake handler fiber
}

async function createDevicesListMessage () {
  const { serialNumber, accessCode } = await readSerialNumberAndAccessCode()

  const devices = []
  busMap.forEach((bus, busId) => {
    bus.devicesArr.forEach(device => {
      devices.push({ busId: busId, deviceId: device.id, deviceInfo: device.info })
    })
  })

  const bufDevicesList = Buffer.from(JSON.stringify({ devices, serialNumber, accessCode }))
  const msgDevicesList = Buffer.alloc(bufDevicesList.length + 2)
  msgDevicesList.writeUInt8(IPC_PROTO_VERSION, 0)
  msgDevicesList.writeUInt8(SPI_HUB_CMD_DEVICES_LIST, 1)
  bufDevicesList.copy(msgDevicesList, 2)
  return msgDevicesList
}

function onIPCConnection (connection) {
  if (devicesListMessage)
    connection.send(devicesListMessage)
}

function onIPCMessage (event) {
  // console.log('got ipc message')
  const message = event.data
  try {
    assert(message.length >= IPC_MESSAGE_TO_DEVICE_OVERHEAD, 'message is too short')
    let pos = 0
    const version = message.readUInt8(pos++)
    const msg = message.readUInt8(pos++)
    const len = message.readUInt16LE(pos)
    pos += 2

    assert.strictEqual(version, IPC_PROTO_VERSION, `unexpected ipc protocol version: ${version}`)
    assert.strictEqual(msg, SPI_HUB_CMD_MSG_TO_DEVICE, `unexpected ipc message id: ${msg}`)

    for (let msgIdx = 0; msgIdx < len; ++msgIdx) {
      const preamble = message.readUInt8(pos++)
      assert.strictEqual(preamble, IPC_MESSAGE_TO_DEVICE_PREAMBLE, `unexpected preamble to device message: ${preamble}`)
      const busId = message.readUInt8(pos++)
      const deviceId = message.readUInt8(pos++)
      const channelId = message.readUInt8(pos++)
      const msgDeDupeId = message.readUInt16LE(pos)
      pos += 2
      const payloadLen = message.readUInt16LE(pos)
      pos += 2
      const payload = Buffer.alloc(payloadLen)
      message.copy(payload, 0, pos, pos + payloadLen)
      pos += payloadLen

      const bus = busMap.get(busId)
      assert(bus, `SPI bus not found at id ${busId}`)
      const device = bus.devicesMap.get(deviceId)
      assert(device, `device not found at bus ${busId}, device ${deviceId}`)

      const txQueue = device.txQueue
      const existMsgId = msgDeDupeId ? txQueue.findIndex(queueItem => queueItem.msgDeDupeId === msgDeDupeId) : -1
      if (existMsgId >= 0) {
        txQueue[existMsgId].payload = payload
      } else {
        txQueue.push({ msgDeDupeId,
          deviceId,
          channelId,
          payload
        })
      }
    }
    
    serviceBuses()
      .catch(err => console.error('unexpected error from serviceBuses() called by onIPCMessage():', err))
  } catch (err) {
    console.error('error handling IPC message: ', err.stack)
  }
}

function handleResponseFromDevice (bus, response) {
  const msgLen = (response.message || {}).length || 0
  const ipcMsg = Buffer.alloc(msgLen + IPC_MESSAGE_FROM_DEVICE_OVERHEAD)
  let pos = 0
  ipcMsg.writeUInt8(IPC_PROTO_VERSION, pos++)
  ipcMsg.writeUInt8(SPI_HUB_CMD_MSG_FROM_DEVICE, pos++)
  ipcMsg.writeUInt8(bus.id, pos++)
  ipcMsg.writeUInt8(response.deviceId, pos++)
  ipcMsg.writeUInt8(response.channelId, pos++)
  ipcMsg.writeUInt16LE(0, pos) // message de-dupe id, not used
  pos += 2
  if (response.message) { response.message.copy(ipcMsg, pos) }
  ipcServer.send(ipcMsg)
}

function encodeMessageToDevice (opts) {
  const msgLen = opts.payload ? opts.payload.length : 0
  const txRequiredLen = msgLen + SPI_MSG_TO_DEVICE_OVERHEAD
  const rxRequiredLen = opts.msgLen ? opts.msgLen + SPI_MSG_FROM_DEVICE_OVERHEAD : 0
  const buffer = Buffer.alloc(Math.max(txRequiredLen, rxRequiredLen))
  let pos = 0
  buffer.writeUInt8(opts.deviceId, pos++)
  buffer.writeUInt8(opts.nextDeviceId, pos++)
  buffer.writeUInt8(opts.cmd, pos++)
  buffer.writeUInt8(opts.channelId, pos++)
  buffer.writeUInt16LE(msgLen, pos)
  pos += 2
  if (opts.payload) { opts.payload.copy(buffer, pos) }
  return buffer
}

function decodeMessageFromDevice (buf) {
  if (buf.length < SPI_MSG_FROM_DEVICE_OVERHEAD) {
    return { errMsg: 'message is too short to process', errCode: 'MSG_TOO_SHORT' }
  }
  // Skip one empty byte
  let pos = 1
  const deviceId = buf.readUInt8(pos++)
  const queueCount = buf.readUInt8(pos++)
  const nextMsgLen = buf.readUInt16LE(pos)
  pos += 2
  const cmd = buf.readUInt8(pos++)
  const channelId = buf.readUInt8(pos++)
  const msgLen = buf.readUInt16LE(pos)
  pos += 2
  const decodedMsg = { deviceId, queueCount, nextMsgLen, cmd, channelId, msgLen }
  const rxMsgLen = buf.length - pos
  if (rxMsgLen >= msgLen) {
    if (msgLen) {
      decodedMsg.message = Buffer.alloc(msgLen)
      buf.copy(decodedMsg.message, 0, SPI_MSG_FROM_DEVICE_OVERHEAD, SPI_MSG_FROM_DEVICE_OVERHEAD + msgLen)
    }
  } else {
    _.assign(decodedMsg, { errMsg: 'message was truncated', errCode: 'MESSAGE_TRUNCATED' })
  }
  return decodedMsg
}

main()
  .catch((err) => {
    console.error(err.stack || err)
    process.exit(1)
  })
