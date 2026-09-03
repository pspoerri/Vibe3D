/**
 * A document in a link: the source deflated and base64url-encoded into the
 * URL hash, so a static site with no backend can still pass a part around.
 * `#s=` is the whole protocol. A few KB of OpenSCAD is a few hundred bytes.
 */
const KEY = 's='

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const unb64url = (text: string): Uint8Array =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (ch) => ch.charCodeAt(0))

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

/** The hash fragment (without `#`) that carries `source`. */
export async function encodeShare(source: string): Promise<string> {
  const packed = await pipe(new TextEncoder().encode(source), new CompressionStream('deflate-raw'))
  return KEY + b64url(packed)
}

/** The source a hash carries, or null when it carries none or is unreadable. */
export async function decodeShare(hash: string): Promise<string | null> {
  const at = hash.indexOf(KEY)
  if (at < 0) return null
  try {
    const packed = unb64url(hash.slice(at + KEY.length))
    return new TextDecoder().decode(await pipe(packed, new DecompressionStream('deflate-raw')))
  } catch {
    return null
  }
}
