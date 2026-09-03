/**
 * One part out of a document: the triangles of solid N (partLabels' numbering,
 * which is the viewport's), as a mesh for the STL and OBJ writers; and the
 * kernel's 3MF cut down to its Nth object, which is the Nth top-level
 * statement under the lazy union.
 * ponytail: a statement that yields two disconnected solids makes the 3MF's
 * object N and the viewport's part N disagree; the mesh path is always right.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import type { Mesh } from '../kernel/off'
import { partLabels } from '../kernel/stats'

/** The triangles of part `n` (1-based), re-indexed to their own vertices. */
export function partMesh(mesh: Mesh, n: number): Mesh {
  const { labels } = partLabels(mesh)
  const remap = new Map<number, number>()
  const positions: number[] = []
  const indices: number[] = []
  const colors: number[] = []
  for (let t = 0; t < labels.length; t++) {
    if (labels[t] !== n - 1) continue
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]!
      let next = remap.get(v)
      if (next === undefined) {
        next = remap.size
        remap.set(v, next)
        positions.push(mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!)
      }
      indices.push(next)
    }
    if (mesh.colors) colors.push(mesh.colors[t * 3]!, mesh.colors[t * 3 + 1]!, mesh.colors[t * 3 + 2]!)
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    vertexCount: remap.size,
    triangleCount: indices.length / 3,
    ...(mesh.colors ? { colors: Uint8Array.from(colors) } : {}),
  }
}

const MODEL = '3D/3dmodel.model'

/** The model XML with every `<object>` but the Nth removed, and the `<build>` down to that one item. */
export function partModel(xml: string, n: number): string {
  const objects = [...xml.matchAll(/<object [^>]*>[\s\S]*?<\/object>/g)]
  const keep = objects[n - 1]
  if (!keep) return xml
  const id = /\bid="([^"]*)"/.exec(keep[0])?.[1]
  let out = ''
  let last = 0
  for (const m of objects) {
    out += xml.slice(last, m.index)
    if (m === keep) out += m[0]
    last = m.index + m[0].length
  }
  out += xml.slice(last)
  return out.replace(/<item [^>]*\/>/g, (item) => (id !== undefined && attr(item, 'objectid') === id ? item : ''))
}

const attr = (tag: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null

/** The kernel's 3MF with only part `n` in it; the bytes unchanged when there is no such object. */
export function part3mf(bytes: Uint8Array, n: number): Uint8Array {
  const files = unzipSync(bytes)
  const model = files[MODEL]
  if (!model) return bytes
  const xml = strFromU8(model)
  const cut = partModel(xml, n)
  return cut === xml ? bytes : zipSync({ ...files, [MODEL]: strToU8(cut) })
}
