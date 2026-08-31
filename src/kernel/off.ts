export interface Mesh {
  /** Flat xyz triplets, one per vertex. */
  positions: Float32Array
  /** Flat triangle indices into `positions`. */
  indices: Uint32Array
  vertexCount: number
  triangleCount: number
  /**
   * Flat rgb bytes, one triplet per triangle. Present only when some face had a
   * `color()`; faces without one get DEFAULT_RGB.
   */
  colors?: Uint8Array
}

/** The model's own yellow, 0xf9d72c — what an uncoloured face renders as. */
export const DEFAULT_RGB: readonly [number, number, number] = [249, 215, 44]

/**
 * Parses the OFF that `openscad --export-format=off` produces.
 *
 * Shape: a magic line, then `nVerts nFaces nEdges`, then one vertex per line,
 * then one face per line as `n i0 i1 .. i(n-1) [r g b]`. The Manifold backend
 * always emits triangles, but n-gons are fan-triangulated defensively.
 */
export function parseOff(text: string): Mesh {
  const lines = text.split('\n')
  let cursor = 0

  const nextLine = (): string => {
    while (cursor < lines.length) {
      const line = lines[cursor++]!.trim()
      if (line && !line.startsWith('#')) return line
    }
    throw new Error('unexpected end of OFF data')
  }

  // Counts sit on their own line in OpenSCAD's output, but the OFF format also
  // permits `OFF 4 4 0` on one line. Accept both.
  const header = nextLine().split(/\s+/)
  if (header[0] !== 'OFF') {
    throw new Error(`not an OFF file (got ${JSON.stringify(header[0]?.slice(0, 16) ?? '')})`)
  }
  const counts = header.length > 1 ? header.slice(1) : nextLine().split(/\s+/)
  const vertexCount = Number(counts[0])
  const faceCount = Number(counts[1])
  if (!Number.isInteger(vertexCount) || !Number.isInteger(faceCount)) {
    throw new Error('OFF header does not declare vertex and face counts')
  }

  const positions = new Float32Array(vertexCount * 3)
  for (let v = 0; v < vertexCount; v++) {
    const parts = nextLine().split(/\s+/)
    for (let axis = 0; axis < 3; axis++) {
      const value = Number(parts[axis])
      if (!Number.isFinite(value)) throw new Error(`invalid vertex on OFF line ${cursor}`)
      positions[v * 3 + axis] = value
    }
  }

  const indices: number[] = []
  const colors: number[] = []
  let coloured = false
  for (let f = 0; f < faceCount; f++) {
    const parts = nextLine().split(/\s+/)
    const n = Number(parts[0])
    if (!Number.isInteger(n) || n < 3) throw new Error(`degenerate face on OFF line ${cursor}`)
    if (parts.length < n + 1) {
      throw new Error(`face on OFF line ${cursor} declares ${n} vertices but lists ${parts.length - 1}`)
    }
    // Validate before triangulating: an out-of-range index would otherwise reach
    // BufferGeometry.setIndex and read out of bounds on the GPU, and NaN would be
    // silently coerced to 0 by Uint32Array.from.
    const face: number[] = []
    for (let k = 1; k <= n; k++) {
      const index = Number(parts[k])
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
        throw new Error(`face on OFF line ${cursor} references invalid vertex index ${parts[k]}`)
      }
      face.push(index)
    }
    // parts beyond index n are the per-face colour, `r g b [a]` as 0–255, on
    // exactly the faces that had a color(). Alpha is dropped. A colour that
    // does not parse is cosmetic, so it is ignored rather than fatal.
    let rgb: readonly number[] = DEFAULT_RGB
    if (parts.length >= n + 4) {
      const c = parts.slice(n + 1, n + 4).map(Number)
      if (c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
        rgb = c
        coloured = true
      }
    }
    for (let k = 1; k <= n - 2; k++) {
      indices.push(face[0]!, face[k]!, face[k + 1]!)
      colors.push(rgb[0]!, rgb[1]!, rgb[2]!)
    }
  }

  return {
    positions,
    indices: Uint32Array.from(indices),
    vertexCount,
    triangleCount: indices.length / 3,
    ...(coloured && { colors: Uint8Array.from(colors) }),
  }
}

/**
 * The inverse of parseOff, positions and triangles only: what the diff
 * kernel imports after a part has been moved back into place. Colours are
 * not carried — a boolean has no use for them.
 */
export function encodeOff(mesh: Mesh): Uint8Array {
  const { positions: p, indices } = mesh
  const lines: string[] = ['OFF', `${mesh.vertexCount} ${mesh.triangleCount} 0`]
  for (let v = 0; v < mesh.vertexCount; v++) lines.push(`${p[v * 3]} ${p[v * 3 + 1]} ${p[v * 3 + 2]}`)
  for (let t = 0; t < mesh.triangleCount; t++) {
    lines.push(`3 ${indices[t * 3]} ${indices[t * 3 + 1]} ${indices[t * 3 + 2]}`)
  }
  lines.push('')
  return new TextEncoder().encode(lines.join('\n'))
}
