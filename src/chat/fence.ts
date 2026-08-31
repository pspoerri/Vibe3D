/**
 * Line-based, not one regex over the whole reply: a single pattern cannot tell
 * an opening fence from a closing one, and a bare ``` is both.
 */
// A lone \r has to go too, not just the \r\n pair: a stream boundary can land
// between the two, and `[^\n]*$` then swallows the orphan so the fence never
// opens and the code body prints into the transcript as prose.
export const OPEN_FENCE = /^```[^\n]*$/
export const CLOSE_FENCE = /^```\s*$/
/** A partial update (edits.ts). Never a document: extractSource steps over it. */
export const EDIT_FENCE = /^```openscad-edit\s*$/i
/** A PART replacement (parts.ts). The number is checked there; here any `openscad-part` is an aside. */
export const PART_FENCE = /^```openscad-part\b.*$/i
/** A look request (views.ts). */
export const VIEW_FENCE = /^```view\s*$/i
/** A block that is not a document. */
export const isAside = (line: string): boolean =>
  EDIT_FENCE.test(line) || PART_FENCE.test(line) || VIEW_FENCE.test(line)

/** An OpenSCAD comment, so a stub can never be mistaken for code. */
const STUB = '// ... superseded source elided; the current version appears later ...'

/**
 * Extracts the OpenSCAD source from a possibly still-streaming reply. The last
 * block wins, and an unterminated one wins over any complete block before it —
 * a model that restarts its answer has abandoned what came first.
 *
 * `complete` is the only thing separating a live preview from a committable
 * document, so it stays false until the closing fence has actually arrived.
 *
 * CRLF is normalised HERE and nowhere else: this is the single ingest point for
 * model text, and a trailing \r lexes as a WORD in the Customizer's annotation
 * grammar, silently killing every slider downstream.
 */
export function extractSource(text: string): { source: string | null; complete: boolean } {
  let source: string | null = null
  let complete = false
  let body: string[] | null = null
  // Inside an edit block: its lines are not source, and its closing fence
  // must not read as a bare opening one.
  let skipping = false

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (skipping) {
      if (CLOSE_FENCE.test(line)) skipping = false
    } else if (body === null) {
      if (isAside(line)) skipping = true
      else if (OPEN_FENCE.test(line)) body = []
    } else if (CLOSE_FENCE.test(line)) {
      // A closed but empty block is not a document. Reporting '' here would
      // commit a blank file over the user's part.
      source = body.join('\n') || null
      complete = true
      body = null
    } else {
      body.push(line)
    }
  }

  if (body === null) return { source, complete }
  // A fence that has only just opened reports null, not '': the controller
  // drafts on any non-null source, and '' would blank the editor for a tick.
  const partial = body.join('\n')
  return { source: partial === '' ? null : partial, complete: false }
}

/**
 * Replaces every fenced body with a one-line placeholder (design.md §12). The
 * fences themselves stay, so the stub still reads as "there was code here".
 * Does NOT normalise CRLF — this rewrites the log's verbatim text, and only the
 * bodies are meant to change.
 */
export function stubFences(text: string): string {
  const out: string[] = []
  let inBody = false

  for (const line of text.split('\n')) {
    if (!inBody) {
      out.push(line)
      if (OPEN_FENCE.test(line)) {
        inBody = true
        out.push(STUB)
      }
    } else if (CLOSE_FENCE.test(line)) {
      out.push(line)
      inBody = false
    }
  }
  // A block the reply never closed still has to be closed here, or the stub
  // goes on the wire with a dangling fence for the model to continue.
  if (inBody) out.push('```')

  return out.join('\n')
}
