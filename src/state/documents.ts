/**
 * Several OpenSCAD documents, each with its version timeline and transcript,
 * and which one is open — as plain data. Everything that decides anything lives
 * here rather than next to the IndexedDB calls, because Node has no indexedDB
 * and a rule that cannot be tested is a rule that drifts (design.md §7).
 */
import { reviveLog, stripImages, type ChatEvent } from '../chat/log'

export interface Version {
  /** '1', '2', … in commit order — unique within the document, and what the picker shows. */
  id: string
  /** The head at commit time: the version this one was made from. null for the first. */
  parentId: string | null
  ts: number
  /** The prompt that produced it, or EDIT / SAVED / 'new'. */
  label: string
  source: string
  /** True once this exact source was seen to compile. False means unverified, not broken. */
  compileOk: boolean
}

/**
 * A mesh file the source can `import()` by name (design.md §8). Bytes stay
 * bytes in IndexedDB — structured clone carries a Uint8Array — and become
 * base64 only in the project file. The box is measured at attach time by
 * compiling the import once, so the model can place the part by numbers.
 */
export interface Component {
  /** Safe as a file name and as an OpenSCAD string literal: see COMPONENT_NAME. */
  name: string
  bytes: Uint8Array
  min: [number, number, number]
  max: [number, number, number]
}

/** One plain path segment with a mesh extension: no slashes, no quotes, nothing the kernel FS or a string literal could misread. */
export const COMPONENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.(stl|obj|3mf|off)$/i

export interface Doc {
  /** A uuid. Opaque: nothing derives meaning from it, and nothing counts on it. */
  id: string
  name: string
  /**
   * The name is settled — either the user typed it or the first turn produced
   * it — so nothing auto-names over it again. A name merely derived from the
   * source, or lent by a prompt while its turn runs, is a placeholder and
   * carries no flag.
   */
  named?: true
  createdAt: number
  updatedAt: number
  /** The working copy — what the editor holds. Differs from the head only by uncommitted edits. */
  source: string
  /** Append-only, oldest first. Restore moves `head`; nothing is ever removed. */
  versions: Version[]
  head: string
  /** The transcript, images stripped (design.md §9). */
  chat: ChatEvent[]
  /** Mesh files the source may import, by name. Document-level: a version is source alone. */
  components: Component[]
}

export interface Session {
  docs: Doc[]
  /** Resolvable against `docs` for every session this module hands back. */
  currentId: string
}

export const EDIT = 'edit'
export const SAVED = 'saved'
const NEW = 'new'
const LABEL_MAX = 48

export function newDoc(name: string, source: string, id: string, now: number): Doc {
  const first: Version = { id: '1', parentId: null, ts: now, label: NEW, source, compileOk: false }
  return {
    id, name, source, createdAt: now, updatedAt: now, versions: [first], head: '1', chat: [], components: [],
  }
}

export function createSession(source: string, id: string, now: number): Session {
  return { docs: [newDoc(suggestName(source, []), source, id, now)], currentId: id }
}

export function selectDoc(session: Session, id: string): Session {
  // An id from a stale row must not point the session at nothing.
  return session.docs.some((d) => d.id === id) ? { ...session, currentId: id } : session
}

/** Total: revive guarantees a version, and the synthetic fallback covers a hand-built doc. */
export function headVersion(doc: Doc): Version {
  return (
    doc.versions.find((v) => v.id === doc.head) ??
    doc.versions[doc.versions.length - 1] ?? {
      id: '1',
      parentId: null,
      ts: doc.createdAt,
      label: NEW,
      source: doc.source,
      compileOk: false,
    }
  )
}

/**
 * Replaces the document — or adopts it: currentDoc can synthesise one for a
 * session with no rows, and an id that matches nothing would otherwise have the
 * map below silently discard what the user just typed.
 */
function withDoc(session: Session, doc: Doc): Session {
  return session.docs.some((d) => d.id === doc.id)
    ? { ...session, docs: session.docs.map((d) => (d.id === doc.id ? doc : d)) }
    : { docs: [...session.docs, doc], currentId: doc.id }
}

/**
 * Returns the session itself when the text is unchanged: the editor re-reports
 * its content on every keystroke and every rehydrate, and a bumped timestamp
 * there would have an idle autosave rewriting the store forever.
 */
export function updateSource(session: Session, source: string, now: number): Session {
  const doc = currentDoc(session)
  if (doc.source === source) return session
  return withDoc(session, { ...doc, source, updatedAt: now })
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
 * A stand-in name while the first turn runs: the prompt, with the asking
 * stripped off. It is provisional — nameFromFirstTurn replaces it with the
 * model's own title once the turn commits — so it does not set `named`.
 */
export function nameFromFirstPrompt(session: Session, prompt: string): Session {
  const doc = currentDoc(session)
  if (doc.named) return session
  const taken = session.docs.filter((d) => d.id !== doc.id).map((d) => d.name)
  const name = nameFromPrompt(prompt, taken)
  if (name === UNTITLED) return session
  return withDoc(session, { ...doc, name })
}

/**
 * The first committed turn names the document: the model titles the part on
 * the file's first line (the system prompt asks it to), and that beats the
 * user's prompt, which describes a wish rather than the thing. Without a
 * title line the provisional name stands. Either way the name is then final
 * for prompts — later ones are edits ("make it 2 mm taller" is a poor title
 * for a knob) — though never over a title the user typed.
 */
export function nameFromFirstTurn(session: Session, source: string): Session {
  const doc = currentDoc(session)
  if (doc.named) return session
  const taken = session.docs.filter((d) => d.id !== doc.id).map((d) => d.name)
  const heading = headingOf(source)
  const name = heading === null ? doc.name : dedupe(heading, taken)
  if (name === UNTITLED) return session
  return withDoc(session, { ...doc, name, named: true })
}

// ---- versions (design.md §7) ------------------------------------------------

/** The one place a version is minted. */
function append(doc: Doc, source: string, label: string, compileOk: boolean, now: number): Doc {
  const next: Version = {
    id: String(doc.versions.length + 1),
    parentId: headVersion(doc).id,
    ts: now,
    label: label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) || EDIT,
    source,
    compileOk,
  }
  return { ...doc, source, updatedAt: now, versions: [...doc.versions, next], head: next.id }
}

/** Uncommitted manual edits become a version before anything replaces them. */
function keepEdits(doc: Doc, now: number): Doc {
  return doc.source === headVersion(doc).source ? doc : append(doc, doc.source, EDIT, false, now)
}

/** (a) An LLM turn. Manual edits it overwrites are kept first, so the timeline loses nothing. */
export function commitTurn(
  session: Session,
  source: string,
  label: string,
  compileOk: boolean,
  now: number,
): Session {
  const doc = keepEdits(currentDoc(session), now)
  if (headVersion(doc).source === source) return withDoc(session, { ...doc, source })
  return withDoc(session, append(doc, source, label, compileOk, now))
}

/**
 * (c) A successful compile of manual edits. Consecutive edits fold into one
 * version so the timeline reads as changes, not pauses in typing; the
 * keystroke-level history is the editor's own.
 *
 * ponytail: folding means the intermediate states of one editing session are
 * not versions. Append unconditionally if that ever matters — the picker copes.
 */
export function commitEdit(session: Session, source: string, now: number): Session {
  const doc = currentDoc(session)
  // A newer keystroke owns the next compile.
  if (doc.source !== source) return session
  const head = headVersion(doc)
  if (head.source === source) {
    if (head.compileOk) return session
    return withDoc(session, {
      ...doc,
      versions: doc.versions.map((v) => (v === head ? { ...v, compileOk: true } : v)),
    })
  }
  const last = doc.versions[doc.versions.length - 1]
  if (last && last.id === head.id && last.label === EDIT) {
    const folded = { ...last, source, ts: now, compileOk: true }
    return withDoc(session, {
      ...doc,
      updatedAt: now,
      versions: [...doc.versions.slice(0, -1), folded],
    })
  }
  return withDoc(session, append(doc, source, EDIT, true, now))
}

/** (b) Explicit save: what is in the editor becomes a named point later edits will not fold into. */
export function saveVersion(session: Session, now: number): Session {
  const current = currentDoc(session)
  const kept = keepEdits(current, now)
  const head = headVersion(kept)
  const doc =
    head.label === EDIT
      ? { ...kept, versions: kept.versions.map((v) => (v === head ? { ...v, label: SAVED } : v)) }
      : kept
  return doc === current ? session : withDoc(session, doc)
}

/**
 * Moves the head. The list is untouched, so nothing is ever lost — including
 * edits made since it, which are kept as a version of their own first.
 */
export function restoreVersion(session: Session, versionId: string, now: number): Session {
  const current = currentDoc(session)
  const target = current.versions.find((v) => v.id === versionId)
  if (!target || (target.id === current.head && target.source === current.source)) return session
  const doc = keepEdits(current, now)
  return withDoc(session, { ...doc, head: target.id, source: target.source, updatedAt: now })
}

/** design.md §10: the same operation as picking the previous node. */
export function undoVersion(session: Session, now: number): Session {
  const doc = currentDoc(session)
  const index = doc.versions.findIndex((v) => v.id === doc.head)
  const previous = index > 0 ? doc.versions[index - 1] : undefined
  return previous ? restoreVersion(session, previous.id, now) : session
}

export function setChat(session: Session, chat: readonly ChatEvent[]): Session {
  return withDoc(session, { ...currentDoc(session), chat: chat.map(stripImages) })
}

// ---- components (design.md §8) ---------------------------------------------------

/** Adds a mesh file, or replaces the one already under that name — which is how a component gets updated. */
export function addComponent(session: Session, component: Component, now: number): Session {
  const doc = currentDoc(session)
  const taken = doc.components.some((c) => c.name === component.name)
  const components = taken
    ? doc.components.map((c) => (c.name === component.name ? component : c))
    : [...doc.components, component]
  return withDoc(session, { ...doc, components, updatedAt: now })
}

export function removeComponent(session: Session, name: string, now: number): Session {
  const doc = currentDoc(session)
  if (!doc.components.some((c) => c.name === name)) return session
  return withDoc(session, {
    ...doc,
    components: doc.components.filter((c) => c.name !== name),
    updatedAt: now,
  })
}

// ---- the list ----------------------------------------------------------------

/**
 * `freshId` is spent only when the doomed document was the last one: an empty
 * document list has no editor to show and no obvious way back, so deleting
 * everything lands on a blank document instead of on nothing.
 */
export function deleteDoc(session: Session, id: string, freshId: string, now: number): Session {
  const index = session.docs.findIndex((d) => d.id === id)
  if (index < 0) return session
  const docs = session.docs.filter((d) => d.id !== id)
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

// ---- revive: the trust boundary ------------------------------------------------

/**
 * What comes back out of IndexedDB or a project file is whatever an older
 * version of this app, a half-finished write or a corrupt store left there, so
 * nothing about its shape is assumed and nothing here throws.
 */
export function reviveDoc(raw: unknown, now: number, taken: string[] = []): Doc | null {
  const d = raw as Partial<Record<keyof Doc, unknown>> | null
  // id and source are the document; a row missing either has nothing to restore.
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || typeof d.source !== 'string') {
    return null
  }
  const updatedAt = typeof d.updatedAt === 'number' ? d.updatedAt : now
  const createdAt = typeof d.createdAt === 'number' ? d.createdAt : updatedAt
  return {
    id: d.id,
    // Deduped against the rows already revived: recovery is exactly where the
    // user is working out what survived, so two identical labels are worst here.
    name: pushName(
      typeof d.name === 'string' && d.name !== '' ? d.name : suggestName(d.source, taken),
      taken,
    ),
    source: d.source,
    createdAt,
    updatedAt,
    ...reviveVersions(d.versions, d.head, d.source, createdAt),
    chat: reviveLog(d.chat),
    components: reviveComponents(d.components),
    ...(d.named === true ? { named: true as const } : {}),
  }
}

const isVec3 = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n))

/**
 * Bytes arrive as a Uint8Array from IndexedDB and as base64 from a project
 * file; both are accepted here so the file needs no decoding pass of its own.
 * A name that fails COMPONENT_NAME is dropped whole: it would be written
 * into the kernel FS and spliced into an import() string.
 */
function reviveComponents(raw: unknown): Component[] {
  const out: Component[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const c = item as Partial<Record<keyof Component, unknown>> | null
    if (!c || typeof c !== 'object' || typeof c.name !== 'string' || !COMPONENT_NAME.test(c.name)) continue
    if (!isVec3(c.min) || !isVec3(c.max)) continue
    const bytes =
      c.bytes instanceof Uint8Array ? c.bytes : typeof c.bytes === 'string' ? fromBase64(c.bytes) : null
    if (!bytes || out.some((o) => o.name === c.name)) continue
    out.push({ name: c.name, bytes, min: c.min, max: c.max })
  }
  return out
}

/** Chunked: String.fromCharCode(...bytes) overflows the call stack past ~100 KB. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Renumbered '1'..'n' so append() can mint the next id blind. A row written
 * before versions existed becomes one SAVED version of its source — that is
 * the whole migration (design.md §12).
 */
function reviveVersions(
  raw: unknown,
  rawHead: unknown,
  source: string,
  ts: number,
): Pick<Doc, 'versions' | 'head'> {
  const kept: { id: string; source: string; row: Partial<Record<keyof Version, unknown>> }[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const row = item as Partial<Record<keyof Version, unknown>> | null
    if (row && typeof row === 'object' && typeof row.id === 'string' && typeof row.source === 'string') {
      kept.push({ id: row.id, source: row.source, row })
    }
  }
  if (kept.length === 0) {
    return { versions: [{ id: '1', parentId: null, ts, label: SAVED, source, compileOk: false }], head: '1' }
  }
  const renumbered = new Map(kept.map((v, i) => [v.id, String(i + 1)]))
  const versions = kept.map(
    ({ source, row }, i): Version => ({
      id: String(i + 1),
      parentId: typeof row.parentId === 'string' ? (renumbered.get(row.parentId) ?? null) : null,
      ts: typeof row.ts === 'number' ? row.ts : ts,
      label: typeof row.label === 'string' && row.label !== '' ? row.label : SAVED,
      source,
      compileOk: row.compileOk === true,
    }),
  )
  const head =
    (typeof rawHead === 'string' && renumbered.get(rawHead)) || versions[versions.length - 1]!.id
  return { versions, head }
}

/**
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
  const wanted = s?.currentId
  const found = typeof wanted === 'string' && docs.some((d) => d.id === wanted)
  return { docs, currentId: found ? wanted : first.id }
}

// ---- names ---------------------------------------------------------------------

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
 * suggestName is only the fallback for a document nobody prompted for.
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
  return headingOf(source) ?? DECLARATION.exec(source)?.[1] ?? UNTITLED
}

/** The first own-line comment's first sentence, or null when there is none. */
function headingOf(source: string): string | null {
  const heading = HEADING.exec(source)?.[1]
  if (heading === undefined) return null
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
