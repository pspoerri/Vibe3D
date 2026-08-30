import { stripKernelNoise } from './noise'
import type { CompileRequest, CompileResponse, ExportFormat } from './protocol'

export type { ExportFormat }

// stderr is the cleaned form for display; stderrRaw is verbatim kernel
// stderr, untouched — the form Milestone 2 feeds back to the model.
export type CompileResult =
  | { ok: true; data: Uint8Array; stderr: string; stderrRaw: string; ms: number }
  | { ok: false; stderr: string; stderrRaw: string; ms: number; cancelled?: boolean }

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Owns kernel worker lifecycle. Each compile gets a fresh worker because the
 * kernel's callMain runs main() to exit; terminating a superseded worker is
 * also how an outdated compile is cancelled.
 */
export class Compiler {
  #worker: Worker | null = null
  /** Settles the in-flight compile, if any. Nulled once it has been called. */
  #finish: ((result: CompileResult) => void) | null = null
  #started = 0

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
    this.#started = performance.now()

    return new Promise<CompileResult>((resolve) => {
      const finish = (result: CompileResult) => {
        clearTimeout(timer)
        worker.terminate()
        if (this.#worker === worker) this.#worker = null
        if (this.#finish === finish) this.#finish = null
        resolve(result)
      }

      const timer = setTimeout(() => {
        const stderr = `Compile timed out after ${timeoutMs / 1000}s.`
        finish({ ok: false, stderr, stderrRaw: stderr, ms: timeoutMs })
      }, timeoutMs)
      // Assigned after `timer` exists — finish() closes over it.
      this.#finish = finish

      worker.onmessage = (event: MessageEvent<CompileResponse>) => {
        const message = event.data
        const stderr = stripKernelNoise(message.stderr)
        finish(
          message.type === 'ok'
            ? { ok: true, data: message.data, stderr, stderrRaw: message.stderr, ms: message.ms }
            : {
                ok: false,
                stderr: stderr || 'Compile failed with no diagnostics.',
                stderrRaw: message.stderr,
                ms: message.ms,
              },
        )
      }

      worker.onerror = (event) => {
        const raw = event.message ?? ''
        finish({
          ok: false,
          stderr: stripKernelNoise(raw) || 'Kernel worker crashed.',
          stderrRaw: raw,
          ms: Math.round(performance.now() - this.#started),
        })
      }

      worker.postMessage({ source, format } satisfies CompileRequest)
    })
  }

  /** Settles any in-flight compile as cancelled and terminates its worker. Safe when idle. */
  cancel(): void {
    this.#finish?.({
      ok: false,
      cancelled: true,
      stderr: 'Compile cancelled.',
      stderrRaw: 'Compile cancelled.',
      ms: Math.round(performance.now() - this.#started),
    })
    // finish() already terminated the worker; this covers the idle case.
    this.#worker?.terminate()
    this.#worker = null
  }

  dispose(): void {
    this.cancel()
  }
}
