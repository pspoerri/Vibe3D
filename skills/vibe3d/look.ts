/**
 * The browser side of `vibe3d look`: bundled by bun into look.js and loaded
 * into an empty page that headless Chrome screenshots. The CLI has done the
 * geometry; this draws one render — the app's own capture.ts — into the body.
 */
import type { ViewRequest } from '../../src/chat/views'
import { parseOff } from '../../src/kernel/off'
import type { Vec3 } from '../../src/viewer/camera'
import { renderComposite, renderView, type Detail } from '../../src/viewer/capture'
import type { Box } from '../../src/viewer/inspect'

export type LookJob =
  | { kind: 'view'; off: string; ghost: string | null; request: ViewRequest; model: Box; from: Vec3 | null }
  | { kind: 'composite'; before: string | null; after: string; frame: Box; detail: Detail | null }

/** The render as an image filling the window from its top-left corner, or a line saying why there is none. */
function look(job: LookJob): void {
  const url =
    job.kind === 'view'
      ? renderView(parseOff(job.off), job.request, job.model, job.ghost ? parseOff(job.ghost) : null, job.from)
      : renderComposite(job.before ? parseOff(job.before) : null, parseOff(job.after), job.frame, job.detail)
  document.body.style.margin = '0'
  if (!url) {
    document.body.textContent = 'no WebGL in this browser'
    return
  }
  const img = new Image()
  img.style.display = 'block'
  img.src = url
  document.body.append(img)
}

;(window as unknown as { vibe3dLook: typeof look }).vibe3dLook = look
