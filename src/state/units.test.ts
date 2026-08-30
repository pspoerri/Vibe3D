import { expect, test } from 'vitest'
import { formatLength, formatVolume, lengthLabel, volumeLabel } from './units'

test('millimetres are reported as authored', () => {
  expect(formatLength(60, 'mm')).toBe('60.0')
  expect(formatLength(3, 'mm')).toBe('3.0')
  expect(lengthLabel('mm')).toBe('mm')
})

test('inches convert at exactly 25.4 mm', () => {
  expect(formatLength(25.4, 'in')).toBe('1.000')
  expect(formatLength(60, 'in')).toBe('2.362')
  // A 0.4 mm nozzle wall has to stay visible, which two decimals would round
  // away to 0.02 in.
  expect(formatLength(0.4, 'in')).toBe('0.016')
  expect(lengthLabel('in')).toBe('in')
})

test('volume converts through the cube of the length factor', () => {
  expect(formatVolume(6960, 'mm')).toBe('6.96')
  // One cubic inch is 25.4^3 = 16387.064 mm3.
  expect(formatVolume(16387.064, 'in')).toBe('1.000')
  expect(volumeLabel('mm')).toBe('cm³')
  expect(volumeLabel('in')).toBe('in³')
})

test('a round trip through inches and back is the original millimetre figure', () => {
  for (const mm of [0.4, 3, 12.7, 60, 255.9]) {
    const inches = Number(formatLength(mm, 'in'))
    expect(inches * 25.4).toBeCloseTo(mm, 1)
  }
})
