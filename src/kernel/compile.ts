import { stripKernelNoise } from './noise'
import type { CompileRequest, CompileResponse, ExportFormat } from './protocol'

export type { ExportFormat }

/**
 * stderr is the cleaned form for display. stderrRaw is verbatim kernel stderr
 * on the two worker paths — but SYNTHETIC on the other three settle paths
 * ('Compile timed out after 60s.', 'Compile cancelled.', and the DOM
 * ErrorEvent message, which is frequently ''). The three discriminators below
 * are how the retry loop avoids feeding a fabricated diagnostic to the model
 * and burning a repair attempt against it; the model form of a real
 * diagnostic is noise.ts's stderrForModel.
 */
export type CompileResult =
  | { ok: true; data: Uint8Array; stderr: string; stderrRaw: string; ms: number }
  | {
      ok: false
      stderr: string
      stderrRaw: string
      ms: number
      /** Set only by cancel(). Something superseded this compile. */
      cancelled?: true
      /** Set only by the timeout path. Not a repairable diagnostic. */
      timedOut?: true
      /** Set only by worker.onerror. stderrRaw is a DOM message, often ''. */
      crashed?: true
    }

export interface CompileOptions {
  defines?: readonly string[]
  timeoutMs?: number
  /** Extra files for the kernel FS, by absolute path — see CompileRequest.files. */
  files?: Readonly<Record<string, Uint8Array>>
}

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
    options: CompileOptions = {},
  ): Promise<CompileResult> {
    const { defines, files, timeoutMs = DEFAULT_TIMEOUT_MS } = options
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
        finish({ ok: false, stderr, stderrRaw: stderr, ms: timeoutMs, timedOut: true })
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
          crashed: true,
        })
      }

      worker.postMessage({ source, format, defines, files } satisfies CompileRequest)
    })
  }

  /** Settles any in-flight compile as cancelled and terminates its worker. Safe when idle. */
  cancel(): void {
    this.#finish?.({
      ok: false,
      cancelled: true as const,
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
