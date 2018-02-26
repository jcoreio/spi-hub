#!/usr/bin/env node

'use strict'

const assert = require('assert')

const Fiber = require('fibers')
const sleep = require('fiber-sleep')
const _ = require('lodash')
const fs = require('fs')
const ipc = require('socket-ipc')
const wpi = require('wiring-pi')

const DEFAULT_POLL_INTERVAL = 200 // 5Hz poll interval
const POLL_MIN_SLEEP = 50
const DEFAULT_POLL_MSG_LENGTH = 40

const DEFAULT_SPI_SPEED = 1000000 // 1MHz
const CONFIG_FILE_PATH = '/etc/spi-hub.json'

const IPC_PROTO_VERSION = 1
const IPC_DEVICE_MESSAGE_OVERHEAD = 7

// Commands that are valid both on the SPI bus and on the IPC socket
const SPI_HUB_CMD_NONE            = 0
const SPI_HUB_CMD_MSG_TO_DEVICE   = 1
const SPI_HUB_CMD_MSG_FROM_DEVICE = 2
// Commands that are only valid on the IPC socket
const SPI_HUB_CMD_DEVICES_LIST    = 100

const MSG_TO_DEVICE_OVERHEAD = 6
const MSG_FROM_DEVICE_OVERHEAD = 9

const nodeVersion = process.version.split('.');
const isNode6 = nodeVersion.length >= 3 && nodeVersion[0] >= 6;

let ipcServer = undefined

const busMap = new Map(); // busId -> Map<deviceId, deviceInfo>

let devicesListMessage = undefined

const mainFiber = Fiber(main)

function main() {
  let configExists = false
  try {
    fs.accessSync(CONFIG_FILE_PATH)
    configExists = true
  } catch (err) { }

  let buses = undefined
  if(configExists) {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH).toString())
    buses = config.buses
  } else {
    let busDevEntryPaths = process.argv.slice(2)
    if(!busDevEntryPaths.length) {
      busDevEntryPaths = fs.readdirSync('/dev')
        .filter(entry => entry.startsWith('spi'))
        .map(entry => `/dev/${entry}`)
        .slice(0, 1)
      if(!busDevEntryPaths.length) throw new Error('no spi devices found in /dev')
    }
    buses = busDevEntryPaths.map(path => ({ path }))
  }

  buses.forEach((bus, id) => initSPIBus(_.defaults({}, bus, { id })))
  devicesListMessage = createDevicesListMessage()

  ipcServer = new ipc.MessageServer('/tmp/socket-spi-hub', { binary: true })
  ipcServer.on('message', onIPCMessage)
  ipcServer.on('connection', onIPCConnection)
  ipcServer.on('error', err => console.error('ipc server error: ', err.stack || err))
  ipcServer.start()
  console.log('started message server')

  while(true) {
    const pollStart = Date.now()
    busMap.forEach(bus => serviceBus(bus))
    const elapsed = Date.now() - pollStart
    sleep(Math.max(POLL_MIN_SLEEP, DEFAULT_POLL_INTERVAL - elapsed))
  }
}

const devicesInitialized = []

function serviceBus(bus) {
  const devicesArr = bus.devicesArr
  if(!devicesArr.length) return;
  for(let deviceIdx = 0; deviceIdx < devicesArr.length; ++deviceIdx) {
    const device = devicesArr[deviceIdx]
    let spiBuf = undefined
    if(bus.nextDeviceId !== device.id) {
      // Select the device
      spiBuf = encodeMessageToDevice({ deviceId: 0, nextDeviceId: device.id, cmd: SPI_HUB_CMD_NONE })
      //console.log('initial request to device', spiBuf)
      wpi.wiringPiSPIDataRW(bus.id, spiBuf)
    }

    const txQueue = device.txQueue
    while(!devicesInitialized[deviceIdx] || txQueue.length) {
    //do {
      devicesInitialized[deviceIdx] = true

      let txMessage = txQueue[0]
      if (txQueue.length)
        txQueue.splice(0, 1)
      let nextDeviceIdx = txQueue.length ? deviceIdx : deviceIdx + 1
      if (nextDeviceIdx >= devicesArr.length)
        nextDeviceIdx = 0
      const nextDevice = devicesArr[nextDeviceIdx]
      spiBuf = encodeMessageToDevice(_.assign({}, txMessage, {
        deviceId: device.id,
        nextDeviceId: nextDevice.id,
        cmd: txMessage ? SPI_HUB_CMD_MSG_TO_DEVICE : SPI_HUB_CMD_NONE,
        msgLen: device.nextMsgLen || DEFAULT_POLL_MSG_LENGTH
      }))
      console.log('sending to device: ', spiBuf);
      wpi.wiringPiSPIDataRW(bus.id, spiBuf)
      console.log('raw device response:', spiBuf);

      const response = decodeMessageFromDevice(spiBuf)
      const deviceMatches = response.deviceId === device.id
      device.nextMsgLen = deviceMatches ? response.nextMsgLen : undefined
      //console.log('response from device: ', response)
      if (!response.errCode) {
        if (deviceMatches) {
          handleResponseFromDevice(bus, response)
        } else {
          console.log(`wrong device id in response from device: expected ${device.id}, got ${response.deviceId}`)
        }
      } else {
        console.log(`error code ${response.errCode} when decoding response from device ${device.id}: ${response.errMsg}`)
      }

      bus.nextDeviceId = nextDevice.id
    }
    //} while(txQueue.length)
  }
}

let gpioInitialized = false

function initSPIBus(bus) {
  try {
    wpi.wiringPiSPISetup(bus.id, bus.speed || DEFAULT_SPI_SPEED)

    if(bus.irqPin != undefined) {
      if(!gpioInitialized) {
        wpi.setup('gpio')
        gpioInitialized = true
      }
      wpi.pinMode(bus.irqPin, wpi.INPUT)
      const activeLow = 'low' === (bus.irqActive || '').toLowerCase()
      wpi.wiringPiISR(bus.irqPin, activeLow ? wpi.INT_EDGE_FALLING : wpi.INT_EDGE_RISING, () => spiBusIRQ(bus))
    }

    const devicesArr = [
      { id: 1, info: { id: 'iron-pi-cm8-mcu', version: '1.0.0' }, txQueue: [] },
      //{ id: 2, info: { id: 'iron-pi-io16',    version: '1.0.0' }, txQueue: [] }
    ]
    const devicesMap = new Map()
    devicesArr.forEach(device => devicesMap.set(device.id, device))
    busMap.set(bus.id, {
      id: bus.id,
      config: bus,
      devicesArr,
      devicesMap
    })
  } catch (err) {
    console.error(`could not initialize SPI bus at ${bus.path}:`, err.stack)
  }
}

const busIRQs = []

function spiBusIRQ(bus) {
  if(!_.includes(busIRQs, bus.id))
    busIRQs.push(bus.id)
  // TODO: Wake handler fiber
}

function createDevicesListMessage() {
  const devices = []
  busMap.forEach((bus, busId) => {
    bus.devicesArr.forEach(device => {
      devices.push({ bus: busId, device: device.id, info: device.info })
    })
  })

  const bufDevicesList = stringToBuffer(JSON.stringify(devices))
  const msgDevicesList = allocBuffer(bufDevicesList.length + 2)
  msgDevicesList.writeUInt8(IPC_PROTO_VERSION, 0)
  msgDevicesList.writeUInt8(SPI_HUB_CMD_DEVICES_LIST, 1)
  bufDevicesList.copy(msgDevicesList, 2)
  return msgDevicesList
}

function onIPCConnection(connection) {
  connection.send(devicesListMessage)
}

function onIPCMessage(event) {
  console.log('got ipc message')
  const message = event.data
  try {
    assert(message.length >= MSG_TO_DEVICE_OVERHEAD, 'message is too short')
    let pos = 0
    const version     = message.readUInt8(pos++)
    const msg         = message.readUInt8(pos++)
    const busId       = message.readUInt8(pos++)
    const deviceId    = message.readUInt8(pos++)
    const channelId   = message.readUInt8(pos++)
    const msgDeDupeId = message.readUInt16LE(pos)
    pos += 2
    assert(IPC_PROTO_VERSION === version, `unexpected ipc protocol version: ${version}`)
    assert(SPI_HUB_CMD_MSG_TO_DEVICE === msg, `unexpected ipc message id: ${msg}`)
    const bus = busMap.get(busId);
    assert(bus, `SPI bus not found at id ${busId}`);
    const device = bus.devicesMap.get(deviceId);
    assert(device, `device not found at bus ${busId}, device ${deviceId}`)

    const txQueue = device.txQueue
    const existMsgId = msgDeDupeId ? txQueue.findIndex(queueItem => queueItem.msgDeDupeId === msgDeDupeId) : -1
    if(existMsgId >= 0)
      txQueue[existMsgId].message = message
    else
      txQueue.push({ msgDeDupeId, deviceId, channelId, message,
              msgLen: message.length - pos, msgPos: pos })
  } catch (err) {
    console.error('error handling IPC message: ', err.stack);
  }
}

function handleResponseFromDevice(bus, response) {
  const msgLen = (response.message || {}).length || 0
  const ipcMsg = allocBuffer(msgLen + IPC_DEVICE_MESSAGE_OVERHEAD)
  let pos = 0
  ipcMsg.writeUInt8(IPC_PROTO_VERSION, pos++)
  ipcMsg.writeUInt8(SPI_HUB_CMD_MSG_FROM_DEVICE, pos++)
  ipcMsg.writeUInt8(bus.id, pos++)
  ipcMsg.writeUInt8(response.deviceId, pos++)
  ipcMsg.writeUInt8(response.channelId, pos++)
  ipcMsg.writeUInt16LE(0, pos) // message de-dupe id, not used
  pos += 2
  if(response.message)
    response.message.copy(ipcMsg, pos)
  ipcServer.send(ipcMsg)
}

function encodeMessageToDevice(opts) {
  const msgPos = opts.msgPos || 0
  const msgLen = opts.message ? opts.message.length - msgPos : 0
  const txRequiredLen = msgLen + MSG_TO_DEVICE_OVERHEAD;
  const rxRequiredLen = opts.msgLen ? opts.msgLen + MSG_FROM_DEVICE_OVERHEAD : 0
  const buffer = allocBuffer(Math.max(txRequiredLen, rxRequiredLen))
  let pos = 0
  buffer.writeUInt8(opts.deviceId, pos++)
  buffer.writeUInt8(opts.nextDeviceId, pos++)
  buffer.writeUInt8(opts.cmd, pos++)
  buffer.writeUInt8(opts.channelId, pos++)
  buffer.writeUInt16LE(msgLen, pos)
  pos += 2
  if(opts.message)
    opts.message.copy(buffer, pos, msgPos)
  return buffer
}

function decodeMessageFromDevice(buf) {
  if(buf.length < MSG_FROM_DEVICE_OVERHEAD) {
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
  if(rxMsgLen >= msgLen) {
    if(msgLen) {
      decodedMsg.message = allocBuffer(msgLen)
      buf.copy(decodedMsg.message, 0, MSG_FROM_DEVICE_OVERHEAD, MSG_FROM_DEVICE_OVERHEAD + msgLen)
    }
  } else {
    _.assign(decodedMsg, { errMsg: 'message was truncated', errCode: 'MESSAGE_TRUNCATED' })
  }
  return decodedMsg;
}

function allocBuffer(len) {
  const buf = isNode6 ? Buffer.alloc(len) : new Buffer(len)
  if(!isNode6) buf.fill(0)
  return buf
}

function stringToBuffer(str) {
  return isNode6 ? Buffer.from(str) : new Buffer(str)
}

mainFiber.run()
