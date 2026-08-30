/**
 * One normalisation path, per design.md §9: downscale to a bounded longest edge,
 * re-encode as JPEG, emit a `data:` URL. Every upstream accepts that shape, so
 * there is nothing to branch on per provider.
 */

/** design.md:425. Above this, providers downsample server-side anyway. */
export const MAX_EDGE = 1568

/**
 * Pure, and exported separately from the encode because vitest runs in the node
 * environment where createImageBitmap and canvas are both undefined — while the
 * DOM lib makes them typecheck. So the arithmetic is unit-tested here and the
 * encode is asserted in Playwright (design.md §11).
 *
 * `Math.min(1, …)` is what makes this only ever shrink: an image already inside
 * the cap is returned at its own size rather than upscaled into blur and bytes.
 */
export function fit(w: number, h: number, max = MAX_EDGE): [number, number] {
  const longest = Math.max(w, h)
  // A zero longest edge would make the scale Infinity and the result NaN, which
  // surfaces as an opaque canvas throw rather than as a bad image.
  const scale = longest > 0 ? Math.min(1, max / longest) : 1
  return [Math.round(w * scale), Math.round(h * scale)]
}

/**
 * A picked or pasted file → the exact string the wire wants.
 *
 * `canvas.toDataURL` is the whole reason this is short: it returns the `data:`
 * URL directly, so there is no FileReader, no base64 assembly, and no object
 * URL — and therefore no revokeObjectURL lifecycle to leak through the Chat
 * remount at App.tsx's `key={session.currentId}`.
 *
 * `imageOrientation: 'from-image'` applies EXIF rotation. A bare drawImage drops
 * it silently, and a phone photo of a part is the motivating input, so sideways
 * is the common case rather than the edge case.
 *
 * Rejects on an undecodable file. The caller reports that as a chat note.
 */
export async function toDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const [w, h] = fit(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser would not give us a 2D canvas.')
    context.drawImage(bitmap, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    // Frees the decoded bitmap immediately rather than at the next GC. A few
    // 12-megapixel photos is a lot of resident memory to leave lying around.
    bitmap.close()
  }
}
