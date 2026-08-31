import type { Mesh } from './off'

export interface MeshStats {
  triangles: number
  min: [number, number, number]
  max: [number, number, number]
  size: [number, number, number]
  /** mm³. null when the mesh is not watertight, because the figure would be meaningless. */
  volume: number | null
  watertight: boolean
  /** Connected components, by shared vertex — "how many solids". */
  parts: number
  /**
   * Total genus across parts, from Euler's formula on a closed surface. null
   * when not watertight, because the formula needs one.
   */
  genus: number | null
}

/**
 * Distinct undirected edges, and whether every one of them is shared by
 * exactly two triangles. OpenSCAD's OFF output is already indexed and welded,
 * so comparing index pairs is sufficient — no vertex merging step is needed.
 */
function edgeCensus(indices: Uint32Array): { edges: number; watertight: boolean } {
  if (indices.length === 0) return { edges: 0, watertight: false }
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
  let watertight = true
  for (const count of seen.values()) if (count !== 2) watertight = false
  return { edges: seen.size, watertight }
}

/** Connected components over the vertices a face touches. Union-find, path-compressed. */
function partCensus(indices: Uint32Array, vertexCount: number): { parts: number; used: number } {
  const parent = new Uint32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) parent[i] = i
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]!
    while (parent[i] !== root) {
      const next = parent[i]!
      parent[i] = root
      i = next
    }
    return root
  }
  for (let i = 0; i < indices.length; i += 3) {
    const a = find(indices[i]!)
    parent[find(indices[i + 1]!)] = a
    parent[find(indices[i + 2]!)] = a
  }
  const roots = new Set<number>()
  const used = new Set<number>()
  for (let i = 0; i < indices.length; i++) {
    used.add(indices[i]!)
    roots.add(find(indices[i]!))
  }
  return { parts: roots.size, used: used.size }
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

  const { edges, watertight } = edgeCensus(indices)
  const { parts, used } = partCensus(indices, mesh.vertexCount)
  const faces = indices.length / 3
  return {
    triangles: faces,
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    volume: watertight ? Math.abs(signedVolume(mesh)) : null,
    watertight,
    parts,
    // χ = V − E + F = 2·parts − 2·genus for a closed surface.
    genus: watertight ? (2 * parts - (used - edges + faces)) / 2 : null,
  }
}
