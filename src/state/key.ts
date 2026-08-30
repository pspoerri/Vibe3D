/**
 * The API key, alone, in its own record and its own module. It is never a member
 * of any settings object, so nothing that exports or logs settings can carry it.
 */
const RECORD = 'aimodeller.key'

/** '' when absent or unreadable — see loadSettings for why this cannot throw. */
export function loadKey(): string {
  try {
    return localStorage.getItem(RECORD) ?? ''
  } catch {
    return ''
  }
}

export function saveKey(key: string): void {
  try {
    localStorage.setItem(RECORD, key)
  } catch {
    // Private mode or a full quota. The key still works for this session.
  }
}
