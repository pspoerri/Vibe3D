import { expect, test } from 'vitest'
import {
  chooseGridSpacing, fitDistance, FIT_PADDING, GRID_LEVELS_MM, MIN_FIT_MM,
  VIEW_DIRECTIONS, viewUp, worldPerPixel,
} from './camera'

test('grid spacing coarsens as the view widens', () => {
  // 60-cell target: 60 mm across wants 1 mm cells, 6 m across wants 100 mm.
  expect(chooseGridSpacing(60)).toBe(1)
  expect(chooseGridSpacing(600)).toBe(10)
  expect(chooseGridSpacing(6000)).toBe(100)
})

test('grid spacing clamps at both ends instead of returning undefined', () => {
  expect(chooseGridSpacing(0.001)).toBe(GRID_LEVELS_MM[0])
  expect(chooseGridSpacing(1e12)).toBe(GRID_LEVELS_MM[GRID_LEVELS_MM.length - 1])
  // A zero-height viewport mid-layout must not produce NaN.
  expect(chooseGridSpacing(0)).toBe(10)
  expect(chooseGridSpacing(NaN)).toBe(10)
})

test('world-per-pixel scales with distance and inverts with viewport height', () => {
  const near = worldPerPixel(50, 100, 800)
  expect(worldPerPixel(50, 200, 800)).toBeCloseTo(near * 2)
  expect(worldPerPixel(50, 100, 1600)).toBeCloseTo(near / 2)
  // A 90-degree fov spans exactly 2x distance vertically.
  expect(worldPerPixel(90, 50, 100) * 100).toBeCloseTo(100)
})

test('fit distance frames the largest dimension, whichever axis it is on', () => {
  // At 90 degrees the visible height equals the distance, so a padded 100 mm
  // part must sit at 100 * 1.25 / 2 = 62.5 mm.
  const expected = (100 * FIT_PADDING) / 2
  expect(fitDistance([100, 10, 10], 90, 1)).toBeCloseTo(expected)
  expect(fitDistance([10, 100, 10], 90, 1)).toBeCloseTo(expected)
  expect(fitDistance([10, 10, 100], 90, 1)).toBeCloseTo(expected)
})

test('fit distance clamps tiny parts so the camera never lands inside them', () => {
  expect(fitDistance([0.1, 0.1, 0.1], 90, 1)).toBeCloseTo((MIN_FIT_MM * FIT_PADDING) / 2)
})

test('a viewport taller than wide backs the camera off further', () => {
  const wide = fitDistance([100, 100, 100], 50, 2)
  expect(fitDistance([100, 100, 100], 50, 0.5)).toBeCloseTo(wide * 2)
  // Aspect >= 1 is already covered by the vertical fov, so it must not shrink.
  expect(fitDistance([100, 100, 100], 50, 4)).toBeCloseTo(wide)
})

test('no standard view puts the up vector parallel to the view direction', () => {
  for (const name of Object.keys(VIEW_DIRECTIONS) as Array<keyof typeof VIEW_DIRECTIONS>) {
    const dir = VIEW_DIRECTIONS[name]
    const up = viewUp(name)
    const dot = dir[0] * up[0] + dir[1] * up[1] + dir[2] * up[2]
    const lengths = Math.hypot(...dir) * Math.hypot(...up)
    // Parallel up and view direction degenerate lookAt; top/bottom is exactly
    // the case that catches it.
    expect(Math.abs(dot / lengths)).toBeLessThan(0.99)
  }
})
