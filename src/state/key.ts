import type { Host } from '../llm/openrouter'

/**
 * The API key, alone, in its own record and its own module. It is never a member
 * of any settings object, so nothing that exports or logs settings can carry it.
 */
const RECORD = 'vibe3d.key'
/** ponytail: the pre-rename record. Delete once no browser can still hold it. */
const LEGACY = 'aimodeller.key'

/** One key per host, so switching hosts never throws a key away. OpenRouter keeps the original record. */
const recordOf = (host: Host): string => (host === 'openrouter' ? RECORD : `${RECORD}.${host}`)

/** '' when absent or unreadable — see loadSettings for why this cannot throw. */
export function loadKey(host: Host = 'openrouter'): string {
  try {
    return localStorage.getItem(recordOf(host)) ?? (host === 'openrouter' ? localStorage.getItem(LEGACY) : null) ?? ''
  } catch {
    return ''
  }
}

export function saveKey(key: string, host: Host = 'openrouter'): void {
  try {
    localStorage.setItem(recordOf(host), key)
  } catch {
    // Private mode or a full quota. The key still works for this session.
  }
}
