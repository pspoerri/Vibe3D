/**
 * Binary STL from the viewport's mesh, with each facet's colour in the
 * attribute word the way VisCAM and SolidView defined it: bit 15 set, then
 * five bits each of red (10–14), green (5–9) and blue (0–4). STL has no
 * standard for colour; this is the convention MeshLab and most viewers read,
 * and slicers ignore the word entirely, so an uncoloured reader sees a
 * plain STL. 3MF is the export that carries colour as materials.
 */
import type { Mesh } from '../kernel/off'

const HEADER = 'Vibe3D binary STL; facet colour: VisCAM/SolidView, bit 15 valid, 5-bit RGB'

const to5 = (byte: number): number => Math.round((byte / 255) * 31)

/** The attribute word for one rgb triple. */
export const facetColour = ([r, g, b]: readonly [number, number, number]): number =>
  0x8000 | (to5(r) << 10) | (to5(g) << 5) | to5(b)

export function encodeStl(mesh: Mesh): Uint8Array {
  const { positions: p, indices, triangleCount, colors } = mesh
  const out = new ArrayBuffer(84 + triangleCount * 50)
  const view = new DataView(out)
  new Uint8Array(out, 0, 80).set(new TextEncoder().encode(HEADER).subarray(0, 80))
  view.setUint32(80, triangleCount, true)
  let at = 84
  for (let t = 0; t < triangleCount; t++) {
    const a = indices[t * 3]! * 3
    const b = indices[t * 3 + 1]! * 3
    const c = indices[t * 3 + 2]! * 3
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len; ny /= len; nz /= len
    for (const value of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
      view.setFloat32(at, value!, true)
      at += 4
    }
    view.setUint16(at, colors ? facetColour([colors[t * 3]!, colors[t * 3 + 1]!, colors[t * 3 + 2]!]) : 0, true)
    at += 2
  }
  return new Uint8Array(out)
}
