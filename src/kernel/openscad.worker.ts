import OpenSCAD from './vendor/openscad.js'
// `?url` gives the emitted asset URL, so the wasm is fetched rather than
// inlined and stays out of the main chunk.
import wasmUrl from './vendor/openscad.wasm?url'
import { FONT_FILES, installFonts, usesText, type FontSet } from './fonts'
import { IN_PATH, kernelArgs, outPath, type CompileRequest, type CompileResponse } from './protocol'

// Each face is its own hashed asset, fetched on the first source that uses text().
const fontUrls = import.meta.glob('./vendor/fonts/*.ttf', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

let fontsLoading: Promise<FontSet> | null = null
/** The fonts, fetched once per worker. A failed fetch is retried on the next text() compile. */
function loadFonts(): Promise<FontSet> {
  fontsLoading ??= Promise.all(
    FONT_FILES.map(async (name) => {
      const url = fontUrls[`./vendor/fonts/${name}`]
      if (!url) throw new Error(`${name} is not bundled`)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
      return [name, new Uint8Array(await response.arrayBuffer())] as const
    }),
  )
    .then((entries) => Object.fromEntries(entries) as FontSet)
    .catch((error: unknown) => {
      fontsLoading = null
      throw error
    })
  return fontsLoading
}

const post = (message: CompileResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { source, format, defines, files } = event.data
  const started = performance.now()
  let stderr = ''

  try {
    const [kernel, fonts] = await Promise.all([
      OpenSCAD({
        noInitialRun: true,
        locateFile: () => wasmUrl,
        print: () => {},
        printErr: (text: string) => {
          stderr += text + '\n'
        },
      }),
      usesText(source) ? loadFonts() : null,
    ])

    kernel.FS.writeFile(IN_PATH, source)
    for (const [path, bytes] of Object.entries(files ?? {})) kernel.FS.writeFile(path, bytes)
    if (fonts) installFonts(kernel, fonts)
    const outputPath = outPath(format)
    // Failure is signalled by a non-zero exit code, for both parse errors and
    // empty top-level geometry. Never infer failure from stderr contents.
    const code = kernel.callMain(kernelArgs(format, defines))
    const ms = Math.round(performance.now() - started)

    if (code !== 0) {
      post({ type: 'error', stderr, ms })
      return
    }

    // Copy off the wasm heap. Transferring the view's buffer would hand over
    // the kernel's entire memory.
    const data = new Uint8Array(kernel.FS.readFile(outputPath))
    post({ type: 'ok', data, stderr, ms }, [data.buffer as ArrayBuffer])
  } catch (error) {
    post({
      type: 'error',
      stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`,
      ms: Math.round(performance.now() - started),
    })
  }
}
