export interface Mesh {
  /** Flat xyz triplets, one per vertex. */
  positions: Float32Array
  /** Flat triangle indices into `positions`. */
  indices: Uint32Array
  vertexCount: number
  triangleCount: number
}

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
  for (let f = 0; f < faceCount; f++) {
    const parts = nextLine().split(/\s+/)
    const n = Number(parts[0])
    if (!Number.isInteger(n) || n < 3) throw new Error(`degenerate face on OFF line ${cursor}`)
    // parts[1..n] are the vertex indices; anything after them is per-face
    // colour, which we discard.
    const first = Number(parts[1])
    for (let k = 1; k <= n - 2; k++) {
      indices.push(first, Number(parts[1 + k]), Number(parts[2 + k]))
    }
  }

  return {
    positions,
    indices: Uint32Array.from(indices),
    vertexCount,
    triangleCount: indices.length / 3,
  }
}
