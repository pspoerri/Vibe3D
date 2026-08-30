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

  postMessage(_data: unknown): void {}

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
