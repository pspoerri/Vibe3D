import { createStore, get, getMany, setMany } from 'idb-keyval'

/**
 * A named database rather than idb-keyval's default `keyval-store`, which is
 * shared with every other library on the origin that never named its own.
 */
const store = createStore('vibe3d', 'state')
const RECORD = 'session'
const SOURCE_RECORD = 'lastSource'

/**
 * `unknown` on purpose: what comes back was written by some older version of
 * this app, or by a store a browser corrupted, so only the caller's parser may
 * say what it is.
 *
 * Never rejects, and the `try` has to wrap the `await` rather than be a
 * `.catch()` — idb-keyval opens the database inside this call, so a browser
 * with site data blocked throws synchronously. This runs during App boot, where
 * e2e/smoke.spec.ts asserts zero page errors.
 */
export async function loadSession(): Promise<unknown> {
  try {
    return await get(RECORD, store)
  } catch {
    return undefined
  }
}

/**
 * Both records in ONE transaction. Written separately, a quota failure or a
 * crash between the two puts could land the newer source beside a stale
 * session — and the stale one revives cleanly, so the newer source would be
 * discarded in silence. setMany is atomic: if one pair cannot be written,
 * neither is.
 */
export async function saveSession(session: unknown, source: string): Promise<void> {
  try {
    await setMany(
      [
        [RECORD, session],
        [SOURCE_RECORD, source],
      ],
      store,
    )
  } catch {
    // Private mode, a full quota, or an evicted store. The caller has nothing
    // useful to do about it and the session in memory is still intact.
  }
}

/**
 * The boolean is the point (design.md §7): persistence is granted on the
 * browser's own heuristics and denied silently, so report what was actually
 * granted, not that the request was made. `false` also covers the older Safaris
 * and every non-secure context, where the API is simply absent.
 */
export async function persistRequested(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

/**
 * The recovery lane, and the reason it is separate from the session record.
 *
 * The session is a structure: a version of this app that writes it differently,
 * or a half-completed write, can leave a blob that reviveSession refuses — and
 * refusing correctly still means the user opens the app and finds the starter
 * document where their part used to be. This record is one string with no shape
 * to get wrong, written on the same debounce, and it is what the session's
 * revive falls back to. Losing the document LIST is an inconvenience; losing
 * the last source is losing the work.
 */
export async function loadLastSource(): Promise<string | null> {
  try {
    const source = await get(SOURCE_RECORD, store)
    return typeof source === 'string' && source.trim() !== '' ? source : null
  } catch {
    return null
  }
}

/** Both records at once, so boot cannot read a torn pair. */
export async function loadAll(): Promise<{ session: unknown; lastSource: string | null }> {
  try {
    const [session, source] = await getMany([RECORD, SOURCE_RECORD], store)
    return {
      session,
      lastSource: typeof source === 'string' && source.trim() !== '' ? source : null,
    }
  } catch {
    return { session: undefined, lastSource: null }
  }
}
