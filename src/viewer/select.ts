import { DEFAULT_RGB, type Mesh } from '../kernel/off'
import { partLabels } from '../kernel/stats'
import type { Vec3 } from './camera'

/** A part the user clicked (design.md §8): which one, where it is, and its triangles for the highlight. */
export interface Selection {
  /** 1-based, in order of first appearance — top-level statement order under the lazy union. */
  part: number
  of: number
  min: Vec3
  max: Vec3
  /** The part's `color()`, or null when it has none — the default yellow is not a colour the model wrote. */
  rgb: [number, number, number] | null
  triangles: Uint32Array
}

export function selectPart(mesh: Mesh, triangle: number): Selection {
  const { labels, count } = partLabels(mesh)
  const label = labels[triangle]!
  const { positions: p, indices } = mesh
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const picked: number[] = []
  for (let t = 0; t < labels.length; t++) {
    if (labels[t] !== label) continue
    picked.push(t)
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k]! * 3
      for (let axis = 0; axis < 3; axis++) {
        const value = p[v + axis]!
        if (value < min[axis]!) min[axis] = value
        if (value > max[axis]!) max[axis] = value
      }
    }
  }
  const c = mesh.colors
  const rgb: Selection['rgb'] = c ? [c[triangle * 3]!, c[triangle * 3 + 1]!, c[triangle * 3 + 2]!] : null
  return {
    part: label + 1,
    of: count,
    min,
    max,
    rgb: rgb && rgb.some((v, i) => v !== DEFAULT_RGB[i]) ? rgb : null,
    triangles: Uint32Array.from(picked),
  }
}

const num = (n: number): string => String(Math.round(n * 10) / 10)
const vec = (v: Vec3): string => `[${v.map(num).join(', ')}]`
const hex = (rgb: [number, number, number]): string =>
  `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`

/** The line a message starts with when a part is selected — the wire format the system prompt describes. */
export function referenceLine(s: Selection): string {
  const size = s.max.map((hi, i) => num(hi - s.min[i]!)).join(' × ')
  const colour = s.rgb ? `, colour ${hex(s.rgb)}` : ''
  return `[Selected part ${s.part} of ${s.of}: ${size} mm, from ${vec(s.min)} to ${vec(s.max)}${colour}]`
}
