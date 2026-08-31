import { Compiler, type CompileResult } from '../kernel/compile'
import { encodeOff, parseOff, type Mesh } from '../kernel/off'
import { meshStats, partLabels, type MeshStats, type ShellStats } from '../kernel/stats'
import type { Vec3 } from './camera'
import { renderComposite, type Detail } from './capture'

export interface Box {
  readonly min: Vec3
  readonly max: Vec3
}

/** What a diff boolean produced: material, none at all, or no answer. */
export type DiffResult = Mesh | 'empty' | null
type DiffStats = MeshStats | 'empty' | null

interface BoxReport {
  min: Vec3
  max: Vec3
  size: Vec3
}

interface ShellReport {
  bbox_mm: BoxReport
  volume_mm3: number
  /** Present when the part was translated whole: the move, already taken out of the diff. */
  moved_mm?: Vec3
}

/** design.md §6.1, the ~200-token text diff. Field names are the wire format. */
export interface Report {
  model_bbox_mm: BoxReport
  volume_mm3: number | null
  watertight: boolean
  parts: number
  /** One entry per solid, in PART order: what the count alone could not say. */
  per_part: ShellReport[]
  /** Closed cavities — pockets that never reached the surface. */
  voids: ShellReport[]
  genus: number | null
  tri_count: number
  was: {
    bbox_mm: BoxReport
    volume_mm3: number | null
    parts: number
    genus: number | null
    tri_count: number
  } | null
  changed_bbox_mm: { min: Vec3; max: Vec3 } | null
  added_volume_mm3: number | null
  removed_volume_mm3: number | null
  /** What changed, largest first — the numbers a close-up request names. At most PIECES_REPORTED. */
  changed_pieces: PieceReport[]
}

interface PieceReport {
  kind: 'added' | 'removed'
  bbox_mm: BoxReport
  volume_mm3: number
  /** The side it is best seen from, named: "front-right, below". */
  seen_from: string
}

/** One piece of what changed: a shell of the added or the removed material. */
export interface Piece {
  kind: 'added' | 'removed'
  box: Box
  volume: number
  /** The side it is best seen from — idealView. */
  direction: Vec3
  from: string
}

// ponytail: more pieces than this are noise in the report; the close-up index still covers them all.
const PIECES_REPORTED = 8

const r1 = (n: number): number => Math.round(n * 10) / 10
const round3 = (v: Vec3): Vec3 => [r1(v[0]), r1(v[1]), r1(v[2])]

export const boxOf = (stats: Pick<MeshStats, 'min' | 'max'>): Box => ({ min: stats.min, max: stats.max })

export function lerpBox(a: Box, b: Box, t: number): Box {
  const mix = (p: Vec3, q: Vec3): Vec3 => [
    p[0] + (q[0] - p[0]) * t,
    p[1] + (q[1] - p[1]) * t,
    p[2] + (q[2] - p[2]) * t,
  ]
  return { min: mix(a.min, b.min), max: mix(a.max, b.max) }
}

function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b
  if (!b) return a
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}

/**
 * A diff shell thinner than this is a sliver where the two compiles resolved
 * a coincident face differently, not a change: it has no volume to speak
 * of, but a box as big as the face it lies on, which would frame every look
 * on the whole part. The volumes still count it; only the framing ignores it.
 */
const SLIVER_MM3 = 0.01

const diffBox = (diff: DiffStats): Box | null => {
  if (diff === null || diff === 'empty') return null
  let box: Box | null = null
  for (const shell of diff.shells) if (shell.volume >= SLIVER_MM3) box = unionBox(box, boxOf(shell))
  return box
}

/** The region that changed: the union of what was added and what was removed. */
export const changeBox = (added: DiffStats, removed: DiffStats): Box | null =>
  unionBox(diffBox(added), diffBox(removed))

/** design.md §6: the changed detail and the body it fused into, in one frame. */
export const frameBox = (change: Box | null, model: Box): Box =>
  change ? lerpBox(change, model, 0.25) : model

const boxReport = (stats: { min: Vec3; max: Vec3; size: Vec3 }): BoxReport => ({
  min: round3(stats.min),
  max: round3(stats.max),
  size: round3(stats.size),
})
const shellReport = (shell: ShellStats, moved: Vec3 | null = null): ShellReport => ({
  bbox_mm: boxReport(shell),
  volume_mm3: r1(shell.volume),
  ...(moved ? { moved_mm: round3(moved) } : {}),
})
const volumeOf = (stats: MeshStats): number | null =>
  stats.volume === null ? null : r1(stats.volume)
const diffVolume = (diff: DiffStats): number | null =>
  diff === null ? null : diff === 'empty' ? 0 : volumeOf(diff)

export function buildReport(input: {
  after: MeshStats
  before: MeshStats | null
  added: DiffStats
  removed: DiffStats
  /** Per solid of `after`: how far it was moved whole, or null. Absent: nothing moved. */
  moves?: readonly (Vec3 | null)[]
  /** changedPieces of the diff. Absent: none. */
  pieces?: readonly Piece[]
}): Report {
  const { after, before, added, removed, moves = [], pieces = [] } = input
  const change = changeBox(added, removed)
  return {
    model_bbox_mm: boxReport(after),
    volume_mm3: volumeOf(after),
    watertight: after.watertight,
    parts: after.parts,
    per_part: after.shells.map((shell, i) => shellReport(shell, moves[i] ?? null)),
    voids: after.voids.map((shell) => shellReport(shell)),
    genus: after.genus,
    tri_count: after.triangles,
    was: before && {
      bbox_mm: boxReport(before),
      volume_mm3: volumeOf(before),
      parts: before.parts,
      genus: before.genus,
      tri_count: before.triangles,
    },
    changed_bbox_mm: change && { min: round3(change.min), max: round3(change.max) },
    added_volume_mm3: diffVolume(added),
    removed_volume_mm3: diffVolume(removed),
    changed_pieces: pieces.slice(0, PIECES_REPORTED).map((piece) => ({
      kind: piece.kind,
      bbox_mm: boxReport({
        min: piece.box.min,
        max: piece.box.max,
        size: [0, 1, 2].map((a) => piece.box.max[a]! - piece.box.min[a]!) as unknown as Vec3,
      }),
      volume_mm3: r1(piece.volume),
      seen_from: piece.from,
    })),
  }
}

/** Each solid's vertices, by part label — voids ride with the solid that holds them. */
function solidVertices(mesh: Mesh): number[][] {
  const { labels, count } = partLabels(mesh)
  const seen = new Uint8Array(mesh.vertexCount)
  const out: number[][] = Array.from({ length: count }, () => [])
  for (let t = 0; t < labels.length; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]!
      if (seen[v]) continue
      seen[v] = 1
      out[labels[t]!]!.push(v)
    }
  }
  return out
}

/** A position to 0.01 mm: what "the same vertex" means across two compiles. */
const posKey = (x: number, y: number, z: number): string =>
  `${Math.round(x * 100)},${Math.round(y * 100)},${Math.round(z * 100)}`

function boxOfVertices(mesh: Mesh, verts: readonly number[]): Box {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) {
    for (let a = 0; a < 3; a++) {
      const value = mesh.positions[v * 3 + a]!
      if (value < min[a]!) min[a] = value
      if (value > max[a]!) max[a] = value
    }
  }
  return { min, max }
}

// ponytail: every n-th vertex above this — the vote does not need all 46k of them.
const MOVE_SAMPLE = 4000

/**
 * design.md §6's origin-move trap, solved on the mesh: the translation that
 * carries part i of `before` onto part i of `after`, when most of its
 * vertices land exactly on the other's — a part moved whole, whatever else
 * changed on it. Candidates are the shifts of the two boxes' corners; the
 * one most vertices agree with wins, and staying put wins ties, so a part
 * that merely grew is never mistaken for one that moved.
 * ponytail: parts pair by index (PART order). A turn that adds or removes a
 * part pairs the rest wrong, and the vote then finds no move — the old
 * behaviour, not a wrong one.
 */
export function partMoves(before: Mesh, after: Mesh): (Vec3 | null)[] {
  const olds = solidVertices(before)
  return solidVertices(after).map((verts, i) => {
    const old = olds[i]
    if (!old || verts.length === 0) return null
    const keys = new Set(
      old.map((v) => posKey(before.positions[v * 3]!, before.positions[v * 3 + 1]!, before.positions[v * 3 + 2]!)),
    )
    const was = boxOfVertices(before, old)
    const now = boxOfVertices(after, verts)
    const candidates = new Map<string, Vec3>()
    for (let c = 0; c < 8; c++) {
      const d: Vec3 = [0, 1, 2].map((a) =>
        c & (1 << a) ? now.max[a]! - was.max[a]! : now.min[a]! - was.min[a]!,
      ) as unknown as Vec3
      if (d.some((x) => Math.abs(x) > 0.005)) candidates.set(posKey(d[0], d[1], d[2]), d)
    }
    if (candidates.size === 0) return null
    const step = Math.max(1, Math.floor(verts.length / MOVE_SAMPLE))
    const sample = verts.filter((_, k) => k % step === 0)
    const hits = (d: Vec3): number => {
      let n = 0
      for (const v of sample) {
        const x = after.positions[v * 3]! - d[0]
        const y = after.positions[v * 3 + 1]! - d[1]
        const z = after.positions[v * 3 + 2]! - d[2]
        if (keys.has(posKey(x, y, z))) n++
      }
      return n
    }
    let best: Vec3 | null = null
    let bestHits = hits([0, 0, 0])
    for (const d of candidates.values()) {
      const h = hits(d)
      if (h > bestHits) {
        best = d
        bestHits = h
      }
    }
    return best && bestHits > sample.length / 2 ? best : null
  })
}

/**
 * `mesh` with each solid translated by its entry in `moves`; the same mesh
 * when nothing moves. A moved vertex that lands on one of `onto`'s vertices
 * takes that vertex's exact float32 position: the kernel rounded its own
 * move differently, and a 1e-5 mm mismatch is a sliver the boolean keeps —
 * dozens of them, over the whole part, each with a box as big as the part.
 */
export function translateParts(mesh: Mesh, moves: readonly (Vec3 | null)[], onto?: Mesh): Mesh {
  if (!moves.some(Boolean)) return mesh
  const positions = mesh.positions.slice()
  const lists = solidVertices(mesh)
  const exact = new Map<string, number>()
  if (onto) {
    const q = onto.positions
    for (let v = 0; v < onto.vertexCount; v++) exact.set(posKey(q[v * 3]!, q[v * 3 + 1]!, q[v * 3 + 2]!), v)
  }
  moves.forEach((move, i) => {
    if (!move) return
    for (const v of lists[i] ?? []) {
      for (let a = 0; a < 3; a++) positions[v * 3 + a] = positions[v * 3 + a]! + move[a]!
      const hit = exact.get(posKey(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!))
      if (hit !== undefined) for (let a = 0; a < 3; a++) positions[v * 3 + a] = onto!.positions[hit * 3 + a]!
    }
  })
  return { ...mesh, positions }
}

const longest = (b: Box): number => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2])
const centre = (b: Box): Vec3 => [
  (b.min[0] + b.max[0]) / 2,
  (b.min[1] + b.max[1]) / 2,
  (b.min[2] + b.max[2]) / 2,
]
const holds = (b: Box, p: Vec3): boolean =>
  [0, 1, 2].every((a) => b.min[a]! <= p[a]! && p[a]! <= b.max[a]!)

const describeFrom = (d: Vec3): string =>
  `${d[1] < 0 ? 'front' : 'back'}-${d[0] > 0 ? 'right' : 'left'}, ${d[2] > 0 ? 'above' : 'below'}`

/** The part whose box holds the centre of `box`, else the whole model: what a look at the box is relative to. */
export const hostOf = (box: Box, parts: readonly Box[], model: Box): Box =>
  parts.find((p) => holds(p, centre(box))) ?? model

/**
 * The side of `host` that `box` sits on, as a camera direction and its name:
 * the rotation a look at that box should come from. A hole in a top face is
 * seen from above, a wheel under a wing from below; on an axis where the box
 * straddles the host's centre, the default iso side is kept.
 */
export function idealView(box: Box, host: Box): { direction: Vec3; from: string } {
  const mid = centre(box)
  const hostMid = centre(host)
  const sign = (a: number, fallback: number): number => Math.sign(mid[a]! - hostMid[a]!) || fallback
  const direction: Vec3 = [sign(0, 1), sign(1, -1), sign(2, 1)]
  return { direction, from: describeFrom(direction) }
}

/** What changed, largest first, each with the side it is best seen from. Slivers excluded. */
export function changedPieces(
  added: DiffStats,
  removed: DiffStats,
  parts: readonly Box[],
  model: Box,
): Piece[] {
  const pieces: Piece[] = []
  for (const [kind, diff] of [['added', added], ['removed', removed]] as const) {
    if (diff === null || diff === 'empty') continue
    for (const shell of diff.shells) {
      if (shell.volume < SLIVER_MM3) continue
      const box = boxOf(shell)
      pieces.push({ kind, box, volume: shell.volume, ...idealView(box, hostOf(box, parts, model)) })
    }
  }
  return pieces.sort((a, b) => b.volume - a.volume)
}

/** A close-up of one piece: framed tight, a tenth of the way out to the whole change, from its best side. */
export const closeupOf = (piece: Piece, change: Box): Detail => ({
  frame: lerpBox(piece.box, change, 0.1),
  direction: piece.direction,
})

/**
 * The automatic close-up pane: the largest piece, when it is small against
 * its part — a wheel under a wing is looked at from below. null when that
 * piece already fills the frame, or when nothing changed.
 */
export function detailOf(
  pieces: readonly Piece[],
  change: Box | null,
  parts: readonly Box[],
  model: Box,
): Detail | null {
  const piece = pieces[0]
  if (!piece || !change) return null
  if (longest(piece.box) >= 0.5 * longest(hostOf(piece.box, parts, model))) return null
  return closeupOf(piece, change)
}

/** What the model is told the image shows — the legend rides with the render decision, not the prompt. */
export function legendFor(before: boolean, detail: Detail | null): string {
  if (!before) return 'The image is one orthographic render of the part in magenta, with crease outlines. It shows layout and proportion only.'
  if (!detail) {
    return 'The image is one orthographic render framed on the changed region: the previous version in green, this version in magenta, unchanged material in grey, with crease outlines. It shows layout and proportion only.'
  }
  return `The image has two panes. Left: an orthographic render framed on the changed region and its surroundings. Right: a close-up of changed piece 1, the largest, seen from the ${describeFrom(detail.direction)}. In both, the previous version is green, this version magenta, unchanged material grey, with crease outlines. They show layout and proportion only.`
}

const fmtBox = (b: BoxReport): string => `[${b.min.join(', ')}] to [${b.max.join(', ')}]`
const inside = (a: BoxReport, b: BoxReport): boolean =>
  [0, 1, 2].every((i) => b.min[i]! <= a.min[i]! && a.max[i]! <= b.max[i]!)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What the app can settle without the model: the checks the system prompt
 * already demands, graded from the mesh so the model's own questions go to
 * the request instead. A line that starts with NO is a defect to fix; the
 * void line names the shell the bare count could not.
 */
export function meshChecks(report: Report, sections: number): string[] {
  const out: string[] = []
  const parts = report.per_part

  const off = parts
    .map((part, i) => ({ n: i + 1, z: part.bbox_mm.min[2] }))
    .filter((part) => Math.abs(part.z) > 0.1)
  out.push(
    off.length === 0
      ? 'rests on Z=0: yes'
      : `rests on Z=0: NO — ${off
          .map((p) => `part ${p.n} ${p.z > 0 ? 'floats' : 'reaches'} ${r1(Math.abs(p.z))} mm ${p.z > 0 ? 'above' : 'below'} the plane`)
          .join('; ')}`,
  )

  const n = parts.length
  if (sections === 0) {
    out.push(
      n > 1
        ? `solids: ${n}, with no PART sections — one part in ${n} disconnected pieces, or ${n} parts that each need a PART section`
        : `solids: ${n}`,
    )
  } else if (n === sections) {
    out.push(`solids: ${n} for ${plural(sections, 'PART section')}: ok`)
  } else if (n > sections) {
    const smallest = parts.reduce((a, b) => (b.volume_mm3 < a.volume_mm3 ? b : a))
    out.push(
      `solids: NO — ${n} for ${plural(sections, 'PART section')}: a part is in disconnected pieces; the smallest solid is ${smallest.volume_mm3} mm³ at ${fmtBox(smallest.bbox_mm)} — overlap it with its part, or delete it`,
    )
  } else {
    out.push(
      `solids: NO — ${n} for ${plural(sections, 'PART section')}: two parts touch or overlap and fused into one, or a section produces nothing`,
    )
  }

  for (const v of report.voids) {
    const holder = parts.findIndex((part) => inside(v.bbox_mm, part.bbox_mm)) + 1
    out.push(
      `closed void: NO — ${v.volume_mm3} mm³ at ${fmtBox(v.bbox_mm)}${holder ? ` inside part ${holder}` : ''}: a cavity that never reaches the surface. If it was meant as a pocket or hole, extend its cutter through the outer face`,
    )
  }
  if (report.voids.length === 0) out.push('closed voids: none')

  out.push(
    report.watertight
      ? 'watertight: yes'
      : 'watertight: NO — the mesh has open edges; look for a zero-thickness feature or a coplanar face',
  )

  const genus = report.genus
  const was = report.was?.genus ?? null
  if (genus !== null && was !== null && genus !== was) {
    const d = Math.abs(genus - was)
    out.push(`genus ${was} → ${genus}: the part ${genus > was ? 'gained' : 'lost'} ${plural(d, 'through-hole')} or loop${d === 1 ? '' : 's'} — intended?`)
  } else if (genus !== null && genus > 0 && was === null) {
    out.push(`genus ${genus}: ${plural(genus, 'through-hole')} or loop${genus === 1 ? '' : 's'}`)
  }
  return out
}

/** Valid JSON, one field per line: readable in the transcript, ~200 tokens on the wire. */
export const formatReport = (report: Report): string =>
  `{\n${Object.entries(report)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(',\n')}\n}`

const decode = (off: Uint8Array): Mesh => parseOff(new TextDecoder().decode(off))

/**
 * A boolean's compile result, read. The kernel exits 1 for an empty top-level
 * object (verified against the pinned build), which here means "nothing was
 * added" — not a failure. Any other failure is an unknown, never a zero.
 */
export function diffOf(result: CompileResult): DiffResult {
  if (result.ok) {
    try {
      return decode(result.data)
    } catch {
      return null
    }
  }
  return /top level object is empty/i.test(result.stderrRaw) ? 'empty' : null
}

/** Same source for both directions; only the files swap. Relative names resolve beside /in.scad. */
const DIFF_SOURCE = 'difference() { import("keep.off"); import("cut.off"); }'
// ponytail: a boolean slower than this reports "unknown" rather than holding the turn.
const DIFF_TIMEOUT_MS = 30_000

async function diff(keep: Uint8Array, cut: Uint8Array, signal: AbortSignal): Promise<DiffResult> {
  const compiler = new Compiler()
  const cancel = (): void => compiler.cancel()
  signal.addEventListener('abort', cancel)
  try {
    return diffOf(
      await compiler.compile(DIFF_SOURCE, 'off', {
        files: { '/keep.off': keep, '/cut.off': cut },
        timeoutMs: DIFF_TIMEOUT_MS,
      }),
    )
  } catch {
    return null
  } finally {
    signal.removeEventListener('abort', cancel)
    compiler.dispose()
  }
}

const statsOf = (diff: DiffResult): DiffStats =>
  diff === null || diff === 'empty' ? diff : meshStats(diff)

export interface InspectInput {
  /** OFF of the mesh on screen when the turn started; null when nothing had compiled. */
  readonly before: Uint8Array | null
  /** OFF the turn just compiled. */
  readonly after: Uint8Array
  /**
   * Whether to spend an image on this model. The catalogue's flag is a gate
   * here, unlike §9: the app is deciding to attach, and a provider that cannot
   * read it fails the turn after a compile the user already waited for.
   */
  readonly vision: boolean
  readonly signal: AbortSignal
}

/** A changed piece and its close-up, rendered when asked for. */
export interface Closeup {
  piece: Piece
  /** The composite framed on the piece from its best side; null when there is no WebGL. */
  render: () => string | null
}

export interface Inspection {
  report: Report
  image: string | null
  /** What the image shows, for the verification message. null when there is no image. */
  legend: string | null
  /**
   * Every changed piece, largest first — the report's changed_pieces numbering
   * — each renderable on demand. Empty when there is nothing to compare, or
   * the model cannot read an image.
   */
  closeups: Closeup[]
}

/** The evidence for one verification round: the numbers always, the render when it is worth sending. */
export async function inspect(input: InspectInput): Promise<Inspection> {
  const afterMesh = decode(input.after)
  const after = meshStats(afterMesh)
  const beforeMesh = input.before ? decode(input.before) : null
  const before = beforeMesh ? meshStats(beforeMesh) : null
  // A part moved whole is put back where it was before the diff, so the
  // volumes and the render show what changed in shape, not the move.
  const moves = beforeMesh ? partMoves(beforeMesh, afterMesh) : []
  const aligned = beforeMesh ? translateParts(beforeMesh, moves, afterMesh) : null
  const alignedOff = aligned === null ? null : aligned === beforeMesh ? input.before : encodeOff(aligned)
  // new − old is what was added; old − new is what was removed. Two kernels, in parallel.
  const [added, removed] = alignedOff
    ? await Promise.all([
        diff(input.after, alignedOff, input.signal),
        diff(alignedOff, input.after, input.signal),
      ])
    : [null, null]
  const addedStats = statsOf(added)
  const removedStats = statsOf(removed)
  const change = changeBox(addedStats, removedStats)
  const parts = after.shells.map(boxOf)
  const model = boxOf(after)
  const pieces = changedPieces(addedStats, removedStats, parts, model)
  const detail = detailOf(pieces, change, parts, model)
  const report = buildReport({ after, before, added: addedStats, removed: removedStats, moves, pieces })
  const image =
    input.vision && !input.signal.aborted
      ? renderComposite(aligned, afterMesh, frameBox(change, model), detail)
      : null
  const closeups =
    change && input.vision
      ? pieces.map((piece) => ({
          piece,
          render: () => {
            const { frame, direction } = closeupOf(piece, change)
            return renderComposite(aligned, afterMesh, frame, null, direction)
          },
        }))
      : []
  return { report, image, legend: image ? legendFor(aligned !== null, detail) : null, closeups }
}
