/**
 * Wavefront OBJ from the viewport's mesh, with colour the way OBJ carries it:
 * a material per colour in a sidecar MTL, faces grouped under `usemtl`. That
 * is what PrusaSlicer and Bambu Studio import as multi-material painting.
 * Each solid is an `o` group, so parts stay parts in the slicer. An
 * uncoloured mesh is a plain OBJ with no MTL at all.
 */
import { DEFAULT_RGB, type Mesh } from '../kernel/off'
import { partLabels } from '../kernel/stats'

type Rgb = readonly [number, number, number]

const hex = (rgb: Rgb): string => rgb.map((v) => v.toString(16).padStart(2, '0')).join('')
const kd = (rgb: Rgb): string => rgb.map((v) => (v / 255).toFixed(3)).join(' ')

export function encodeObj(mesh: Mesh, name: string): { obj: Uint8Array; mtl: Uint8Array | null } {
  const { positions: p, indices, triangleCount, colors } = mesh
  const { labels } = partLabels(mesh)
  const rgbOf = (t: number): Rgb => [colors![t * 3]!, colors![t * 3 + 1]!, colors![t * 3 + 2]!]
  const isDefault = (rgb: Rgb): boolean => rgb.every((v, i) => v === DEFAULT_RGB[i])
  const materialOf = (t: number): string => (isDefault(rgbOf(t)) ? 'default' : `c_${hex(rgbOf(t))}`)
  let coloured = false
  if (colors) for (let t = 0; t < triangleCount && !coloured; t++) coloured = !isDefault(rgbOf(t))

  const lines = [`# Vibe3D OBJ export${coloured ? ', a material per colour' : ''}`]
  if (coloured) lines.push(`mtllib ${name}.mtl`)
  for (let v = 0; v < mesh.vertexCount; v++) lines.push(`v ${p[v * 3]} ${p[v * 3 + 1]} ${p[v * 3 + 2]}`)

  // Faces by part, then by material, so each group is stated once.
  const order = Array.from({ length: triangleCount }, (_, t) => t)
  if (coloured) order.sort((a, b) => labels[a]! - labels[b]! || materialOf(a).localeCompare(materialOf(b)))
  else order.sort((a, b) => labels[a]! - labels[b]!)
  const materials = new Map<string, Rgb>()
  let part = -1
  let material = ''
  for (const t of order) {
    if (labels[t] !== part) {
      part = labels[t]!
      material = ''
      lines.push(`o part_${part + 1}`)
    }
    if (coloured) {
      const key = materialOf(t)
      if (key !== material) {
        material = key
        materials.set(key, key === 'default' ? DEFAULT_RGB : rgbOf(t))
        lines.push(`usemtl ${key}`)
      }
    }
    lines.push(`f ${indices[t * 3]! + 1} ${indices[t * 3 + 1]! + 1} ${indices[t * 3 + 2]! + 1}`)
  }
  lines.push('')
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
  const mtl = coloured
    ? encode(
        [`# Vibe3D materials for ${name}.obj`, ...[...materials].map(([key, rgb]) => `newmtl ${key}\nKd ${kd(rgb)}`), ''].join('\n'),
      )
    : null
  return { obj: encode(lines.join('\n')), mtl }
}
