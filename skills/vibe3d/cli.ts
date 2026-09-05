/**
 * The app's loop from a shell — compile, measure, look, export — for a model
 * that runs on this machine. Runs unbuilt from the tree under bun, or as the
 * single file `pnpm build:skill` writes beside SKILL.md. Every command prints
 * what the app would show the model; a failure is the message and exit 1.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compileNode, compileResult } from '../../eval/kernel'
import { checkParts, partCount } from '../../src/chat/parts'
import { usesText } from '../../src/kernel/fonts'
import { stripKernelNoise } from '../../src/kernel/noise'
import type { ExportFormat } from '../../src/kernel/protocol'
import { DEFAULT_BED } from '../../src/state/settings'
import type { Vec3 } from '../../src/viewer/camera'
import { formatReport, inspect, meshChecks, type Inspection } from '../../src/viewer/inspect'

const USAGE = `vibe3d check  part.scad [--before prev.scad] [--bed 256,256,256]
vibe3d export part.scad out.3mf|out.stl|out.obj [--part N]
vibe3d look   part.scad out.png [--view iso|iso_back|front|back|left|right|top|bottom|auto] [--cut z=12] [--box x0,y0,z0,x1,y1,z1] [--before prev.scad]
vibe3d prompt`

const OPTIONS = {
  before: { type: 'string' },
  bed: { type: 'string' },
  part: { type: 'string' },
  view: { type: 'string' },
  cut: { type: 'string' },
  box: { type: 'string' },
} as const

const parse = (args: string[]) => parseArgs({ args, options: OPTIONS, allowPositionals: true })

/** The source, and every file an import("name") names, read from beside it. */
// ponytail: flat names only — import("dir/x.stl") is not written into the kernel FS.
function loadSource(path: string): { source: string; files: Record<string, Uint8Array> } {
  if (!existsSync(path)) throw new Error(`${path}: no such file`)
  const source = readFileSync(path, 'utf8')
  const files: Record<string, Uint8Array> = {}
  for (const [, name] of source.matchAll(/\bimport\s*\(\s*"([^"/]+)"/g)) {
    const at = resolve(dirname(path), name!)
    if (existsSync(at)) files[`/${name}`] = new Uint8Array(readFileSync(at))
  }
  return { source, files }
}

/** One compile; the kernel's cleaned diagnostics are the thrown message. */
async function compiled(path: string, format: ExportFormat = 'off') {
  const { source, files } = loadSource(path)
  const { code, data, stderr } = await compileNode(source, format, files)
  if (code !== 0) {
    throw new Error(`${path} did not compile:\n${stripKernelNoise(stderr) || 'Compile failed with no diagnostics.'}`)
  }
  return { source, files, data }
}

/** The compile and the app's inspection of it, against `before` when given. */
async function inspected(path: string, before: string | undefined) {
  const after = await compiled(path)
  const prior = before ? (await compiled(before)).data : null
  const insp = await inspect({
    before: prior,
    after: after.data,
    vision: false,
    signal: new AbortController().signal,
    compile: (source, files) => compileResult(source, files),
  })
  return { ...after, insp }
}

/** What verifyMessage gives the hosted model, minus the question ritual — SKILL.md carries that. */
function checkText(source: string, insp: Inspection, bed: Vec3): string {
  const checks = meshChecks(insp.report, partCount(source), usesText(source), bed)
  const notes = checkParts(source)
  return [
    'The source compiled. Measured from the mesh (millimetres, mm³):',
    '',
    formatReport(insp.report),
    '',
    'Checks the app ran:',
    ...checks.map((line) => `- ${line}`),
    ...(notes.length > 0 ? ['', 'Notes on the source:', ...notes.map((line) => `- ${line}`)] : []),
  ].join('\n')
}

function bedOf(flag: string | undefined): Vec3 {
  if (!flag) return DEFAULT_BED
  const bed = flag.split(',').map(Number)
  if (bed.length !== 3 || bed.some((n) => !(n > 0))) throw new Error('--bed is three sizes in mm, like 256,256,256')
  return bed as unknown as Vec3
}

async function check(args: string[]): Promise<{ code: number; out: string }> {
  const { positionals: [path], values } = parse(args)
  if (!path) throw new Error(USAGE)
  const { source, insp } = await inspected(path, values.before)
  return { code: 0, out: checkText(source, insp, bedOf(values.bed)) }
}

export async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'check':
        return await check(rest)
      default:
        return { code: 2, out: USAGE }
    }
  } catch (error) {
    return { code: 1, out: error instanceof Error ? error.message : String(error) }
  }
}

if ((import.meta as { main?: boolean }).main) {
  const { code, out } = await run(process.argv.slice(2))
  process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
  process.exit(code)
}
