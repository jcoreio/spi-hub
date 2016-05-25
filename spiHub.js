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
const DEFAULT_POLL_MSG_LENGTH = 20

const DEFAULT_SPI_SPEED = 1000000 // 1MHz
const CONFIG_FILE_PATH = '/etc/spi-hub.json'

const IRQ_SERVICE_DEFAULT_LENGTH = 20

const IPC_PROTO_VERSION = 1

const IPC_MSG_DEVICES_LIST        = 1
const IPC_MSG_MESSAGE_TO_DEVICE   = 2
const IPC_MSG_MESSAGE_FROM_DEVICE = 3

const IPC_DEVICE_MESSAGE_OVERHEAD = 7

const DEVICE_CMD_NONE                 = 0
const DEVICE_CMD_MESSAGE_TO_DEVICE    = 1
const DEVICE_CMD_MESSAGE_FROM_DEVICE  = 2
//const DEVICE_CMD_DEVICE_INFO_REQUEST  = 3
//const DEVICE_CMD_DEVICE_INFO_RESPONSE = 4

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
  ipcServer.start()
  console.log('started message server')

  while(true) {
    const pollStart = Date.now()
    busMap.forEach(bus => serviceBus(bus))
    const elapsed = Date.now() - pollStart
    sleep(Math.max(POLL_MIN_SLEEP, DEFAULT_POLL_INTERVAL - elapsed))
  }
}

function serviceBus(bus) {
  const devicesArr = bus.devicesArr
  if(!devicesArr.length) return;
  for(let deviceIdx = 0; deviceIdx < devicesArr.length; ++deviceIdx) {
    const device = devicesArr[deviceIdx]
    console.log('service device ', bus.id, typeof bus.id)
    let spiBuf = undefined
    if(bus.nextDeviceId !== device.id) {
      const busNextDevice = bus.nextDeviceId ? bus.devicesMap.get(bus.nextDeviceId) : undefined
      const msgLen = (busNextDevice || {}).nextMsgLen
      spiBuf = encodeMessageToDevice({ deviceId: 0, nextDeviceId: device.id, cmd: DEVICE_CMD_NONE, msgLen })
      console.log('initial request to device', spiBuf)
      wpi.wiringPiSPIDataRW(bus.id, spiBuf)
      const response = decodeMessageFromDevice(spiBuf)
      console.log('initial response from device: ', response, spiBuf)
      if(response) {
        // TODO: Process message
      }
    }

    const txQueue = device.txQueue
    do {
      let txMessage = txQueue[0]
      if(txQueue.length)
        txQueue.splice(0, 1)
      let nextDeviceIdx = txQueue.length ? deviceIdx : deviceIdx + 1
      if(nextDeviceIdx >= devicesArr.length) {
        nextDeviceIdx = 0
      }
      const nextDevice = devicesArr[nextDeviceIdx]
      spiBuf = encodeMessageToDevice(_.assign({}, txMessage, {
        deviceId: device.id,
        nextDeviceId: nextDevice.id,
        cmd: txMessage ? DEVICE_CMD_MESSAGE_TO_DEVICE : DEVICE_CMD_NONE,
        msgLen: device.nextMsgLen
      }))
      console.log('sending to device: ', spiBuf);
      wpi.wiringPiSPIDataRW(bus.id, spiBuf)
      const response = decodeMessageFromDevice(spiBuf)
      console.log('response from device: ', response, spiBuf);
      if(response) {
        // TODO: Process message
      }
      bus.nextDeviceId = nextDevice.id
      device.nextMsgLen = (response || {}).nextMsgLen
    } while(txQueue.length)
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
      { id: 2, info: { id: 'iron-pi-io16',    version: '1.0.0' }, txQueue: [] } ]
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
  msgDevicesList.writeUInt8(IPC_MSG_DEVICES_LIST, 1)
  bufDevicesList.copy(msgDevicesList, 2)
  return msgDevicesList
}

function onIPCConnection(connection) {
  connection.send(devicesListMessage)
}

function onIPCMessage(event) {
  const message = event.data
  try {
    assert(message.length >= MSG_TO_DEVICE_OVERHEAD, 'message is too short')
    const version     = message.readUInt8(0)
    const msg         = message.readUInt8(1)
    const busId       = message.readUInt8(2)
    const deviceId    = message.readUInt8(3)
    const channelId   = message.readUInt8(4)
    const msgDeDupeId = message.readUInt16LE(5)
    assert(IPC_PROTO_VERSION === version, `unexpected ipc protocol version: ${version}`)
    assert(IPC_MSG_MESSAGE_TO_DEVICE === msg, `unexpected ipc message id: ${msg}`)
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
        msgLen: message.length - IPC_DEVICE_MESSAGE_OVERHEAD,
        msgPos: IPC_DEVICE_MESSAGE_OVERHEAD })
  } catch (err) {
    console.error('error handling IPC message: ', err.stack);
  }
}

function encodeMessageToDevice(opts) {
  const msgPos = opts.msgPos || 0
  const messageLen = (opts.message ? opts.message.length - msgPos : 0);
  const txBufRequiredLen = messageLen + MSG_TO_DEVICE_OVERHEAD;
  const rxRequiredLen = opts.msgLen ? opts.msgLen + MSG_FROM_DEVICE_OVERHEAD : DEFAULT_POLL_MSG_LENGTH;
  const requiredBufLen = Math.max(txBufRequiredLen, rxRequiredLen);
  const buffer = allocBuffer(Math.max(requiredBufLen, DEFAULT_POLL_MSG_LENGTH))
  buffer.writeUInt8(opts.deviceId, 0)
  buffer.writeUInt8(opts.nextDeviceId, 1)
  buffer.writeUInt8(opts.cmd, 2)
  buffer.writeUInt8(opts.channelId, 3)
  buffer.writeUInt16LE(messageLen, 4)
  if(opts.message)
    opts.message.copy(buffer, MSG_TO_DEVICE_OVERHEAD, msgPos)
  return buffer
}

function decodeMessageFromDevice(buf) {
  if(buf.length < MSG_FROM_DEVICE_OVERHEAD) return undefined
  // Skip one empty byte
  const deviceId = buf.readUInt8(1)
  const queueCount = buf.readUInt8(2)
  const nextMsgLen = buf.readUInt16LE(3)
  const cmd = buf.readUInt8(5)
  const channel = buf.readUInt8(6)
  const msgLen = buf.readUInt16LE(7)
  const dataLen = Math.min(msgLen, buf.length - MSG_FROM_DEVICE_OVERHEAD)
  const data = msgLen ? allocBuffer(dataLen) : undefined
  if(data)
    buf.copy(data, 0, MSG_FROM_DEVICE_OVERHEAD, MSG_FROM_DEVICE_OVERHEAD + dataLen)
  return { deviceId, queueCount, nextMsgLen, cmd, channel, msgLen, data }
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
