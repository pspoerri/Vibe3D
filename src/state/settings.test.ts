import { expect, test } from 'vitest'
import { DEFAULT_BED, parseBed } from './settings'

test('a bed is one to three sizes in any of the usual spellings, and nonsense is refused', () => {
  expect(parseBed('220 x 220 x 250')).toEqual([220, 220, 250])
  expect(parseBed('256×256')).toEqual([256, 256, 256])
  expect(parseBed('180')).toEqual([180, 180, 180])
  expect(parseBed('')).toBe(null)
  expect(parseBed('big')).toBe(null)
  expect(parseBed('1 2 3 4')).toBe(null)
  expect(parseBed('0 x 10')).toBe(null)
  expect(DEFAULT_BED).toEqual([256, 256, 256])
})
