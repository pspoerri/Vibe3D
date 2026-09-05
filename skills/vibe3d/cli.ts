/**
 * The app's loop from a shell — compile, measure, look, export — for a model
 * that runs on this machine. Runs unbuilt from the tree under bun, or as the
 * single file `pnpm build:skill` writes beside SKILL.md. Every command prints
 * what the app would show the model; a failure is the message and exit 1.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { compileNode, compileResult } from '../../eval/kernel'
import { checkParts, constructionSource, partCount } from '../../src/chat/parts'
import { SYSTEM_PROMPT } from '../../src/chat/prompt'
import { renderSkill } from '../../src/chat/skills'
import { describeView, VIEW_NAMES, type Axis, type ViewName, type ViewRequest } from '../../src/chat/views'
import { encodeObj } from '../../src/export/obj'
import { part3mf, partMesh } from '../../src/export/part'
import { encodeStl } from '../../src/export/stl'
import { paint3mf } from '../../src/export/threemf'
import { usesText } from '../../src/kernel/fonts'
import { encodeOff, parseOff } from '../../src/kernel/off'
import { stripKernelNoise } from '../../src/kernel/noise'
import type { ExportFormat } from '../../src/kernel/protocol'
import { meshStats } from '../../src/kernel/stats'
import { DEFAULT_BED } from '../../src/state/settings'
import type { Vec3 } from '../../src/viewer/camera'
import { boxOf, formatReport, hostOf, idealView, inspect, legendFor, meshChecks, type Inspection } from '../../src/viewer/inspect'
import type { LookJob } from './look'

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

const CHROME_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']
const CHROME_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
]

/** $VIBE3D_CHROME, then PATH, then the macOS apps. null when there is none: check and export never need it. */
export function findChrome(): string | null {
  if (process.env.VIBE3D_CHROME) return process.env.VIBE3D_CHROME
  for (const name of CHROME_NAMES) {
    const found = spawnSync('which', [name], { encoding: 'utf8' })
    if (found.status === 0) return found.stdout.trim()
  }
  return CHROME_APPS.find((app) => existsSync(app)) ?? null
}

/** look.js beside this file (the built skill), else built now from look.ts (the source tree). */
function lookBundle(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const built = join(here, 'look.js')
  if (!existsSync(built)) {
    const entry = join(here, 'look.ts')
    if (!existsSync(entry)) throw new Error(`${built} is missing: run pnpm build:skill`)
    const r = spawnSync('bun', ['build', entry, '--target=browser', '--format=iife', '--outfile', built], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('bun build look.ts failed')
  }
  return built
}

const V3 = (a: number[]): [number, number, number] => [a[0]!, a[1]!, a[2]!]

function viewRequest(values: { view?: string; cut?: string; box?: string }): ViewRequest {
  const view = values.view ?? 'iso'
  if (view !== 'auto' && !(VIEW_NAMES as readonly string[]).includes(view)) {
    throw new Error(`--view is one of ${VIEW_NAMES.join(', ')}, auto`)
  }
  const cut = values.cut === undefined ? null : /^([xyz])=(-?\d+(?:\.\d+)?)$/.exec(values.cut)
  if (values.cut !== undefined && !cut) throw new Error('--cut is axis=mm, like z=12')
  const box = values.box?.split(',').map(Number)
  if (box && (box.length !== 6 || box.some(Number.isNaN))) throw new Error('--box is x0,y0,z0,x1,y1,z1')
  return {
    view: view as ViewName | 'auto',
    section: cut ? { axis: cut[1] as Axis, at: Number(cut[2]) } : null,
    box: box ? { min: V3(box.slice(0, 3)), max: V3(box.slice(3)) } : null,
    closeup: null,
  }
}

/** One page, one Chrome, one screenshot. Chrome does not exit on its own under a sandbox, so the file is the signal. */
async function screenshot(chrome: string, job: LookJob, width: number, out: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'vibe3d-look-'))
  const page = join(dir, 'look.html')
  writeFileSync(
    page,
    `<!doctype html><body><script src="file://${lookBundle()}"></script><script>vibe3dLook(${JSON.stringify(job)})</script></body>`,
  )
  rmSync(out, { force: true })
  const child = spawn(
    chrome,
    [
      '--headless=new', '--no-sandbox', `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', '--hide-scrollbars',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--window-size=${width},768`,
      `--screenshot=${resolve(out)}`, `file://${page}`,
    ],
    { stdio: 'ignore' },
  )
  // A bad VIBE3D_CHROME is an 'error' event, and an unheard one is an uncaught throw past run's catch.
  let spawnFailed: string | null = null
  child.on('error', (error) => {
    spawnFailed = error.message
  })
  try {
    const tick = () => new Promise((done) => setTimeout(done, 250))
    const until = Date.now() + 30_000
    while (!spawnFailed && !existsSync(out) && Date.now() < until) await tick()
    if (spawnFailed) throw new Error(`${chrome}: ${spawnFailed}`)
    if (!existsSync(out)) throw new Error(`${chrome} wrote no screenshot in 30 s`)
    await tick() // ponytail: one beat for the write to finish; a size-stable poll if a truncated PNG ever shows up
  } finally {
    child.kill('SIGKILL')
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      // Chrome's helpers outlive the process we killed and keep writing to the profile: a temp dir
      // left behind is not worth failing a screenshot that already landed.
    }
  }
}

async function look(args: string[]): Promise<{ code: number; out: string }> {
  const { positionals: [path, out], values } = parse(args)
  if (!path || !out) throw new Error(USAGE)
  const request = viewRequest(values)
  const chrome = findChrome()
  if (!chrome) throw new Error('No Chrome found: set VIBE3D_CHROME to a Chrome or Chromium binary. check and export work without it.')
  const { source, files, data, insp } = await inspected(path, values.before)
  let job: LookJob
  let legend: string
  let width = 768
  if (values.before) {
    const { before, after, frame, detail } = insp.composite
    job = { kind: 'composite', before: before && decode(encodeOff(before)), after: decode(encodeOff(after)), frame, detail }
    legend = legendFor(before !== null, detail)
    if (detail) width = 1536
  } else {
    const mesh = parseOff(decode(data))
    const stats = meshStats(mesh)
    const model = boxOf(stats)
    // An auto view looks from the side of its part the box sits on, as Chat.tsx does.
    const target = request.box ?? model
    const from = request.view === 'auto' ? idealView(target, hostOf(target, stats.shells.map(boxOf), model)).direction : null
    const ghostSource = constructionSource(source)
    const ghost = ghostSource ? await compileNode(ghostSource, 'off', files) : null
    job = {
      kind: 'view',
      off: decode(data),
      ghost: ghost?.code === 0 ? decode(ghost.data) : null,
      request,
      model,
      from,
    }
    legend = `Requested view: ${describeView(request)}. Layout and proportion only — read every dimension from the report.`
  }
  await screenshot(chrome, job, width, out)
  return { code: 0, out: `wrote ${out}\n${legend}` }
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
      case 'look':
        return await look(rest)
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
