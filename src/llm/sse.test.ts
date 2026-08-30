import { expect, test } from 'vitest'
import { sseData } from './sse'

/** At 1 byte per chunk every multi-byte character and every \r\n is torn. */
const CHUNK_SIZES = [1, 2, 3, 7, 64, 4096]

const BODY =
  ': OPENROUTER PROCESSING\n\n' +
  'data: {"a":1}\n\n' +
  // No space after the colon, and CRLF line endings.
  'data:{"b":2}\r\n\r\n' +
  // Two spaces: SSE strips exactly one, so the payload keeps the other.
  'data:  leading space kept\n\n' +
  'data: {"t":"héllo — 日本語 🎉"}\r\n\r\n' +
  'data: [DONE]\n\n' +
  'data: never read\n\n'

const PAYLOADS = ['{"a":1}', '{"b":2}', ' leading space kept', '{"t":"héllo — 日本語 🎉"}']

function chunked(
  text: string,
  size: number,
  onCancel?: () => void,
): ReadableStream<Uint8Array<ArrayBuffer>> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
    cancel: () => onCancel?.(),
  })
}

async function collect(stream: ReadableStream<Uint8Array<ArrayBuffer>>): Promise<string[]> {
  const out: string[] = []
  for await (const payload of sseData(stream)) out.push(payload)
  return out
}

test.each(CHUNK_SIZES)(
  'yields the same payloads, stops at [DONE], and skips comments at %i bytes per chunk',
  async (size) => {
    expect(await collect(chunked(BODY, size))).toEqual(PAYLOADS)
  },
)

test('a keepalive-only stream yields nothing and does not throw', async () => {
  expect(await collect(chunked(': OPENROUTER PROCESSING\n\n', 3))).toEqual([])
})

test('discards a truncated final line rather than yielding half a payload', async () => {
  expect(await collect(chunked('data: {"a":1}\n\ndata: {"trun', 7))).toEqual(['{"a":1}'])
})

test('breaking out of the loop cancels the source stream', async () => {
  let cancelled = false
  const seen: string[] = []
  for await (const payload of sseData(chunked(BODY, 64, () => (cancelled = true)))) {
    seen.push(payload)
    break
  }
  expect(seen).toEqual([PAYLOADS[0]])
  expect(cancelled).toBe(true)
})
