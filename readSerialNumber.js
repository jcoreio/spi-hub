
const assert = require('assert')
const wpi = require('wiring-pi')

const EEPROM_I2C_ADDR = 0x50

const SERIAL_NUMBER_LEN = 6
const ACCESS_CODE_LEN = 8

const SERIAL_NUMBER_PREAMBLE = 0xA9
const ACCESS_CODE_PREAMBLE = 0x7C

// Leave some extra space in case we ever want to store larger device IDs
const ACCESS_CODE_OFFSET = 32

const pause = () => new Promise(resolve => setTimeout(resolve, 10))

async function readSerialNumberAndAccessCode () {
  const fd = wpi.wiringPiI2CSetup(EEPROM_I2C_ADDR)

  async function readByte (pos) {
    await pause()
    return wpi.wiringPiI2CReadReg8(fd, pos)
  }

  let pos = 0
  const serialNumberPreamble = await readByte(pos++)
  const serialNumberLen = await readByte(pos++)

  const serialNumberCharCodes = []
  for (let strPos = 0; strPos < SERIAL_NUMBER_LEN; ++strPos) {
    serialNumberCharCodes[strPos] = await readByte(pos++)
  }
  const serialNumber = String.fromCharCode(...serialNumberCharCodes)

  pos = ACCESS_CODE_OFFSET
  const accessCodePreamble = await readByte(pos++)
  const accessCodeLength = await readByte(pos++)

  const accessCodeCharCodes = []
  for (let strPos = 0; strPos < ACCESS_CODE_LEN; ++strPos) {
    accessCodeCharCodes[strPos] = await readByte(pos++)
  }
  const accessCode = String.fromCharCode(...accessCodeCharCodes)

  assert.strictEqual(serialNumberPreamble, SERIAL_NUMBER_PREAMBLE, 'Serial Number preamble did not match')
  assert.strictEqual(serialNumberLen, SERIAL_NUMBER_LEN, 'Serial Number length did not match')

  assert.strictEqual(accessCodePreamble, ACCESS_CODE_PREAMBLE, 'Access code preamble did not match')
  assert.strictEqual(accessCodeLength, ACCESS_CODE_LEN, 'Access code length did not match')

  console.log(`Serial Number: ${serialNumber} Access Code: ${accessCode}`)
  return { serialNumber, accessCode }
}

module.exports = { readSerialNumberAndAccessCode }
