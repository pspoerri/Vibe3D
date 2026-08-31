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
export const hex = (rgb: readonly [number, number, number]): string =>
  `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`

/** Each solid's colour, from its first face, in part order — null where the model gave it none. */
export function partColours(mesh: Mesh): ([number, number, number] | null)[] {
  const { labels, count } = partLabels(mesh)
  const out: ([number, number, number] | null)[] = new Array(count).fill(null)
  const c = mesh.colors
  if (!c) return out
  const seen = new Uint8Array(count)
  for (let t = 0; t < labels.length; t++) {
    const k = labels[t]!
    if (seen[k]) continue
    seen[k] = 1
    const rgb: [number, number, number] = [c[t * 3]!, c[t * 3 + 1]!, c[t * 3 + 2]!]
    out[k] = rgb.some((v, i) => v !== DEFAULT_RGB[i]) ? rgb : null
  }
  return out
}

/** One colour of a part and how much of its surface it covers. */
export interface ColourShare {
  rgb: [number, number, number]
  /** Fraction of the part's surface area, 0..1. */
  share: number
}

const triangleArea = (p: Float32Array, a: number, b: number, c: number): number => {
  const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
  const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
}

/**
 * Every colour on each solid, by surface area, largest first, in part order —
 * uncoloured faces excluded. What tells lettering from its base plate.
 */
export function partColourShares(mesh: Mesh): ColourShare[][] {
  const { labels, count } = partLabels(mesh)
  const c = mesh.colors
  if (!c) return Array.from({ length: count }, () => [])
  const areas: Map<string, { rgb: [number, number, number]; area: number }>[] = Array.from({ length: count }, () => new Map())
  const totals = new Float64Array(count)
  const { positions: p, indices } = mesh
  for (let t = 0; t < labels.length; t++) {
    const k = labels[t]!
    const area = triangleArea(p, indices[t * 3]! * 3, indices[t * 3 + 1]! * 3, indices[t * 3 + 2]! * 3)
    totals[k] = totals[k]! + area
    const rgb: [number, number, number] = [c[t * 3]!, c[t * 3 + 1]!, c[t * 3 + 2]!]
    if (!rgb.some((v, i) => v !== DEFAULT_RGB[i])) continue
    const key = rgb.join(',')
    const entry = areas[k]!.get(key) ?? { rgb, area: 0 }
    entry.area += area
    areas[k]!.set(key, entry)
  }
  return areas.map((byColour, k) =>
    [...byColour.values()]
      .sort((a, b) => b.area - a.area)
      .map(({ rgb, area }) => ({ rgb, share: totals[k]! > 0 ? area / totals[k]! : 0 })),
  )
}

/** "saddlebrown (#8b4513) 82%, gold (#ffd700) 18%", or "no colour". */
export const describeColours = (shares: readonly ColourShare[]): string =>
  shares.length === 0
    ? 'no colour'
    : shares.map((s) => `${colourName(s.rgb)} (${hex(s.rgb)}) ${Math.round(s.share * 100)}%`).join(', ')

// ponytail: the CSS basics, nearest by RGB distance — enough to say "the red part".
const NAMED: readonly [string, readonly [number, number, number]][] = [
  ['black', [0, 0, 0]], ['white', [255, 255, 255]], ['grey', [128, 128, 128]], ['silver', [192, 192, 192]],
  ['red', [255, 0, 0]], ['orange', [255, 165, 0]], ['yellow', [255, 255, 0]], ['lime', [0, 255, 0]],
  ['green', [0, 128, 0]], ['teal', [0, 128, 128]], ['cyan', [0, 255, 255]], ['blue', [0, 0, 255]],
  ['navy', [0, 0, 128]], ['purple', [128, 0, 128]], ['magenta', [255, 0, 255]], ['pink', [255, 192, 203]],
  ['brown', [165, 42, 42]], ['maroon', [128, 0, 0]], ['olive', [128, 128, 0]],
  ['gold', [255, 215, 0]], ['saddlebrown', [139, 69, 19]], ['tan', [210, 180, 140]], ['ivory', [255, 255, 240]],
  ['forestgreen', [34, 139, 34]], ['darkblue', [0, 0, 139]], ['crimson', [220, 20, 60]], ['skyblue', [135, 206, 235]],
]

/** The nearest common colour name, so a part can be spoken of by colour. */
export function colourName(rgb: readonly [number, number, number]): string {
  let best = NAMED[0]!
  let bestD = Infinity
  for (const entry of NAMED) {
    const d = entry[1].reduce((sum, v, i) => sum + (v - rgb[i]!) ** 2, 0)
    if (d < bestD) {
      bestD = d
      best = entry
    }
  }
  return best[0]
}

/** The line a message starts with when a part is selected — the wire format the system prompt describes. */
export function referenceLine(s: Selection): string {
  const size = s.max.map((hi, i) => num(hi - s.min[i]!)).join(' × ')
  const colour = s.rgb ? `, colour ${hex(s.rgb)}` : ''
  return `[Selected part ${s.part} of ${s.of}: ${size} mm, from ${vec(s.min)} to ${vec(s.max)}${colour}]`
}
