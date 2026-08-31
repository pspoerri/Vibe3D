/**
 * PART sections: `// ---- PART 1 ----` … `// ---- PART 1 END ----` around one
 * top-level statement each, so part N in the viewport is PART N in the source,
 * and a reply can replace one section by number instead of by its text. A
 * module is a unit of the same kind: `openscad-part name` replaces one whole
 * `module name(...) { … }`, found by parsing rather than by markers.
 */
import { CLOSE_FENCE, OPEN_FENCE } from './fence'

export interface PartBlock {
  /** A PART number, or a module name. */
  target: number | string
  /** The section's new lines (markers excluded) or the whole module definition. Empty deletes. */
  body: string
}

const FENCE = /^```openscad-part(?:\s+([\w$]+))?\s*$/i
const MARKER = /^\s*\/\/\s*-+\s*PART\s+(\d+)\s*(END)?\s*-+\s*$/i
/** Construction geometry: reference shapes the user sees as a ghost and nothing ever prints. */
const CONSTRUCTION = /^\s*\/\/\s*-+\s*CONSTRUCTION\s*(END)?\s*-+\s*$/i
/** The background modifier at the start of a statement line — what keeps it out of the render. */
const BACKGROUND = /^(\s*)%/

export const openMarker = (n: number): string => `// ---- PART ${n} ----`
export const closeMarker = (n: number): string => `// ---- PART ${n} END ----`
export const CONSTRUCTION_OPEN = '// ---- CONSTRUCTION ----'
export const CONSTRUCTION_CLOSE = '// ---- CONSTRUCTION END ----'

/** Every ```openscad-part N block in a reply, in order. `complete` is false while the last one is still open. */
export function parsePartBlocks(text: string): { blocks: PartBlock[]; complete: boolean; error: string | null } {
  const blocks: PartBlock[] = []
  let error: string | null = null
  let body: string[] | null = null
  let target: number | string = 0
  let skipping = false

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (body === null && !skipping) {
      const fence = FENCE.exec(line)
      if (fence) {
        if (fence[1] === undefined) {
          error ??= 'An openscad-part block names its target on the fence line: ```openscad-part 2 for a PART section, ```openscad-part lid for a module.'
          skipping = true
        } else {
          target = /^\d+$/.test(fence[1]) ? Number(fence[1]) : fence[1]
          body = []
        }
      } else if (OPEN_FENCE.test(line)) skipping = true
    } else if (CLOSE_FENCE.test(line)) {
      if (body !== null) blocks.push({ target, body: body.join('\n') })
      body = null
      skipping = false
    } else if (body !== null) {
      body.push(line)
    }
  }
  return { blocks, complete: body === null, error }
}

interface Span {
  start: number
  end: number
  /** The file's last marker opened this section and nothing closed it: it runs to the end. */
  unclosed?: true
}

/**
 * Line index of each section's open and END markers. A stray marker is not a
 * section — except an open marker that is the file's last, which models do
 * leave: that section runs to the end of the file, and a replacement closes it.
 */
function sections(lines: readonly string[]): Map<number, Span> {
  const found = new Map<number, Span>()
  let open: { part: number; start: number } | null = null
  for (const [i, line] of lines.entries()) {
    const m = MARKER.exec(line)
    if (!m) continue
    const part = Number(m[1])
    if (m[2]) {
      if (open?.part === part && !found.has(part)) found.set(part, { start: open.start, end: i })
      open = null
    } else open = { part, start: i }
  }
  if (open && !found.has(open.part)) found.set(open.part, { start: open.start, end: lines.length - 1, unclosed: true })
  return found
}

/** How many PART sections the source has — what the mesh's solid count is checked against. */
export const partCount = (source: string): number => sections(source.split('\n')).size

/** The construction section's open and END lines, when both exist. */
function constructionSpan(lines: readonly string[]): { start: number; end: number } | null {
  let start = -1
  for (const [i, line] of lines.entries()) {
    const m = CONSTRUCTION.exec(line)
    if (!m) continue
    if (m[1]) {
      if (start >= 0) return { start, end: i }
    } else start = i
  }
  return null
}

/**
 * The source that compiles to the construction geometry alone: every PART
 * section removed, and the `%` taken off the construction statements so the
 * kernel renders them. null when there is no construction section — the
 * caller then has nothing to compile. Modules and parameters stay, since the
 * construction shapes are usually built from them.
 */
export function constructionSource(source: string): string | null {
  const lines = source.split('\n')
  const span = constructionSpan(lines)
  if (!span) return null
  const parts = sections(lines)
  const dropped = new Set<number>()
  for (const { start, end } of parts.values()) for (let i = start; i <= end; i++) dropped.add(i)
  return lines
    .flatMap((line, i) => {
      if (dropped.has(i)) return []
      if (i > span.start && i < span.end) return [line.replace(BACKGROUND, '$1')]
      return [line]
    })
    .join('\n')
}

/** The unpaired markers, as the model should hear about them. */
function strayMarkers(lines: readonly string[]): string[] {
  const out: string[] = []
  let open: number | null = null
  for (const line of lines) {
    const m = MARKER.exec(line)
    if (!m) continue
    const part = Number(m[1])
    if (m[2]) {
      if (open !== part) out.push(`"${closeMarker(part)}" closes nothing: ${open === null ? 'no PART is open there' : `PART ${open} is open`}.`)
      open = null
    } else {
      if (open !== null) out.push(`PART ${open} is opened but never closed with "${closeMarker(open)}".`)
      open = part
    }
  }
  if (open !== null) out.push(`PART ${open} is opened but never closed with "${closeMarker(open)}".`)
  return out
}

const escape = (name: string): string => name.replace(/\$/g, '\\$')
const moduleHead = (name: string): RegExp => new RegExp(`^\\s*module\\s+${escape(name)}\\s*\\(`)

/**
 * The lines of `module name(...) …`: from its head to the `}` that closes its
 * body, or to the `;` of a braceless one-statement module. Counts brackets on
 * comment-stripped lines — strings and block comments are not handled.
 */
function moduleSpan(lines: readonly string[], name: string): { start: number; end: number } | null {
  const head = moduleHead(name)
  const start = lines.findIndex((line) => head.test(line))
  if (start < 0) return null
  let parens = 0
  let braces = 0
  let paramsDone = false
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, '')
    for (const ch of line) {
      if (ch === '(') parens++
      else if (ch === ')') {
        parens--
        if (parens === 0) paramsDone = true
      } else if (!paramsDone) continue
      else if (ch === '{') braces++
      else if (ch === '}') {
        braces--
        if (braces === 0) return { start, end: i }
      } else if (ch === ';' && braces === 0) return { start, end: i }
    }
  }
  return null
}

/**
 * Replaces each target. A PART number swaps the lines between its markers — a
 * number one past the last section appends one, an empty body deletes it and
 * the rest renumber so the viewport's part N stays PART N. A module name swaps
 * that whole definition (the comment above it stays); a name the source lacks
 * is appended — OpenSCAD hoists modules, so where it lands does not matter.
 */
export function applyParts(
  source: string,
  blocks: readonly PartBlock[],
): { source: string } | { error: string } {
  let lines = source.split('\n')
  for (const block of blocks) {
    const body = block.body === '' ? [] : block.body.split('\n')
    if (typeof block.target === 'string' && block.target.toLowerCase() === 'construction') {
      const span = constructionSpan(lines)
      if (span) {
        lines =
          body.length === 0
            ? [...lines.slice(0, span.start), ...lines.slice(span.end + 1)]
            : [...lines.slice(0, span.start + 1), ...body, ...lines.slice(span.end)]
      } else if (body.length === 0) {
        return { error: 'There is no CONSTRUCTION section in the current source to delete.' }
      } else lines = [...lines, '', CONSTRUCTION_OPEN, ...body, CONSTRUCTION_CLOSE]
      continue
    }
    if (typeof block.target === 'string') {
      const name = block.target
      if (body.length > 0 && !body.some((line) => moduleHead(name).test(line))) {
        return {
          error: `The block for module ${name} must be its whole definition, starting with \`module ${name}(\`, or empty to delete it.`,
        }
      }
      const span = moduleSpan(lines, name)
      if (span) lines = [...lines.slice(0, span.start), ...body, ...lines.slice(span.end + 1)]
      else if (body.length === 0) return { error: `There is no module ${name} in the current source to delete.` }
      else lines = [...lines, '', ...body]
      continue
    }
    const known = sections(lines)
    const span = known.get(block.target)
    if (span) {
      // An unclosed section has no END line to keep: write one.
      const tail = span.unclosed ? [closeMarker(block.target)] : lines.slice(span.end)
      lines =
        body.length === 0
          ? [...lines.slice(0, span.start), ...lines.slice(span.end + 1)]
          : [...lines.slice(0, span.start + 1), ...body, ...tail]
      continue
    }
    const last = Math.max(0, ...known.keys())
    if (block.target !== last + 1 || body.length === 0) {
      return {
        error: `Part ${block.target} is not in the current source, which has ${last === 0 ? 'no PART sections' : `PART 1 to ${last}`}. Send part ${last + 1} to add one, or the complete source.`,
      }
    }
    lines = [...lines, '', openMarker(block.target), ...body, closeMarker(block.target)]
  }
  return { source: renumber(lines).join('\n') }
}

/** Markers numbered by order of appearance, pairs kept together. */
function renumber(lines: readonly string[]): string[] {
  let next = 0
  let current = 0
  return lines.map((line) => {
    const m = MARKER.exec(line)
    if (!m) return line
    if (!m[2]) current = ++next
    return m[2] ? closeMarker(current) : openMarker(current)
  })
}

/**
 * What the convention cannot survive: a section with no top-level call puts
 * nothing in the viewport, a call outside every section shifts the numbering,
 * and a module nobody calls is a part the model forgot to place.
 * ponytail: a line scanner that strips // comments and counts brackets — no
 * strings, no block comments. Good enough to catch the model's habits.
 */
export function checkParts(source: string): string[] {
  const lines = source.split('\n')
  const spans = sections(lines)
  const owner = new Array<number>(lines.length).fill(0)
  for (const [part, { start, end }] of spans) for (let i = start; i <= end; i++) owner[i] = part
  // Construction lines are nobody's part: -1 keeps them out of the "outside" count.
  const construction = constructionSpan(lines)
  const unguarded: number[] = []
  if (construction) {
    for (let i = construction.start; i <= construction.end; i++) owner[i] = -1
  }
  const calls = new Map<number, number>()
  const modules: { name: string; part: number }[] = []
  let depth = 0
  const stripped: string[] = []
  for (const [i, raw] of lines.entries()) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    stripped.push(line)
    if (depth === 0 && line !== '') {
      const mod = /^module\s+([\w$]+)/.exec(line)
      if (mod) modules.push({ name: mod[1]!, part: owner[i]! })
      else if (!/^(function\b|use\b|include\b|[\w$]+\s*=)/.test(line) && !/^[)}\]]/.test(line)) {
        calls.set(owner[i]!, (calls.get(owner[i]!) ?? 0) + 1)
        // A construction statement without % is a part that prints: the one
        // mistake this section exists to prevent.
        if (owner[i] === -1 && !line.startsWith('%') && !/^[)}\]]/.test(line)) unguarded.push(i + 1)
      }
    }
    for (const ch of line) depth += '{(['.includes(ch) ? 1 : '})]'.includes(ch) ? -1 : 0
  }
  const out = strayMarkers(lines)
  for (const part of [...spans.keys()].sort((a, b) => a - b)) {
    if (!calls.has(part)) out.push(`PART ${part} has no top-level call, so it puts nothing in the viewport.`)
  }
  if (spans.size > 0 && calls.has(0)) {
    out.push('A top-level call sits outside the PART sections; every part belongs inside one, or the viewport numbering is off.')
  }
  if (unguarded.length > 0) {
    out.push(`CONSTRUCTION line${unguarded.length > 1 ? 's' : ''} ${unguarded.join(', ')} lack${unguarded.length > 1 ? '' : 's'} the % modifier, so that geometry would print. Every construction statement starts with %.`)
  }
  const all = stripped.join('\n')
  for (const { name, part } of modules) {
    const uses = all.match(new RegExp(`\\b${name.replace('$', '\\$')}\\s*\\(`, 'g'))?.length ?? 0
    if (uses < 2) out.push(`module ${name}() (${part ? `PART ${part}` : 'outside the parts'}) is never called.`)
  }
  return out
}
