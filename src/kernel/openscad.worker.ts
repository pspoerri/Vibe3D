import OpenSCAD from './vendor/openscad.js'
// `?url` gives the emitted asset URL, so the wasm is fetched rather than
// inlined and stays out of the main chunk.
import wasmUrl from './vendor/openscad.wasm?url'
import { IN_PATH, kernelArgs, outPath, type CompileRequest, type CompileResponse } from './protocol'

const post = (message: CompileResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer)

self.onmessage = async (event: MessageEvent<CompileRequest>) => {
  const { source, format, defines, files } = event.data
  const started = performance.now()
  let stderr = ''

  try {
    const kernel = await OpenSCAD({
      noInitialRun: true,
      locateFile: () => wasmUrl,
      print: () => {},
      printErr: (text: string) => {
        stderr += text + '\n'
      },
    })

    kernel.FS.writeFile(IN_PATH, source)
    for (const [path, bytes] of Object.entries(files ?? {})) kernel.FS.writeFile(path, bytes)
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
