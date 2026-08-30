/**
 * Several OpenSCAD documents and which one is open, as plain data. Everything
 * that decides anything lives here rather than next to the IndexedDB calls,
 * because Node has no indexedDB and a rule that cannot be tested is a rule that
 * drifts (design.md §7).
 */
export interface Doc {
  /** A uuid. Opaque: nothing derives meaning from it, and nothing counts on it. */
  id: string
  name: string
  source: string
  createdAt: number
  updatedAt: number
  /**
   * The document this one was forked from, or null for a first draft.
   *
   * design.md §7: a linear list whose nodes record their parent already IS the
   * tree, so a "version" here is just another document that remembers where it
   * came from. No separate timeline, no separate storage, and the thing the
   * user actually asked to keep — the source — is recoverable by opening it.
   */
  parentId: string | null
  /**
   * The name is settled — either the user typed it or a prompt produced it — so
   * nothing auto-names over it again. A name merely derived from the source is
   * a placeholder and carries no flag.
   */
  named?: true
}

export interface Session {
  docs: Doc[]
  /** Resolvable against `docs` for every session this module hands back. */
  currentId: string
}

export function newDoc(
  name: string,
  source: string,
  id: string,
  now: number,
  parentId: string | null = null,
): Doc {
  return { id, name, source, createdAt: now, updatedAt: now, parentId }
}

export function createSession(source: string, id: string, now: number): Session {
  return { docs: [newDoc(suggestName(source, []), source, id, now)], currentId: id }
}

export function selectDoc(session: Session, id: string): Session {
  // An id from a stale row must not point the session at nothing.
  return session.docs.some((d) => d.id === id) ? { ...session, currentId: id } : session
}

/**
 * Returns the session itself when the text is unchanged: the editor re-reports
 * its content on every keystroke and every rehydrate, and a bumped timestamp
 * there would have an idle autosave rewriting the store forever.
 */
export function updateSource(session: Session, source: string, now: number): Session {
  const doc = currentDoc(session)
  if (doc.source === source) return session
  // currentDoc can synthesise a document for a session with no rows, and that
  // id matches nothing — so the map below would silently discard what the user
  // just typed. Adopt it instead.
  if (!session.docs.some((d) => d.id === doc.id)) {
    return { docs: [...session.docs, { ...doc, source, updatedAt: now }], currentId: doc.id }
  }
  return {
    ...session,
    docs: session.docs.map((d) => (d.id === doc.id ? { ...d, source, updatedAt: now } : d)),
  }
}

/** Leaves `updatedAt` alone — it orders the list by work done, not by titling. */
export function renameDoc(session: Session, id: string, name: string): Session {
  const trimmed = name.trim()
  // A blank row is indistinguishable from its neighbours, so it is not a name.
  if (trimmed === '') return session
  return {
    ...session,
    // `named` is what stops the next prompt renaming a title the user chose.
    docs: session.docs.map((d) => (d.id === id ? { ...d, name: trimmed, named: true } : d)),
  }
}

/**
 * Name the current document after the prompt that produced it, unless the user
 * has titled it themselves. Only an untitled document is renamed, and only
 * once: the first prompt describes the part, while later ones are edits to it
 * ("make it 2 mm taller" is a poor title for a knob).
 */
export function nameFromFirstPrompt(session: Session, prompt: string): Session {
  const doc = currentDoc(session)
  if (doc.named) return session
  const taken = session.docs.filter((d) => d.id !== doc.id).map((d) => d.name)
  const name = nameFromPrompt(prompt, taken)
  if (name === UNTITLED) return session
  return {
    ...session,
    docs: session.docs.map((d) => (d.id === doc.id ? { ...d, name, named: true } : d)),
  }
}

/**
 * A new version: the same source, forked off the document it came from and
 * selected. Versions are documents, so the source of every one of them stays
 * openable — which is the whole recovery guarantee.
 */
export function forkDoc(session: Session, id: string, newId: string, now: number): Session {
  const from = session.docs.find((d) => d.id === id)
  // A reused id is the duplicate-row bug by another route: a caller that
  // memoises its uuid would give two documents one identity.
  if (!from || session.docs.some((d) => d.id === newId)) return session
  const copy: Doc = {
    ...from,
    id: newId,
    // Deduped, and NOT inheriting `named`: three rows all reading "Bracket" is
    // the exact failure the list exists to prevent, and inheriting the flag
    // would make it permanent by stopping any later rename.
    name: dedupe(from.name, session.docs.map((d) => d.name)),
    named: undefined,
    createdAt: now,
    updatedAt: now,
    parentId: from.id,
  }
  return { docs: [...session.docs, copy], currentId: newId }
}

/**
 * Documents grouped by the root they descend from, each family ordered oldest
 * first. Roots are memoised as the walk proceeds, so a long chain is not
 * re-walked per row: numbering a list one document at a time was O(n^3), which
 * is 130 ms at the 200 versions design.md §7 sizes for, on a path that runs on
 * every render.
 */
function families(session: Session): Map<string, Doc[]> {
  const byId = new Map(session.docs.map((d) => [d.id, d]))
  const roots = new Map<string, string>()

  const rootOf = (doc: Doc): string => {
    const path: Doc[] = []
    const seen = new Set<string>()
    let node = doc
    for (;;) {
      const known = roots.get(node.id)
      if (known !== undefined) {
        node = byId.get(known) ?? node
        break
      }
      // `seen` guards a parentId cycle, which a corrupt store can hand us.
      if (node.parentId === null || seen.has(node.id)) break
      seen.add(node.id)
      const parent = byId.get(node.parentId)
      if (!parent) break
      path.push(node)
      node = parent
    }
    for (const step of path) roots.set(step.id, node.id)
    roots.set(doc.id, node.id)
    return node.id
  }

  const grouped = new Map<string, Doc[]>()
  for (const doc of session.docs) {
    const root = rootOf(doc)
    const family = grouped.get(root)
    if (family) family.push(doc)
    else grouped.set(root, [doc])
  }
  for (const family of grouped.values()) {
    // Ordered by creation rather than by tree depth, so two forks of the same
    // parent get distinct numbers instead of two rows both labelled v2.
    family.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }
  return grouped
}

/**
 * Every document's version number in one pass — the shape the UI should call.
 * A document with no siblings is absent: it carries no version tag.
 */
export function versionNumbers(session: Session): Map<string, number> {
  const numbers = new Map<string, number>()
  for (const family of families(session).values()) {
    if (family.length < 2) continue
    family.forEach((doc, i) => numbers.set(doc.id, i + 1))
  }
  return numbers
}

/** Every document descending from the same root, oldest first. */
export function versionFamily(session: Session, id: string): Doc[] {
  for (const family of families(session).values()) {
    if (family.some((d) => d.id === id)) return family
  }
  return []
}

/** 1-based position in the family, or 0 when the document stands alone. */
export function versionNumber(session: Session, id: string): number {
  return versionNumbers(session).get(id) ?? 0
}

/**
 * `freshId` is spent only when the doomed document was the last one: an empty
 * document list has no editor to show and no obvious way back, so deleting
 * everything lands on a blank document instead of on nothing.
 */
export function deleteDoc(session: Session, id: string, freshId: string, now: number): Session {
  const index = session.docs.findIndex((d) => d.id === id)
  if (index < 0) return session
  const doomed = session.docs[index]!
  // Children are reparented onto the grandparent. Without this, deleting a
  // middle version leaves its children pointing at a document that no longer
  // exists — every row loses its version tag, and revive rewrites that dangling
  // parentId to null on the next load, so the lineage cannot be repaired even
  // by restoring the deleted row.
  const docs = session.docs
    .filter((d) => d.id !== id)
    .map((d) => (d.parentId === id ? { ...d, parentId: doomed.parentId } : d))
  // The row that slid into the gap, else the one above it.
  const neighbour = docs[index] ?? docs[index - 1]
  if (!neighbour) return createSession('', freshId, now)
  return { docs, currentId: session.currentId === id ? neighbour.id : session.currentId }
}

/**
 * Total on purpose. A caller that cannot get a document shows a blank editor
 * over a part that still exists, which reads as data loss; revive guarantees
 * the first fallback, and the second only fires on a hand-built empty session.
 */
export function currentDoc(session: Session): Doc {
  return (
    session.docs.find((d) => d.id === session.currentId) ??
    session.docs[0] ??
    newDoc(UNTITLED, '', session.currentId, 0)
  )
}

function reviveDoc(raw: unknown, now: number, taken: string[] = []): Doc | null {
  const d = raw as Partial<Doc> | null
  // id and source are the document; a row missing either has nothing to restore.
  if (typeof d?.id !== 'string' || typeof d.source !== 'string') return null
  const updatedAt = typeof d.updatedAt === 'number' ? d.updatedAt : now
  return {
    id: d.id,
    // Deduped against the rows already revived: recovery is exactly where the
    // user is working out what survived, so two identical labels are worst here.
    name: pushName(
      typeof d.name === 'string' && d.name !== '' ? d.name : suggestName(d.source, taken),
      taken,
    ),
    source: d.source,
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : updatedAt,
    updatedAt,
    // A parentId naming a document that did not survive revive would strand the
    // row outside every family, so only a resolvable one is kept — and that is
    // checked by the caller, which is the only place the full list exists.
    parentId: typeof d.parentId === 'string' ? d.parentId : null,
    ...(d.named === true ? { named: true as const } : {}),
  }
}

/**
 * The trust boundary. What comes back out of IndexedDB is whatever an older
 * version of this app, a half-finished write or a corrupt store left there, so
 * nothing about its shape is assumed and nothing here throws.
 *
 * Well-formed rows survive even when their neighbours do not, and a currentId
 * that no longer resolves is repaired rather than treated as fatal: throwing
 * away readable documents over a stale pointer is the one outcome worse than
 * starting empty.
 */
export function reviveSession(
  raw: unknown,
  fallbackSource: string,
  id: string,
  now: number,
): Session {
  const s = raw as { docs?: unknown; currentId?: unknown } | null
  const rows: unknown[] = Array.isArray(s?.docs) ? s.docs : []
  // Deduped by id: two rows sharing one means editing the first destroys the
  // second's source, and deleting either removes BOTH — which can empty the
  // whole list and replace the user's library with one blank document.
  const named: string[] = []
  const parsed = rows.map((row) => reviveDoc(row, now, named)).filter((doc) => doc !== null)
  const docs = [...new Map(parsed.map((doc) => [doc.id, doc])).values()]
  const first = docs[0]
  if (!first) return createSession(fallbackSource, id, now)
  const ids = new Set(docs.map((d) => d.id))
  // Drop a parent that did not survive: an unresolvable one would put the row
  // in a family of its own while still claiming a lineage.
  const linked = docs.map((d) => (d.parentId !== null && !ids.has(d.parentId) ? { ...d, parentId: null } : d))
  const wanted = s?.currentId
  const found = typeof wanted === 'string' && ids.has(wanted)
  return { docs: linked, currentId: found ? wanted : first.id }
}

const MAX_NAME = 40
export const UNTITLED = 'Untitled'

/**
 * What people put in front of the thing they actually want. Stripped so the
 * name is the part, not the request: "make me a knurled knob" titles a row
 * "Knurled knob".
 */
const LEAD_IN =
  /^(?:please\s+)?(?:could you\s+|can you\s+)?(?:(?:make|create|build|design|draw|model|generate|give)\s+(?:me\s+)?)?(?:an?|the)(?:\s+|$)/i

/**
 * A document's name comes from the prompt that produced it: the user's own
 * words for the part beat anything derived from the source, which is why
 * suggestName is now only the fallback for a document nobody prompted for.
 */
export function nameFromPrompt(prompt: string, taken: readonly string[]): string {
  const cleaned = prompt.replace(/\s+/g, ' ').trim().replace(LEAD_IN, '')
  if (cleaned === '') return UNTITLED
  let name = cleaned
  if (name.length > MAX_NAME) {
    const cut = name.slice(0, MAX_NAME)
    const space = cut.lastIndexOf(' ')
    name = `${(space > MAX_NAME / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
  }
  name = name.charAt(0).toUpperCase() + name.slice(1)
  return dedupe(name, taken)
}

/** Own-line `//` comments only: a trailing `// [20:120]` is a slider range. */
const HEADING = /^[ \t]*\/\/[ \t]*(\S.*?)[ \t]*$/m
const DECLARATION = /^[ \t]*(?:module|function)[ \t]+([A-Za-z_]\w*)/m

function derive(source: string): string {
  const heading = HEADING.exec(source)?.[1]
  if (heading === undefined) return DECLARATION.exec(source)?.[1] ?? UNTITLED
  // A header comment is a sentence written at the reader, not a title, so the
  // first sentence of it is what a list column has room for.
  const sentence = heading.split('. ')[0] ?? heading
  if (sentence.length <= MAX_NAME) return sentence
  return `${sentence.slice(0, MAX_NAME).trimEnd()}…`
}

/**
 * The list is the only way the user tells two documents apart, so a derived
 * name that collides is worse than no derived name at all.
 */
export function suggestName(source: string, taken: readonly string[]): string {
  return dedupe(derive(source), taken)
}

/** Records the name it hands back, so the next row is deduped against it too. */
function pushName(name: string, taken: string[]): string {
  const unique = dedupe(name, taken)
  taken.push(unique)
  return unique
}

function dedupe(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base} ${n}`)) n++
  return `${base} ${n}`
}
