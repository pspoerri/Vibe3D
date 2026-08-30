/**
 * Pure viewport camera maths. Deliberately free of any three.js import so it
 * stays testable in the node-environment Vitest suite.
 *
 * World convention: millimetres, +Z up (design.md §6 — "world up is +Z,
 * always"). Model space and world space are therefore the same space.
 */

export type StandardView = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'iso'

export type Vec3 = readonly [number, number, number]

/** Direction from the orbit target towards the camera, per standard view. */
export const VIEW_DIRECTIONS: Record<StandardView, Vec3> = {
  top: [0, 0, 1],
  bottom: [0, 0, -1],
  front: [0, -1, 0],
  back: [0, 1, 0],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  iso: [1, -1, 1],
}

/** Looking straight down +Z, world up is parallel to the view — pick +Y instead. */
export function viewUp(view: StandardView): Vec3 {
  return view === 'top' || view === 'bottom' ? [0, 1, 0] : [0, 0, 1]
}

/**
 * Grid spacings in mm, 0.1 mm detail up to a 1 m scene. 1-2-5 steps rather
 * than decades: with decades alone a 75 mm-wide view rounds up to a 10 mm grid
 * and draws ~7 cells instead of the 60 asked for, which reads as no grid at all.
 */
export const GRID_LEVELS_MM = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000,
] as const

const CELLS_TARGET = 60

/**
 * Coarsest spacing that still draws no more than ~CELLS_TARGET cells across
 * the visible width, so the grid stays legible at every zoom instead of
 * turning into a grey wash when you pull back.
 */
export function chooseGridSpacing(visibleWidthMm: number): number {
  if (!Number.isFinite(visibleWidthMm) || visibleWidthMm <= 0) return 10
  const target = visibleWidthMm / CELLS_TARGET
  return GRID_LEVELS_MM.find((level) => level >= target) ?? GRID_LEVELS_MM[GRID_LEVELS_MM.length - 1]!
}

/** World mm spanned by one screen pixel at `distance` from a perspective camera. */
export function worldPerPixel(fovDeg: number, distance: number, viewportHeightPx: number): number {
  const fov = (fovDeg * Math.PI) / 180
  return (2 * Math.max(distance, 1e-6) * Math.tan(fov / 2)) / Math.max(1, viewportHeightPx)
}

/** Below this the camera would end up inside a tiny part. */
export const MIN_FIT_MM = 20
export const FIT_PADDING = 1.25

/**
 * Distance at which a part of the given size fills the frame with padding.
 *
 * `fov` is vertical, so a viewport taller than it is wide is constrained
 * horizontally instead — dividing by the aspect backs the camera off enough
 * to cover that case.
 */
export function fitDistance(size: Vec3, fovDeg: number, aspect: number): number {
  const extent = Math.max(size[0], size[1], size[2], MIN_FIT_MM) * FIT_PADDING
  const fov = (fovDeg * Math.PI) / 180
  return extent / (2 * Math.tan(fov / 2)) / Math.min(1, aspect || 1)
}
