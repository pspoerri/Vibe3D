/**
 * A look request (design.md §6.4's render_view), carried in-band as a ```view
 * block like an edit is, so it works on every model the user can pick — tool
 * calling on OpenRouter is per-model, and an image inside a tool result is the
 * least portable part of the OpenAI-compatible surface.
 */
import { CLOSE_FENCE, OPEN_FENCE, VIEW_FENCE } from './fence'

export const VIEW_NAMES = ['iso', 'iso_back', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const
export type ViewName = (typeof VIEW_NAMES)[number]
export type Axis = 'x' | 'y' | 'z'

export interface ViewRequest {
  view: ViewName
  /** A cut through the part: the half nearer the camera is removed. */
  section: { axis: Axis; at: number } | null
  /** Frame this box (mm) instead of the whole part. */
  box: { min: [number, number, number]; max: [number, number, number] } | null
}

export const VIEW_SHAPE = `{"view": "iso" | "iso_back" | "front" | "back" | "left" | "right" | "top" | "bottom", "section": null | {"axis": "x" | "y" | "z", "at": <mm>}, "box": null | {"min": [x, y, z], "max": [x, y, z]}}`

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

/** The last ```view block of a reply, or why it could not be read. */
export function parseView(text: string): { request: ViewRequest | null; complete: boolean; error: string | null } {
  let body: string[] | null = null
  let last: string | null = null
  let skipping = false
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (body === null && !skipping) {
      if (VIEW_FENCE.test(line)) body = []
      else if (OPEN_FENCE.test(line)) skipping = true
    } else if (CLOSE_FENCE.test(line)) {
      if (body !== null) last = body.join('\n')
      body = null
      skipping = false
    } else if (body !== null) body.push(line)
  }
  if (last === null) return { request: null, complete: body === null, error: null }

  const fail = (why: string) => ({
    request: null,
    complete: true,
    error: `The view block could not be read: ${why}. Its body is one JSON object: ${VIEW_SHAPE}`,
  })
  let raw: unknown
  try {
    raw = JSON.parse(last)
  } catch {
    return fail('it is not valid JSON')
  }
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return fail('it is not an object')
  const view = r.view ?? 'iso'
  if (!(VIEW_NAMES as readonly unknown[]).includes(view)) return fail(`"${String(view)}" is not a view`)
  let section: ViewRequest['section'] = null
  if (r.section != null) {
    const s = r.section as Record<string, unknown>
    if (!['x', 'y', 'z'].includes(String(s.axis)) || typeof s.at !== 'number' || !Number.isFinite(s.at)) {
      return fail('section needs an axis of x, y or z and a numeric at')
    }
    section = { axis: s.axis as Axis, at: s.at }
  }
  let box: ViewRequest['box'] = null
  if (r.box != null) {
    const b = r.box as Record<string, unknown>
    if (!isVec3(b.min) || !isVec3(b.max)) return fail('box needs min and max as [x, y, z]')
    box = { min: b.min, max: b.max }
  }
  return { request: { view: view as ViewName, section, box }, complete: true, error: null }
}

/** The caption the model gets with the render — also what the transcript shows. */
export function describeView(request: ViewRequest): string {
  const parts = [`${request.view.replace('_', ' ')} view`]
  if (request.section) parts.push(`cut at ${request.section.axis} = ${request.section.at} mm, nearer half removed`)
  if (request.box) parts.push(`framed on [${request.box.min.join(', ')}] to [${request.box.max.join(', ')}]`)
  return parts.join(', ')
}
