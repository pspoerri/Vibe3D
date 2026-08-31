import { Compiler, type CompileResult } from '../kernel/compile'
import { parseOff, type Mesh } from '../kernel/off'
import { meshStats, type MeshStats } from '../kernel/stats'
import type { Vec3 } from './camera'
import { renderComposite } from './capture'

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

/** design.md §6.1, the ~200-token text diff. Field names are the wire format. */
export interface Report {
  model_bbox_mm: BoxReport
  volume_mm3: number | null
  watertight: boolean
  parts: number
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
  /** The origin-move trap of §6, as a number: non-zero means the diff volumes include a move. */
  bbox_min_shift_mm: Vec3 | null
}

const r1 = (n: number): number => Math.round(n * 10) / 10
const round3 = (v: Vec3): Vec3 => [r1(v[0]), r1(v[1]), r1(v[2])]

export const boxOf = (stats: MeshStats): Box => ({ min: stats.min, max: stats.max })

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

const diffBox = (diff: DiffStats): Box | null =>
  diff !== null && diff !== 'empty' && diff.triangles > 0 ? boxOf(diff) : null

/** The region that changed: the union of what was added and what was removed. */
export const changeBox = (added: DiffStats, removed: DiffStats): Box | null =>
  unionBox(diffBox(added), diffBox(removed))

/** design.md §6: the changed detail and the body it fused into, in one frame. */
export const frameBox = (change: Box | null, model: Box): Box =>
  change ? lerpBox(change, model, 0.25) : model

const boxReport = (stats: MeshStats): BoxReport => ({
  min: round3(stats.min),
  max: round3(stats.max),
  size: round3(stats.size),
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
}): Report {
  const { after, before, added, removed } = input
  const change = changeBox(added, removed)
  return {
    model_bbox_mm: boxReport(after),
    volume_mm3: volumeOf(after),
    watertight: after.watertight,
    parts: after.parts,
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
    bbox_min_shift_mm: before
      ? round3([
          after.min[0] - before.min[0],
          after.min[1] - before.min[1],
          after.min[2] - before.min[2],
        ])
      : null,
  }
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

export interface Inspection {
  report: Report
  image: string | null
}

/** The evidence for one verification round: the numbers always, the render when it is worth sending. */
export async function inspect(input: InspectInput): Promise<Inspection> {
  const afterMesh = decode(input.after)
  const after = meshStats(afterMesh)
  const beforeMesh = input.before ? decode(input.before) : null
  const before = beforeMesh ? meshStats(beforeMesh) : null
  // new − old is what was added; old − new is what was removed. Two kernels, in parallel.
  const [added, removed] = input.before
    ? await Promise.all([
        diff(input.after, input.before, input.signal),
        diff(input.before, input.after, input.signal),
      ])
    : [null, null]
  const addedStats = statsOf(added)
  const removedStats = statsOf(removed)
  const report = buildReport({ after, before, added: addedStats, removed: removedStats })
  const image =
    input.vision && !input.signal.aborted
      ? renderComposite(
          beforeMesh,
          afterMesh,
          frameBox(changeBox(addedStats, removedStats), boxOf(after)),
        )
      : null
  return { report, image }
}
