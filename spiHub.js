#!/usr/bin/env node

'use strict'

const assert = require('assert')

const _ = require('lodash')
const fs = require('fs')
const SPI = require('pi-spi')
const ipc = require('socket-ipc')

const IPC_PROTO_VERSION = 1

const IPC_MSG_DEVICES_LIST        = 1
const IPC_MSG_MESSAGE_TO_DEVICE   = 2
const IPC_MSG_MESSAGE_FROM_DEVICE = 3

const IPC_DEVICE_MESSAGE_OVERHEAD = 5

const DEVICE_MSG_DEVICE_INFO_REQUEST  = 1
const DEVICE_MSG_DEVICE_INFO_RESPONSE = 2
const DEVICE_MSG_MESSAGE_TO_DEVICE    = 3
const DEVICE_MSG_MESSAGE_FROM_DEVICE  = 4
const DEVICE_MSG_IRQ_SERVICE          = 5

const DEVICE_MSG_OVERHEAD = 5

const nodeVersion = process.version.split('.');
const isNode6 = nodeVersion.length >= 3 && nodeVersion[0] >= 6;

let server = undefined

const busMap = new Map(); // busId -> Map<deviceId, deviceInfo>

const devices = []

main()

function main() {
  let busDevEntryPaths = process.argv.slice(2)
  if(!busDevEntryPaths.length) {
    busDevEntryPaths = fs.readdirSync('/dev')
      .filter(entry => entry.startsWith('spi'))
      .map(entry => `/dev/${entry}`)
      .slice(0, 1)
    if(!busDevEntryPaths.length) throw new Error('no spi devices found in /dev')
  }

  server = new ipc.MessageServer('/tmp/socket-spi-hub', { binary: true })
  server.on('message', onIPCMessage)
  server.on('connection', onIPCConnection)
  server.start()
  console.log('started message server')

  busDevEntryPaths.forEach(handleSPIBus)
}

function handleSPIBus(busDevicePath, busIndex) {
  console.log(`initializing SPI bus at ${busDevicePath}...`)
  try {
    const fakeDevice = { index: 0, info: { device: 'iron-pi-cm8-mcu', version: '1.0.0' } };
    const devices = new Map();
    devices.set(0, fakeDevice);
    busMap.set(busIndex, {
      spi: SPI.initialize(busDevicePath),
      devices
    })
  } catch (err) {
    console.error(`could not initialize SPI bus at ${busDevicePath}:`, err.stack)
  }
}

let devicesListMessage = createDevicesListMessage()

function createDevicesListMessage() {
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
    assert(message.length >= DEVICE_MSG_OVERHEAD, 'message is too short')
    const version    = message.readUInt8(0)
    const msg        = message.readUInt8(1);
    const busIdx     = message.readUInt8(2);
    const deviceIdx  = message.readUInt8(3);
    const channelIdx = message.readUInt8(4);
    assert(IPC_PROTO_VERSION === version, `unexpected ipc protocol version: ${version}`)
    assert(IPC_MSG_MESSAGE_TO_DEVICE === msg, `unexpected ipc message id: ${msg}`)
    const bus = busMap.get(busIdx);
    assert(bus, `SPI bus not found at index ${busIdx}`);
    const device = bus.devices.get(deviceIdx);
    assert(device, `device not found at bus ${busIdx}, device ${deviceIdx}`)

    console.log('writing message to SPI bus', message.toString('utf8', IPC_DEVICE_MESSAGE_OVERHEAD))

    bus.spi.write(encodeMessageToDevice(deviceIdx, DEVICE_MSG_MESSAGE_TO_DEVICE,
        channelIdx, message, IPC_DEVICE_MESSAGE_OVERHEAD), err => {
      if(err) console.error('could not write to SPI:', err.stack || err)
      else console.log('successfully wrote SPI message')
    });
  } catch (err) {
    console.error('error handling IPC message: ', err.stack);
  }
}

function encodeMessageToDevice(deviceIdx, deviceCommand, channelIdx, message, msgPos) {
  msgPos = msgPos || 0
  const messageLen = message.length - msgPos
  const buffer = allocBuffer(messageLen + DEVICE_MSG_OVERHEAD)
  buffer.writeUInt8(deviceIdx, 0)
  buffer.writeUInt8(deviceCommand, 1)
  buffer.writeUInt8(channelIdx, 2)
  buffer.writeUInt16LE(messageLen, 3)
  message.copy(buffer, 5, msgPos)
  return buffer
}

function allocBuffer(len) {
  const buf = isNode6 ? Buffer.alloc(len) : new Buffer(len)
  if(!isNode6) buf.fill(0)
  return buf
}

function stringToBuffer(str) {
  return isNode6 ? Buffer.from(str) : new Buffer(str)
}




