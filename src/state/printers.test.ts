import { expect, test } from 'vitest'
import { fitsBed, printerOf } from './printers'

test('a part fits turned a quarter on the plate, never on its side', () => {
  const mk4 = [250, 210, 220]
  expect(fitsBed([240, 100, 10], mk4)).toBe(true)
  expect(fitsBed([100, 240, 10], mk4)).toBe(true) // turned
  expect(fitsBed([240, 240, 10], mk4)).toBe(false)
  expect(fitsBed([10, 10, 230], mk4)).toBe(false) // too tall, whichever way it turns on the plate
  expect(printerOf(mk4)).toBe('Prusa MK4')
  expect(printerOf([1, 2, 3])).toBeNull()
})
