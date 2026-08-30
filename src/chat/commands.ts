export type Command =
  | { name: 'clear' }
  | { name: 'compact' }
  | { name: 'export'; format: 'binstl' | '3mf' }
  | { name: 'model'; id: string | null }
  | { name: 'key' }
  | { name: 'unknown'; word: string }

/**
 * A command is a leading slash glued to one whole word: `/ clear`, `//`, `1/2`
 * and `/usr/local/bin` are prose, and prose is what the model gets. `/undo` is
 * deliberately absent — it needs Milestone 3's version timeline, and a stub
 * that half-works is worse than an honest "unknown command".
 */
const COMMAND = /^\/(\w+)(?:\s+(.*))?$/s

export function parseCommand(text: string): Command | null {
  const match = COMMAND.exec(text.trim())
  if (!match) return null

  const word = match[1]!.toLowerCase()
  const arg = (match[2] ?? '').trim()

  switch (word) {
    case 'clear':
      return { name: 'clear' }
    case 'compact':
      return { name: 'compact' }
    case 'key':
      return { name: 'key' }
    case 'model':
      // Not lowercased: model ids are case-sensitive slugs.
      return { name: 'model', id: arg || null }
    case 'export':
      // 3mf is the default because it carries units; anything else is only
      // ever the other button, so an unreadable argument falls back rather
      // than erroring at someone who typed `/export mesh`.
      return { name: 'export', format: /^(bin)?stl$/i.test(arg) ? 'binstl' : '3mf' }
    default:
      return { name: 'unknown', word }
  }
}
