import { afterEach, beforeEach, expect, test } from 'vitest'
import { Compiler } from './compile'

/**
 * A minimal stand-in for the DOM Worker constructor. Vitest's node
 * environment has no real Worker, which is exactly what lets us exercise
 * Compiler's own cancellation logic — entirely our code, never the kernel —
 * without a real worker thread or a browser.
 */
class FakeWorker {
  static instances: FakeWorker[] = []

  terminateCount = 0
  onmessage: ((event: MessageEvent) => unknown) | null = null
  onerror: ((event: ErrorEvent) => unknown) | null = null

  constructor(..._args: unknown[]) {
    FakeWorker.instances.push(this)
  }

  sent: unknown[] = []

  postMessage(data: unknown): void {
    this.sent.push(data)
  }

  terminate(): void {
    this.terminateCount++
  }
}

// Install the fake only for this file's tests, and restore whatever (if
// anything) was there before, so it cannot leak into other test files.
const hadOwnWorker = Object.prototype.hasOwnProperty.call(globalThis, 'Worker')
const originalWorker = (globalThis as { Worker?: unknown }).Worker

beforeEach(() => {
  FakeWorker.instances = []
  ;(globalThis as { Worker?: unknown }).Worker = FakeWorker
})

afterEach(() => {
  if (hadOwnWorker) {
    ;(globalThis as { Worker?: unknown }).Worker = originalWorker
  } else {
    delete (globalThis as { Worker?: unknown }).Worker
  }
})

test('supersedes the first compile, settling it promptly as cancelled', async () => {
  const compiler = new Compiler()
  try {
    const first = compiler.compile('a')
    compiler.compile('b')

    // Fail fast rather than hang if cancellation regresses to waiting out
    // the (real, 60s-by-default) compile timeout.
    const guard = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('first promise did not settle promptly')),
        200,
      )
      timer.unref()
    })

    const result = await Promise.race([first, guard])

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.cancelled).toBe(true)
  } finally {
    compiler.dispose()
  }
})

test('terminates the superseded worker exactly once', () => {
  const compiler = new Compiler()
  try {
    compiler.compile('a')
    compiler.compile('b')

    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[0]?.terminateCount).toBe(1)
  } finally {
    compiler.dispose()
  }
})

test('cancel() and dispose() on an idle Compiler are harmless no-ops', () => {
  const compiler = new Compiler()
  expect(() => compiler.cancel()).not.toThrow()
  expect(() => compiler.dispose()).not.toThrow()
  expect(FakeWorker.instances).toHaveLength(0)
})

test('stderrRaw carries the verbatim kernel stderr; stderr is cleaned', async () => {
  const compiler = new Compiler()
  try {
    const result = compiler.compile('a')
    const worker = FakeWorker.instances[0]
    if (!worker) throw new Error('expected a worker to be constructed')

    const rawStderr = 'Could not initialize localization.\nECHO: a real warning\n'
    worker.onmessage?.({
      data: { type: 'ok', data: new Uint8Array(), stderr: rawStderr, ms: 1 },
    } as MessageEvent)

    // Fail fast rather than hang if this regresses to waiting out the
    // (real, 60s-by-default) compile timeout.
    const guard = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('compile did not settle promptly')), 200)
      timer.unref()
    })

    const settled = await Promise.race([result, guard])

    expect(settled.ok).toBe(true)
    expect(settled.stderrRaw).toBe(rawStderr)
    expect(settled.stderrRaw).toContain('Could not initialize localization')
    expect(settled.stderr).not.toContain('Could not initialize localization')
    expect(settled.stderr).toContain('a real warning')
  } finally {
    compiler.dispose()
  }
})

test('forwards -D defines to the worker', async () => {
  const compiler = new Compiler()
  try {
    compiler.compile('a', 'off', { defines: ['wall=2.5', '$fn=16'] })
    expect(FakeWorker.instances[0]?.sent[0]).toEqual({
      source: 'a',
      format: 'off',
      defines: ['wall=2.5', '$fn=16'],
    })
  } finally {
    compiler.dispose()
  }
})

test('omits defines entirely when none are given', () => {
  const compiler = new Compiler()
  try {
    compiler.compile('a')
    expect(FakeWorker.instances[0]?.sent[0]).toEqual({
      source: 'a',
      format: 'off',
      defines: undefined,
    })
  } finally {
    compiler.dispose()
  }
})

test('a timeout is flagged timedOut, so the retry loop can refuse to repair it', async () => {
  const compiler = new Compiler()
  try {
    // stderrRaw here is the synthetic 'Compile timed out after 0.005s.', not a
    // kernel diagnostic — feeding it to the model would spend a paid attempt
    // against a fabrication.
    const result = await compiler.compile('a', 'off', { timeoutMs: 5 })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.timedOut).toBe(true)
    expect(result.ok === false && result.cancelled).toBeUndefined()
  } finally {
    compiler.dispose()
  }
})

test('a worker crash is flagged crashed, with a frequently-empty stderrRaw', async () => {
  const compiler = new Compiler()
  try {
    const pending = compiler.compile('a')
    const worker = FakeWorker.instances[0]
    if (!worker) throw new Error('expected a worker to be constructed')
    worker.onerror?.({ message: '' } as ErrorEvent)

    const result = await pending
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.crashed).toBe(true)
    expect(result.ok === false && result.stderrRaw).toBe('')
    // The user still gets something legible even though the model gets nothing.
    expect(result.stderr).toBe('Kernel worker crashed.')
  } finally {
    compiler.dispose()
  }
})
