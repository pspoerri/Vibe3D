/**
 * The app's loop from a shell — compile, measure, look, export — for a model
 * that runs on this machine. Runs unbuilt from the tree under bun, or as the
 * single file `pnpm build:skill` writes beside SKILL.md. Every command prints
 * what the app would show the model; a failure is the message and exit 1.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { compileNode, compileResult } from '../../eval/kernel'
import { checkParts, partCount } from '../../src/chat/parts'
import { SYSTEM_PROMPT } from '../../src/chat/prompt'
import { renderSkill } from '../../src/chat/skills'
import { encodeObj } from '../../src/export/obj'
import { part3mf, partMesh } from '../../src/export/part'
import { encodeStl } from '../../src/export/stl'
import { paint3mf } from '../../src/export/threemf'
import { usesText } from '../../src/kernel/fonts'
import { parseOff } from '../../src/kernel/off'
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

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

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

/** 3MF is the kernel's own, painted; STL and OBJ are the app's encoders over the OFF mesh. */
async function exportPart(args: string[]): Promise<{ code: number; out: string }> {
  const { positionals: [path, out], values } = parse(args)
  if (!path || !out) throw new Error(USAGE)
  const ext = out.split('.').pop() ?? ''
  const part = values.part ? Number(values.part) : 0
  if (!['3mf', 'stl', 'obj'].includes(ext)) throw new Error(`export writes .3mf, .stl or .obj, not .${ext}`)
  if (ext === '3mf') {
    const { data } = await compiled(path, '3mf')
    writeFileSync(out, paint3mf(part ? part3mf(data, part) : data))
  } else {
    const whole = parseOff(decode((await compiled(path)).data))
    const mesh = part ? partMesh(whole, part) : whole
    if (ext === 'stl') writeFileSync(out, encodeStl(mesh))
    else {
      const { obj, mtl } = encodeObj(mesh, basename(out, '.obj'))
      writeFileSync(out, obj)
      if (mtl) writeFileSync(out.replace(/\.obj$/, '.mtl'), mtl)
    }
  }
  return { code: 0, out: `wrote ${out}` }
}

const PROTOCOL_NOTE =
  "The browser app's system prompt follows. Its OUTPUT CONTRACT, SELECTION and SKILLS sections are the app's chat protocol and do not apply here: write the .scad file directly, and the skills are printed below it."

/** The app's system prompt, plus the skills a shell session gets no other way to load. */
const prompt = (): string =>
  [
    PROTOCOL_NOTE,
    '',
    SYSTEM_PROMPT,
    ...['bosl2', 'fonts', 'diff'].flatMap((name) => ['', '---', '', renderSkill(name, { source: '', mesh: null, looks: true })!]),
  ].join('\n')

export async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'check':
        return await check(rest)
      case 'export':
        return await exportPart(rest)
      case 'prompt':
        return { code: 0, out: prompt() }
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
