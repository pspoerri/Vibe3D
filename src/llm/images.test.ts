import { expect, test } from 'vitest'
import { fit, MAX_EDGE } from './images'

test('an image already inside the cap is left alone', () => {
  expect(fit(800, 600)).toEqual([800, 600])
  expect(fit(MAX_EDGE, MAX_EDGE)).toEqual([MAX_EDGE, MAX_EDGE])
})

test('the longest edge is what meets the cap, in either orientation', () => {
  expect(fit(3000, 1500)).toEqual([MAX_EDGE, 784])
  expect(fit(1500, 3000)).toEqual([784, MAX_EDGE])
})

test('a square scales to the cap on both edges', () => {
  expect(fit(4000, 4000)).toEqual([MAX_EDGE, MAX_EDGE])
})

// A zero dimension is not decodable, but the arithmetic must not answer NaN and
// hand a NaN width to canvas, which throws far away from the cause.
test('a degenerate dimension yields a usable pair, never NaN', () => {
  const [w, h] = fit(0, 0)
  expect(Number.isFinite(w) && Number.isFinite(h)).toBe(true)
})
