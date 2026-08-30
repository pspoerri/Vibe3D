export interface ParamRange {
  min: number
  max: number
  step: number
}

export interface ParamOption {
  value: string | number
  label: string
}

interface ParamBase {
  name: string
  caption: string
  group: string
  /**
   * Byte offsets of the VALUE LITERAL only. Substitution is
   * src.slice(0, start) + literal + src.slice(end), so the trailing annotation
   * comment (which lives after the `;`) is untouched by construction.
   */
  start: number
  end: number
}

export type Param = ParamBase &
  (
    | { kind: 'number'; value: number; range: ParamRange | null }
    | { kind: 'bool'; value: boolean }
    | { kind: 'enum'; value: string | number; options: readonly ParamOption[] }
  )

/** Reduced facet count during a drag. */
export const DRAG_FN = 16

const DEFAULT_GROUP = 'Parameters'
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const NAME = /^\$?[A-Za-z_]\w*$/

const isNumber = (text: string): boolean => NUMBER.test(text)

interface Analysis {
  /**
   * `source` with comment bodies, string bodies and everything nested inside a
   * bracket blanked to spaces. Offsets and newlines are preserved, so a regex
   * over it sees exactly the top-level statements and nothing else — that is
   * what makes a name inside a string, a comment or a module body unreachable.
   */
  code: string
  /** Line of the first `{` outside a comment. Collection stops there. */
  stopLine: number
  /** Per line: the trailing `//` text when it qualifies as an annotation. */
  annotation: (string | null)[]
  /** Per line: the text of a `//` comment starting at column 0. */
  caption: (string | null)[]
  /** Per line: the group in force, or null while `[Hidden]` suppresses. */
  group: (string | null)[]
}

function analyse(source: string): Analysis {
  const code: string[] = []
  const annotation: (string | null)[] = []
  const caption: (string | null)[] = []
  const group: (string | null)[] = []

  let state: 'code' | 'line' | 'block' | 'string' = 'code'
  let line = 0
  let lineStart = 0
  let depth = 0
  let stopLine = Number.POSITIVE_INFINITY
  let inGroup: string | null = DEFAULT_GROUP
  let pending: string | null | undefined
  let firstSemi = -1
  let secondSemi = -1
  let commentAt = -1
  let blockLine = -1
  let blockBody = 0
  let i = 0

  const put = (ch: string) => code.push(ch === '\n' ? ch : depth === 0 ? ch : ' ')

  const endLine = (end: number) => {
    // The annotation lexer starts after the assignment's `;` and gives up when
    // it meets a second one, which is why two assignments on a line share none.
    annotation[line] =
      firstSemi >= 0 && commentAt > firstSemi && secondSemi < 0
        ? source.slice(commentAt + 2, end)
        : null
    caption[line] = commentAt === lineStart ? source.slice(commentAt + 2, end).trim() : null
    group[line] = inGroup
    // A header takes effect on the NEXT line, so `/* [Lid] */ a=1;` leaves
    // `a` in the previous group.
    if (pending !== undefined) inGroup = pending
    pending = undefined
    firstSemi = -1
    secondSemi = -1
    commentAt = -1
    line++
    lineStart = end + 1
  }

  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]

    if (state === 'line' || state === 'block') {
      if (state === 'block' && ch === '*' && next === '/') {
        // Only a header opened and closed on one line counts, and only its
        // bracketed words: `/* [Lid] [Inner] */` is the group `Lid-Inner`.
        if (blockLine === line) {
          const words = [...source.slice(blockBody, i).matchAll(/\[([^\]]*)\]/g)].map((m) =>
            m[1]!.trim(),
          )
          if (words.length > 0) pending = words.includes('Hidden') ? null : words.join('-')
        }
        state = 'code'
        code.push(' ', ' ')
        i += 2
        continue
      }
      if (ch === '\n') {
        code.push(ch)
        endLine(i)
        if (state === 'line') state = 'code'
      } else {
        code.push(' ')
      }
      i++
      continue
    }

    if (state === 'string') {
      if (ch === '\\' && next !== undefined) {
        code.push(' ', ' ')
        i += 2
        continue
      }
      if (ch === '"') {
        state = 'code'
        put(ch)
        i++
        continue
      }
      // Reproduced on purpose: the upstream brace test is not guarded by the
      // in-string flag, so `s = "{";` really does stop collection.
      if (ch === '{') stopLine = Math.min(stopLine, line)
      if (ch === '\n') endLine(i)
      code.push(ch === '\n' ? ch : ' ')
      i++
      continue
    }

    if (ch === '/' && (next === '/' || next === '*')) {
      state = next === '/' ? 'line' : 'block'
      if (next === '/') commentAt = i
      else {
        blockLine = line
        blockBody = i + 2
      }
      code.push(' ', ' ')
      i += 2
      continue
    }
    if (ch === '"') {
      state = 'string'
      put(ch)
      i++
      continue
    }
    if (ch === '{') stopLine = Math.min(stopLine, line)
    if (ch === ';' && depth === 0) {
      if (firstSemi < 0) firstSemi = i
      else if (secondSemi < 0) secondSemi = i
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      put(ch)
      depth++
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1)
      put(ch)
    } else {
      if (ch === '\n') endLine(i)
      put(ch)
    }
    i++
  }
  endLine(source.length)

  return { code: code.join(''), stopLine, annotation, caption, group }
}

/** A literal, and only a literal: `a = 1+2;` and `a = undef;` are not params. */
const LITERAL = String.raw`"[^"\n]*"|\[[^\]\n]*\]|true|false|[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`
// The leading lookbehind is what keeps the match in top-level statement
// position — `>` is there for the statement after a `use <>` / `include <>`.
const ASSIGN = new RegExp(
  String.raw`(?<![^ \t;}>\n])(\$?[A-Za-z_]\w*)([ \t]*=\s*)(${LITERAL})\s*;`,
  'g',
)

type Annotation =
  | { kind: 'range'; min: number; max: number; step: number }
  | { kind: 'options'; options: ParamOption[] }

/** Splits on the commas that are not inside a quoted option value. */
function splitOptions(content: string): string[] {
  const items: string[] = []
  let current = ''
  let quoted = false
  for (const ch of content) {
    if (ch === '"') quoted = !quoted
    if (ch === ',' && !quoted) {
      items.push(current)
      current = ''
      continue
    }
    current += ch
  }
  return [...items, current].map((item) => item.trim()).filter((item) => item !== '')
}

function parseOption(item: string): ParamOption {
  if (item.startsWith('"')) {
    const close = item.indexOf('"', 1)
    const value = item.slice(1, close < 0 ? undefined : close)
    const label = item.slice(close + 1).replace(/^\s*:/, '').trim()
    return { value, label: label || value }
  }
  const [head = '', ...rest] = item.split(':')
  const text = head.trim()
  const label = rest.join(':').trim()
  return { value: isNumber(text) ? Number(text) : text, label: label || text }
}

/**
 * The whole comment must be the bracket expression: OpenSCAD's annotation lexer
 * fails on anything else, which is why `// [0:10] description`, `// [0:10];`
 * and a CRLF line ending (the trailing \r lexes as a WORD) all degrade to a
 * plain number.
 */
function parseAnnotation(text: string | null | undefined): Annotation | null {
  const bracket = text == null ? null : /^[ \t]*\[([^\]]*)\][ \t]*$/.exec(text)
  if (!bracket) return null
  const content = bracket[1]!
  const items = splitOptions(content)
  if (items.length >= 2) return { kind: 'options', options: items.map(parseOption) }

  const bits = content.split(':').map((bit) => bit.trim())
  if (!bits.every(isNumber)) return null
  const [a = '', b = '', c = ''] = bits
  if (bits.length === 1) return { kind: 'range', min: 0, max: Number(a), step: 1 }
  if (bits.length === 2) return { kind: 'range', min: Number(a), max: Number(b), step: 1 }
  if (bits.length === 3) return { kind: 'range', min: Number(a), max: Number(c), step: Number(b) }
  return null
}

const withCurrent = (options: ParamOption[], value: string | number): ParamOption[] =>
  options.some((option) => option.value === value)
    ? options
    : [{ value, label: String(value) }, ...options]

export function scanParams(source: string): Param[] {
  const { code, stopLine, annotation, caption, group } = analyse(source)

  // A re-assigned name yields ONE param, bound to its LAST assignment — which
  // is also why the stop-line test has to wait until every assignment is in.
  const found = new Map<string, { line: number; start: number; end: number }>()
  let cursor = 0
  let line = 0
  for (const match of code.matchAll(ASSIGN)) {
    for (; cursor < match.index; cursor++) if (code[cursor] === '\n') line++
    const start = match.index + match[1]!.length + match[2]!.length
    found.set(match[1]!, { line, start, end: start + match[3]!.length })
  }

  const params: Param[] = []
  for (const [name, at] of found) {
    const groupName = group[at.line]
    // $-prefixed names are OpenSCAD params, but the drag path appends its own
    // `-D $fn=` and the last -D for a name wins, so a $fn slider would silently
    // do nothing.
    if (at.line >= stopLine || groupName == null || name.startsWith('$')) continue

    const literal = source.slice(at.start, at.end)
    const base = {
      name,
      caption: caption[at.line - 1] ?? '',
      group: groupName,
      start: at.start,
      end: at.end,
    }
    if (literal === 'true' || literal === 'false') {
      params.push({ ...base, kind: 'bool', value: literal === 'true' })
      continue
    }
    const anno = parseAnnotation(annotation[at.line])
    if (isNumber(literal)) {
      const value = Number(literal)
      if (anno?.kind === 'options') {
        params.push({ ...base, kind: 'enum', value, options: withCurrent(anno.options, value) })
      } else {
        params.push({
          ...base,
          kind: 'number',
          value,
          // The current value widens the declared bounds rather than being
          // clamped into them.
          range: anno
            ? { min: Math.min(anno.min, value), max: Math.max(anno.max, value), step: anno.step }
            : null,
        })
      }
      continue
    }
    // Everything left is a vector or a string. A string with an option list is
    // a dropdown; a bare one is M2's dropped maxLength case, as is a vector.
    if (literal.startsWith('"') && anno?.kind === 'options') {
      const value = literal.slice(1, -1)
      params.push({ ...base, kind: 'enum', value, options: withCurrent(anno.options, value) })
    }
  }
  return params
}

export function formatLiteral(value: number | boolean | string): string {
  // JSON's string escapes are a subset of OpenSCAD's, so this round-trips.
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

export function setParam(source: string, param: Param, value: number | boolean | string): string {
  const next = source.slice(0, param.start) + formatLiteral(value) + source.slice(param.end)
  // The offsets came from a scan of some earlier document. Confirming the write
  // against a fresh scan is what stops a stale param corrupting this one.
  const written = scanParams(next).find((p) => p.name === param.name)
  if (written === undefined) return source
  // The type must survive too, and it is compared against the ORIGINAL param,
  // not against the requested value: `n = 1; // [1,2,3]` written with the
  // string '2' yields `n = "2";`, which scans back as the enum '2' and so
  // matches both the request and its type, while having quietly broken every
  // use of n.
  if (typeof written.value !== typeof param.value) return source
  return written.value === value ? next : source
}

export function defineFor(name: string, value: number | boolean | string): string {
  // `-D` text is spliced into the source and parsed: verified that
  // `-D 'wall=2; translate([50,0,0]) cube(1)'` injects an extra solid.
  if (!NAME.test(name)) throw new Error(`not a parameter name: ${JSON.stringify(name)}`)
  return `${name}=${formatLiteral(value)}`
}
