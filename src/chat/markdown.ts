export type Inline = { text: string; code?: true; strong?: true; em?: true }

export type Block =
  | { kind: 'paragraph'; spans: Inline[] }
  | { kind: 'heading'; spans: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; lang: string; lines: number }

/** Column-anchored, like fence.ts: an indented ``` is body text, not a fence. */
const OPEN_FENCE = /^```(.*)$/
const CLOSE_FENCE = /^```\s*$/
/** One to three, which is all a chat reply emits; a deeper run stays prose. */
const HEADING = /^#{1,3} +(.*)$/
/** The space is required, or a line opening with *emphasis* becomes a bullet. */
const ITEM = /^([-*]|\d+\.) +(.*)$/
/**
 * A final line that is nothing but a marker is a list item mid-arrival, not a
 * paragraph. Without this the '-' of '- the wall is 2 mm' renders as its own
 * paragraph for the one frame before its space arrives, then vanishes into the
 * list — a flicker in the transcript at ten frames a second.
 */
const PENDING_ITEM = /^([-*]|\d+\.)$/

const MARKS = [
  ['`', { code: true }],
  ['**', { strong: true }],
  ['*', { em: true }],
] as const

/**
 * Single pass, closing delimiter by indexOf: the pathological inputs a model
 * can emit — a line of a thousand asterisks, an unclosed run of backticks — are
 * one linear scan here, where a nested-alternation regex would backtrack and
 * freeze the tab. Nothing recurses: `**bold `code`**` renders bold with literal
 * backticks, which is a worse render of a thing models do not write.
 */
function inline(text: string): Inline[] {
  const spans: Inline[] = []
  let plain = ''

  for (let i = 0; i < text.length; ) {
    const mark = MARKS.find(([m]) => text.startsWith(m, i))
    const close = mark ? text.indexOf(mark[0], i + mark[0].length) : -1
    const body = mark && close >= 0 ? text.slice(i + mark[0].length, close) : ''
    // Unmatched, empty, or padded: a delimiter only marks up text it hugs, so
    // "20 * 30 * 2 mm" is arithmetic and stays literal. Code is exempt — its
    // whole point is verbatim content.
    if (!mark || body === '' || (mark[0] !== '`' && body !== body.trim())) {
      plain += text.charAt(i)
      i += 1
      continue
    }
    if (plain !== '') spans.push({ text: plain })
    plain = ''
    spans.push({ text: body, ...mark[1] })
    i = close + mark[0].length
  }

  if (plain !== '') spans.push({ text: plain })
  return spans
}

/**
 * Blocks only; the React layer renders them. Called on EVERY streamed frame
 * against a prefix of the reply, so a block is emitted as soon as its opening
 * line arrives and is never taken back.
 *
 * CRLF is normalised here for the same reason fence.ts does it at its own
 * ingest: a trailing \r would otherwise ride along in a lang string and in
 * every span.
 */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let list: Extract<Block, { kind: 'list' }> | null = null
  let code: Extract<Block, { kind: 'code' }> | null = null

  const flush = (): void => {
    if (para.length > 0) blocks.push({ kind: 'paragraph', spans: inline(para.join(' ')) })
    para = []
    list = null
  }

  const lines = text.replaceAll('\r\n', '\n').split('\n')
  // Only the last line can be half-written, and only when no newline follows it.
  if (PENDING_ITEM.test(lines[lines.length - 1] ?? '')) lines.pop()

  for (const line of lines) {
    if (code !== null) {
      if (CLOSE_FENCE.test(line)) code = null
      else code.lines += 1
      continue
    }

    const fence = OPEN_FENCE.exec(line)
    if (fence !== null) {
      flush()
      // Pushed the moment the fence opens: an unclosed fence is the streaming
      // case, and the alternative is a paragraph of backticks that becomes a
      // code block a frame later.
      code = { kind: 'code', lang: fence[1]!.trim(), lines: 0 }
      blocks.push(code)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      flush()
      blocks.push({ kind: 'heading', spans: inline(heading[1]!) })
      continue
    }

    const item = ITEM.exec(line)
    if (item !== null) {
      // The first marker decides: a run that mixes '-' and '1.' is not drawing
      // a distinction worth a second block.
      if (list === null) {
        flush()
        list = { kind: 'list', ordered: item[1]!.endsWith('.'), items: [] }
        blocks.push(list)
      }
      list.items.push(inline(item[2]!))
      continue
    }

    if (line.trim() === '') flush()
    else {
      // A list ends at the first line that is not an item: continuation lines
      // are a nesting model this parser deliberately does not have.
      if (list !== null) flush()
      para.push(line.trim())
    }
  }

  flush()
  return blocks
}
