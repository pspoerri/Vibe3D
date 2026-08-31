import type { Mesh } from './off'

type Vec3 = [number, number, number]

/** One closed shell of the mesh. */
export interface ShellStats {
  min: Vec3
  max: Vec3
  size: Vec3
  /** mm³, unsigned. Meaningless when the mesh is not watertight. */
  volume: number
  triangles: number
}

export interface MeshStats {
  triangles: number
  min: Vec3
  max: Vec3
  size: Vec3
  /** mm³. null when the mesh is not watertight, because the figure would be meaningless. */
  volume: number | null
  watertight: boolean
  /** Solid shells — "how many solids". `shells.length`. */
  parts: number
  /**
   * The solids, in order of first appearance — top-level statement order
   * under the lazy union, so PART N is `shells[N-1]`.
   */
  shells: ShellStats[]
  /**
   * Closed cavities: shells whose faces point inward, so they enclose air
   * inside a solid. A pocket that never reached the surface. Only detectable
   * on a watertight mesh; otherwise empty.
   */
  voids: ShellStats[]
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
function partCensus(
  indices: Uint32Array,
  vertexCount: number,
): { used: number; find: (vertex: number) => number } {
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
  const used = new Set<number>()
  for (let i = 0; i < indices.length; i++) used.add(indices[i]!)
  return { used: used.size, find }
}

interface Component {
  min: Vec3
  max: Vec3
  /** Six times the signed sum of tetrahedra from the origin: negative means the faces point inward. */
  signed: number
  triangles: number
}

/**
 * Every connected component in order of first appearance, which triangle
 * belongs to which, and whether the surface is closed. One pass for the
 * stats and for the click-to-select labels, so they cannot disagree.
 */
function census(mesh: Mesh): {
  components: Component[]
  of: Uint32Array
  used: number
  edges: number
  watertight: boolean
} {
  const { positions: p, indices } = mesh
  const { find, used } = partCensus(indices, mesh.vertexCount)
  const numbered = new Map<number, number>()
  const components: Component[] = []
  const of = new Uint32Array(indices.length / 3)
  for (let t = 0; t < of.length; t++) {
    const root = find(indices[t * 3]!)
    let k = numbered.get(root)
    if (k === undefined) {
      k = components.length
      numbered.set(root, k)
      components.push({
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
        signed: 0,
        triangles: 0,
      })
    }
    of[t] = k
    const c = components[k]!
    c.triangles++
    const a = indices[t * 3]! * 3
    const b = indices[t * 3 + 1]! * 3
    const d = indices[t * 3 + 2]! * 3
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!
    const cx = p[d]!, cy = p[d + 1]!, cz = p[d + 2]!
    c.signed += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
    for (const v of [a, b, d]) {
      for (let axis = 0; axis < 3; axis++) {
        const value = p[v + axis]!
        if (value < c.min[axis]!) c.min[axis] = value
        if (value > c.max[axis]!) c.max[axis] = value
      }
    }
  }
  return { components, of, used, ...edgeCensus(indices) }
}

const isVoid = (c: Component, watertight: boolean): boolean => watertight && c.signed < 0

const contains = (outer: Component, inner: Component): boolean =>
  [0, 1, 2].every((i) => outer.min[i]! <= inner.min[i]! && inner.max[i]! <= outer.max[i]!)

/**
 * Which part each triangle belongs to, numbered 0.. over the SOLIDS in order
 * of first appearance — with the lazy union, that is top-level statement
 * order. What a click in the viewport resolves against (design.md §8). A
 * void takes the label of the solid whose box holds it: it cannot be clicked,
 * and it must not shift the numbering of the parts that can.
 */
export function partLabels(mesh: Mesh): { labels: Uint32Array; count: number } {
  const { components, of, watertight } = census(mesh)
  const solid = new Map<number, number>()
  components.forEach((c, k) => {
    if (!isVoid(c, watertight)) solid.set(k, solid.size)
  })
  const label = components.map((c, k) => {
    const own = solid.get(k)
    if (own !== undefined) return own
    const holder = components.findIndex((o, j) => solid.has(j) && contains(o, c))
    return holder < 0 ? 0 : solid.get(holder)!
  })
  const labels = new Uint32Array(of.length)
  for (let t = 0; t < of.length; t++) labels[t] = label[of[t]!]!
  return { labels, count: solid.size }
}

const shellOf = (c: Component): ShellStats => ({
  min: c.min,
  max: c.max,
  size: [c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]],
  volume: Math.abs(c.signed) / 6,
  triangles: c.triangles,
})

export function meshStats(mesh: Mesh): MeshStats {
  const { positions, indices } = mesh
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]

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

  const { components, used, edges, watertight } = census(mesh)
  const faces = indices.length / 3
  const shells = components.filter((c) => !isVoid(c, watertight)).map(shellOf)
  const voids = components.filter((c) => isVoid(c, watertight)).map(shellOf)
  // A void's air is not material: its signed volume is already negative in the sum.
  let signed = 0
  for (const c of components) signed += c.signed
  return {
    triangles: faces,
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    volume: watertight ? Math.abs(signed) / 6 : null,
    watertight,
    parts: shells.length,
    shells,
    voids,
    // χ = V − E + F = 2·(closed shells) − 2·genus for a closed surface; a void is a closed shell.
    genus: watertight ? (2 * components.length - (used - edges + faces)) / 2 : null,
  }
}
