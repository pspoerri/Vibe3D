import type { Mesh } from './off'

export interface MeshStats {
  triangles: number
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
  /** mm³. null when the mesh is not watertight, because the figure would be meaningless. */
  volume: number | null
  watertight: boolean
}

/**
 * A mesh is watertight when every undirected edge is shared by exactly two
 * triangles. OpenSCAD's OFF output is already indexed and welded, so comparing
 * index pairs is sufficient — no vertex merging step is needed.
 */
function isWatertight(indices: Uint32Array): boolean {
  if (indices.length === 0) return false
  const seen = new Map<string, number>()
  for (let i = 0; i < indices.length; i += 3) {
    const t = [indices[i]!, indices[i + 1]!, indices[i + 2]!]
    for (let e = 0; e < 3; e++) {
      const a = t[e]!
      const b = t[(e + 1) % 3]!
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
  }
  for (const count of seen.values()) if (count !== 2) return false
  return true
}

/** Signed sum of tetrahedra from the origin. Only meaningful for a closed mesh. */
function signedVolume(mesh: Mesh): number {
  const { positions: p, indices } = mesh
  let total = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3
    const b = indices[i + 1]! * 3
    const c = indices[i + 2]! * 3
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!
    total +=
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx)
  }
  return total / 6
}

export function meshStats(mesh: Mesh): MeshStats {
  const { positions, indices } = mesh
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]!
      if (value < min[axis]!) min[axis] = value
      if (value > max[axis]!) max[axis] = value
    }
  }
  if (positions.length === 0) {
    min[0] = min[1] = min[2] = 0
    max[0] = max[1] = max[2] = 0
  }

  const watertight = isWatertight(indices)
  return {
    triangles: indices.length / 3,
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    volume: watertight ? Math.abs(signedVolume(mesh)) : null,
    watertight,
  }
}
