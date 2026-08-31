/**
 * The kernel's 3MF carries colour the standard way — <basematerials>, a
 * material index per triangle — and Bambu Studio ignores that. What it and
 * PrusaSlicer show is *painting*: an attribute per triangle naming a
 * filament slot. This rewrites the kernel's file with that attribute in both
 * dialects, the colour regions ranked by surface area so the base is
 * filament 1, the lettering 2, and so on. The materials stay for everything
 * else that reads them. A file with fewer than two colours is returned as is.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'three/examples/jsm/libs/fflate.module.js'

const MODEL = '3D/3dmodel.model'
const PRUSA_NS = 'xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06"'
/** Sixteen slots is where both slicers stop. */
const MAX_SLOTS = 16

/**
 * PrusaSlicer's TriangleSelector serialisation of one unsplit triangle in
 * state n (filament n): 4 bits per digit, split info 00 then the state; a
 * state of 3 or more is "11" plus four bits of n − 3 in a second digit,
 * which is written first. Filament 1 is "4", 2 is "8", 3 is "0C", 4 "1C".
 */
export const paintCode = (slot: number): string =>
  slot < 3 ? (slot << 2).toString(16).toUpperCase() : `${(slot - 3).toString(16).toUpperCase()}C`

const attr = (tag: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null

/** The per-triangle painting the kernel's model XML implies, added; or the XML unchanged. */
export function paintModel(xml: string): string {
  // Material index → its triangles' total area, summed over every object.
  const area = new Map<number, number>()
  const objects = [...xml.matchAll(/<object [^>]*>[\s\S]*?<\/object>/g)].map((m) => m[0])
  const perObject = objects.map((object) => {
    const head = /<object [^>]*>/.exec(object)![0]
    const fallback = Number(attr(head, 'pindex') ?? -1)
    const vertices = [...object.matchAll(/<vertex x="([^"]*)" y="([^"]*)" z="([^"]*)"/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
    ])
    const triangles = [...object.matchAll(/<triangle [^>]*\/>/g)].map((m) => {
      const tag = m[0]
      const index = Number(attr(tag, 'p1') ?? fallback)
      const [a, b, c] = ['v1', 'v2', 'v3'].map((v) => vertices[Number(attr(tag, v))] ?? [0, 0, 0])
      const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!]
      const w = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!]
      const size = Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2
      area.set(index, (area.get(index) ?? 0) + size)
      return { tag, index }
    })
    return { object, triangles }
  })
  const ranked = [...area.entries()].sort((a, b) => b[1] - a[1]).map(([index]) => index)
  if (ranked.length < 2) return xml
  const slot = new Map(ranked.slice(0, MAX_SLOTS).map((index, i) => [index, i + 1]))

  let out = xml
  for (const { object, triangles } of perObject) {
    let painted = object
    for (const { tag, index } of triangles) {
      const n = slot.get(index)
      if (n === undefined) continue
      const code = paintCode(n)
      painted = painted.replace(tag, tag.replace(/\s*\/>$/, ` paint_color="${code}" slic3rpe:mmu_segmentation="${code}" />`))
    }
    out = out.replace(object, painted)
  }
  if (!out.includes('xmlns:slic3rpe=')) out = out.replace(/<model /, `<model ${PRUSA_NS} `)
  return out
}

/** The kernel's 3MF bytes with painting added to its model, re-zipped; or the bytes as they came. */
export function paint3mf(bytes: Uint8Array): Uint8Array {
  const files = unzipSync(bytes)
  const model = files[MODEL]
  if (!model) return bytes
  const xml = strFromU8(model)
  const painted = paintModel(xml)
  if (painted === xml) return bytes
  return zipSync({ ...files, [MODEL]: strToU8(painted) })
}
