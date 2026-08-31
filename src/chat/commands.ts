import type { DownloadFormat } from '../export/download'

export type Command =
  | { name: 'clear' }
  | { name: 'compact' }
  | { name: 'export'; format: DownloadFormat }
  | { name: 'model'; id: string | null }
  | { name: 'key' }
  | { name: 'undo' }
  | { name: 'unknown'; word: string }

/**
 * A command is a leading slash glued to one whole word: `/ clear`, `//`, `1/2`
 * and `/usr/local/bin` are prose, and prose is what the model gets. `/undo`
 * steps the document back one version (design.md §10).
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
    case 'undo':
      return { name: 'undo' }
    case 'model':
      // Not lowercased: model ids are case-sensitive slugs.
      return { name: 'model', id: arg || null }
    case 'export':
      // 3mf is the default because it carries units; an unreadable argument
      // falls back to it rather than erroring at someone who typed `/export mesh`.
      return {
        name: 'export',
        format: /^(bin)?stl$/i.test(arg) ? 'binstl' : /^obj$/i.test(arg) ? 'obj' : '3mf',
      }
    default:
      return { name: 'unknown', word }
  }
}
