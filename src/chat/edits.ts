/**
 * Partial updates (design.md §5): a reply may replace sections of the current
 * source instead of rewriting it. A section is named by its own lines, not by
 * line numbers — a model copies text far more reliably than it counts.
 */
import { CLOSE_FENCE, EDIT_FENCE, OPEN_FENCE } from './fence'

export interface Edit {
  /** The lines to replace, verbatim from the source the model was shown. */
  search: string
  replace: string
}

const SEARCH = '<<<<<<< SEARCH'
const DIVIDER = '======='
const REPLACE = '>>>>>>> REPLACE'

export const EDIT_SHAPE = `${SEARCH}, the lines to replace, ${DIVIDER}, the new lines, ${REPLACE}`

/**
 * Every ```openscad-edit block in a reply. `complete` is false while the last
 * one is still open — the streaming case. A block that is not shaped as an
 * edit is an error rather than a silently skipped block: the model meant it,
 * and the turn should tell it what went wrong.
 */
export function parseEdits(text: string): { edits: Edit[]; complete: boolean; error: string | null } {
  const edits: Edit[] = []
  let error: string | null = null
  let body: string[] | null = null
  let skipping = false

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (body === null && !skipping) {
      if (EDIT_FENCE.test(line)) body = []
      else if (OPEN_FENCE.test(line)) skipping = true
    } else if (CLOSE_FENCE.test(line)) {
      if (body !== null) {
        const edit = parseBody(body)
        if (edit) edits.push(edit)
        else error ??= `Edit block ${edits.length + 1} is malformed: expected ${EDIT_SHAPE}.`
      }
      body = null
      skipping = false
    } else if (body !== null) {
      body.push(line)
    }
  }
  return { edits, complete: body === null, error }
}

function parseBody(lines: string[]): Edit | null {
  const divider = lines.indexOf(DIVIDER)
  if (lines[0]?.trimEnd() !== SEARCH || divider < 0 || lines[lines.length - 1]?.trimEnd() !== REPLACE) {
    return null
  }
  return { search: lines.slice(1, divider).join('\n'), replace: lines.slice(divider + 1, -1).join('\n') }
}

/**
 * Applies the edits in order, each against the result of the last. A search
 * matches whole lines, exactly or up to trailing whitespace, and must match
 * exactly once — anything else is an error the model can act on.
 */
export function applyEdits(
  source: string,
  edits: readonly Edit[],
): { source: string } | { error: string } {
  let lines = source.split('\n')
  for (const [i, edit] of edits.entries()) {
    const fail = (why: string) =>
      ({
        error: `Edit ${i + 1} did not apply: ${why}. Copy the lines to replace exactly from the current source, or send the complete source.`,
      }) as const
    if (edit.search.trim() === '') return fail('its SEARCH section is empty')
    const wanted = edit.search.split('\n')
    const hits = matches(lines, wanted)
    if (hits.length !== 1) {
      return fail(
        hits.length === 0
          ? 'its SEARCH text is not in the current source'
          : `its SEARCH text matches ${hits.length} places`,
      )
    }
    lines = [...lines.slice(0, hits[0]), ...(edit.replace === '' ? [] : edit.replace.split('\n')), ...lines.slice(hits[0]! + wanted.length)]
  }
  return { source: lines.join('\n') }
}

/** Start lines where `wanted` occurs in `lines`. Exact first; trailing whitespace forgiven only if nothing is exact. */
function matches(lines: string[], wanted: string[]): number[] {
  const at = (same: (a: string, b: string) => boolean): number[] => {
    const found: number[] = []
    for (let i = 0; i + wanted.length <= lines.length; i++) {
      let ok = true
      for (let k = 0; k < wanted.length && ok; k++) ok = same(lines[i + k]!, wanted[k]!)
      if (ok) found.push(i)
    }
    return found
  }
  const exact = at((a, b) => a === b)
  return exact.length > 0 ? exact : at((a, b) => a.trimEnd() === b.trimEnd())
}
