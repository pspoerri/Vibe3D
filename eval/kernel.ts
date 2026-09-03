/**
 * The real kernel under Node: what the real-kernel tests and the eval runner
 * compile with. Each call is a fresh instance (callMain runs to exit), ~0.5 s
 * apiece, and the web glue has no file reader here, so the bytes are handed
 * over as `wasmBinary`.
 */
import { readFileSync } from 'node:fs'
import type { CompileResult } from '../src/kernel/compile'
import { FONT_FILES, installFonts, usesText, type FontSet } from '../src/kernel/fonts'
import { installLibraries, usesLibrary } from '../src/kernel/libraries'
import { stripKernelNoise } from '../src/kernel/noise'
import { IN_PATH, kernelArgs, outPath, type ExportFormat } from '../src/kernel/protocol'
import OpenSCAD from '../src/kernel/vendor/openscad.js'

const VENDOR = new URL('../src/kernel/vendor/', import.meta.url)
const wasmBinary = readFileSync(new URL('openscad.wasm', VENDOR))
export const FONTS: FontSet = Object.fromEntries(
  FONT_FILES.map((name) => [name, new Uint8Array(readFileSync(new URL(`fonts/${name}`, VENDOR)))]),
)
const LIBRARIES = new Uint8Array(readFileSync(new URL('BOSL2.zip', VENDOR)))

export async function compileNode(
  source: string,
  format: ExportFormat,
  files: Record<string, Uint8Array> = {},
  fonts: FontSet | null = usesText(source) ? FONTS : null,
): Promise<{ code: number; data: Uint8Array; stderr: string; ms: number }> {
  let stderr = ''
  const started = performance.now()
  const kernel = await OpenSCAD({
    noInitialRun: true,
    wasmBinary,
    print: () => {},
    printErr: (text: string) => {
      stderr += text + '\n'
    },
  })
  kernel.FS.writeFile(IN_PATH, source)
  for (const [path, bytes] of Object.entries(files)) kernel.FS.writeFile(path, bytes)
  if (fonts) installFonts(kernel, fonts)
  if (usesLibrary(source)) installLibraries(kernel, LIBRARIES)
  const code = kernel.callMain(kernelArgs(format))
  const data = code === 0 ? new Uint8Array(kernel.FS.readFile(outPath(format))) : new Uint8Array()
  return { code, data, stderr, ms: Math.round(performance.now() - started) }
}

/** The same call in the shape the turn controller and the inspection take. */
export async function compileResult(source: string, files: Record<string, Uint8Array> = {}): Promise<CompileResult> {
  const { code, data, stderr, ms } = await compileNode(source, 'off', files)
  const cleaned = stripKernelNoise(stderr)
  return code === 0
    ? { ok: true, data, stderr: cleaned, stderrRaw: stderr, ms }
    : { ok: false, stderr: cleaned || 'Compile failed with no diagnostics.', stderrRaw: stderr, ms }
}
