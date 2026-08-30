import { stripKernelNoise } from './noise'
import type { CompileRequest, CompileResponse, ExportFormat } from './protocol'

export type { ExportFormat }

export type CompileResult =
  | { ok: true; data: Uint8Array; stderr: string; ms: number }
  | { ok: false; stderr: string; ms: number }

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Owns kernel worker lifecycle. Each compile gets a fresh worker because the
 * kernel's callMain runs main() to exit; terminating a superseded worker is
 * also how an outdated compile is cancelled.
 */
export class Compiler {
  #worker: Worker | null = null

  compile(
    source: string,
    format: ExportFormat = 'off',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<CompileResult> {
    this.cancel()

    const worker = new Worker(new URL('./openscad.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.#worker = worker

    return new Promise<CompileResult>((resolve) => {
      const finish = (result: CompileResult) => {
        clearTimeout(timer)
        worker.terminate()
        if (this.#worker === worker) this.#worker = null
        resolve(result)
      }

      const timer = setTimeout(
        () => finish({ ok: false, stderr: `Compile timed out after ${timeoutMs / 1000}s.`, ms: timeoutMs }),
        timeoutMs,
      )

      worker.onmessage = (event: MessageEvent<CompileResponse>) => {
        const message = event.data
        const stderr = stripKernelNoise(message.stderr)
        finish(
          message.type === 'ok'
            ? { ok: true, data: message.data, stderr, ms: message.ms }
            : { ok: false, stderr: stderr || 'Compile failed with no diagnostics.', ms: message.ms },
        )
      }

      worker.onerror = (event) =>
        finish({ ok: false, stderr: event.message || 'Kernel worker crashed.', ms: 0 })

      worker.postMessage({ source, format } satisfies CompileRequest)
    })
  }

  /** Terminates any in-flight compile. Safe to call when idle. */
  cancel(): void {
    this.#worker?.terminate()
    this.#worker = null
  }

  dispose(): void {
    this.cancel()
  }
}
