/**
 * Yields the payload of each `data:` line, stopping at the `[DONE]` sentinel.
 * Comment/keepalive lines (`: OPENROUTER PROCESSING`) fall out of the `data:`
 * filter and can never reach JSON.parse.
 *
 * Line-oriented, not event-oriented: a multi-line `data:` field would yield two
 * payloads instead of one joined value. Safe here because JSON.stringify
 * escapes newlines, so an OpenAI-compatible server would have to deliberately
 * pretty-print across lines.
 *
 * `getReader()`, never `for await` over the body: ReadableStream's async
 * iterator is Chrome 124+ / Safari 27+, while getReader() is Safari 10.1. The
 * `Uint8Array<ArrayBuffer>` annotation is load-bearing too — a bare
 * `ReadableStream<Uint8Array>` fails pipeThrough(new TextDecoderStream()) with
 * TS2769. It is exactly what `Response.body` already is.
 *
 * A `\r\n` torn across a chunk boundary needs no special case: the trailing
 * `\r` splits to an empty tail that becomes the new buffer, and the leading
 * `\n` of the next chunk splits to an empty first line, which the `data:`
 * filter drops.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += value
      const parts = buf.split(/\r\n|[\r\n]/)
      buf = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.startsWith('data:')) continue
        // Exactly one space after the colon is part of the framing, not the data.
        const payload = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5)
        if (payload === '[DONE]') return
        yield payload
      }
    }
  } finally {
    await reader.cancel()
  }
}
