
const assert = require('assert')
const wpi = require('wiring-pi')

const EEPROM_I2C_ADDR = 0x50

const DEVICE_ID_LENGTH = 6
const ACCESS_CODE_LENGTH = 8

const DEVICE_ID_PREAMBLE = 0xA9
const ACCESS_CODE_PREAMBLE = 0x7C

// Leave some extra space in case we ever want to store larger device IDs
const ACCESS_CODE_OFFSET = 32

const pause = () => new Promise(resolve => setTimeout(resolve, 10))

async function readDeviceIdAndAccessCode() {

  const fd = wpi.wiringPiI2CSetup(EEPROM_I2C_ADDR)

  async function readByte(pos) {
    await pause()
    return wpi.wiringPiI2CReadReg8(fd, pos)
  }

  let pos = 0
  const deviceIdPreamble = await readByte(pos++)
  const deviceIdLength = await readByte(pos++)

  const deviceIdCharCodes = []
  for(let strPos = 0; strPos < DEVICE_ID_LENGTH; ++strPos) {
    deviceIdCharCodes[strPos] = await readByte(pos++)
  }
  const deviceId = String.fromCharCode(...deviceIdCharCodes)

  pos = ACCESS_CODE_OFFSET
  const accessCodePreamble = await readByte(pos++)
  const accessCodeLength = await readByte(pos++)

  const accessCodeCharCodes = []
  for(let strPos = 0; strPos < ACCESS_CODE_LENGTH; ++strPos) {
    accessCodeCharCodes[strPos] = await readByte(pos++)
  }
  const accessCode = String.fromCharCode(...accessCodeCharCodes)

  assert.equal(deviceIdPreamble, DEVICE_ID_PREAMBLE, 'Device ID preamble did not match')
  assert.equal(deviceIdLength, DEVICE_ID_LENGTH, 'Device ID length did not match')

  assert.equal(accessCodePreamble, ACCESS_CODE_PREAMBLE, 'Access code preamble did not match')
  assert.equal(accessCodeLength, ACCESS_CODE_LENGTH, 'Access code length did not match')

  console.log(`Device ID: ${deviceId} Access Code: ${accessCode}`)
  return {deviceId, accessCode}
}

module.exports = {readDeviceIdAndAccessCode}
