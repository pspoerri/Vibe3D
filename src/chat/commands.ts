import type { DownloadFormat } from '../export/download'
import { THINKING, type Thinking } from '../state/settings'

export type Command =
  | { name: 'clear' }
  | { name: 'compact' }
  | { name: 'export'; format: DownloadFormat }
  | { name: 'model'; id: string | null }
  | { name: 'think'; level: Thinking | null }
  | { name: 'key' }
  | { name: 'undo' }
  | { name: 'help' }
  | { name: 'unknown'; word: string }

/**
 * The one list of commands: /help prints it, the menu bar shows it on hover,
 * and the manual renders it. commands.test.ts checks every usage still parses.
 */
export const COMMANDS: readonly { usage: string; what: string }[] = [
  { usage: '/help', what: 'This list.' },
  { usage: '/clear', what: 'A new conversation about the same part. Source and versions stay.' },
  { usage: '/compact', what: 'Summarise the conversation to free context. Also fires by itself at 60%.' },
  { usage: '/undo', what: 'Step the document back one version.' },
  { usage: '/export [3mf|stl|obj]', what: 'Download the part. 3MF unless you say otherwise.' },
  { usage: '/model [id]', what: 'Switch model, or open the settings without an id.' },
  {
    usage: '/think [off|low|medium|high]',
    what: 'How hard the model thinks. Off is one call per message; any other level lets it look, cut and correct until it is satisfied.',
  },
  { usage: '/key', what: 'Open the settings to change the API key.' },
]

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
    case 'help':
      return { name: 'help' }
    case 'model':
      // Not lowercased: model ids are case-sensitive slugs.
      return { name: 'model', id: arg || null }
    case 'think': {
      const level = arg.toLowerCase() as Thinking
      return { name: 'think', level: THINKING.includes(level) ? level : null }
    }
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
