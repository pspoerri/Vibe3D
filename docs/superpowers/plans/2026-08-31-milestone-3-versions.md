# Milestone 3 — Versions, Persistence, Project File

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make M3 do what `design.md` §7 and §10 say it does — every change is a version you can step back to, the transcript survives a reload, and a document can leave the browser as one `.json` — and close the review findings of 2026-08-31 on the way.

**Architecture:** A `Doc` gains an append-only `versions: Version[]` list, a `head` pointer, and its `chat`. Versions are minted at three points: an LLM turn commits, an explicit save, and a successful compile of manual edits (consecutive edits fold into one version). Restore **moves `head`** instead of appending a copy — the list is still append-only and total-ordered, `parentId` still records the tree, and `/undo` becomes repeatable (`v3 → v2 → v1`) instead of oscillating between the last two states. The launcher's "versions are documents" model, `forkDoc` and the family-numbering code go away. The IndexedDB record shape changes; `reviveSession` migrates a pre-version row into one `saved` version of its source.

**Tech Stack:** React 19, idb-keyval, Vitest (node), Playwright. No new dependencies.

**Spec:** `docs/design.md` §7 (state, time travel, persistence), §9 (reference images — never persisted), §10 (chat commands), §12 (storage-version footgun). The review findings this plan closes are recorded in `docs/design.md` §14 after Task 9.

## Global Constraints

- No new dependencies. `pnpm build` must stay clean under `strict`, `noUnusedLocals`, `noUncheckedIndexedAccess`, lib ES2022 (no `findLast*`, no `Array.prototype.at` on typed positions where the index can be negative — check the sign first).
- The API key never enters a `Doc`, a `Session`, or the project file. The export serialises named fields, never a spread.
- Images never reach the store or the project file (design.md §9): the transcript is stripped at the boundary into the session.
- `documents.ts` stays pure and node-testable: no IndexedDB, no DOM, no `Date.now()` — callers pass `now` and ids.
- Ponytail is on: shortest working diff, `// ponytail:` on any deliberate ceiling.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/chat/log.ts` (modify) | + `nextTurn`, `stripImages`, `reviveLog` — the transcript's persisted form and its trust boundary |
| `src/state/documents.ts` (rewrite the version half) | `Version`, `Doc{versions, head, chat}`; `headVersion`, `commitTurn`, `commitEdit`, `saveVersion`, `restoreVersion`, `undoVersion`, `setChat`; `reviveDoc` exported and migrating. Delete `forkDoc`, `families`, `versionNumbers`, `versionFamily`, `versionNumber`. |
| `src/state/project.ts` (new) | `exportProject`, `importProject`, `SCHEMA_VERSION` — the one place the file format lives |
| `src/state/store.ts` (modify) | Delete dead `loadSession`, `loadLastSource` |
| `src/chat/commands.ts` (modify) | + `/undo` |
| `src/chat/Chat.tsx` (modify) | log seeded from the doc and reported up; abort on unmount; `/undo`; consistent compaction turn; version label on apply |
| `src/App.tsx` (modify) | commit points, cancel-preview-on-apply, empty-source guard, version picker, Save version, Export/Import project, durability note, `whenEdited` |
| `src/index.css` (modify) | menubar select, durability note |
| `src/llm/openrouter.ts` (modify) | Delete dead `checkKey` |
| `.github/workflows/deploy.yml` (modify) | Drop the second build |
| `README.md`, `docs/design.md` (modify) | Reconcile §7, §9, §10, §4, status line, base-URL claim |
| Tests | `src/chat/log.test.ts`, `src/state/documents.test.ts` (rewrite fixtures), `src/state/project.test.ts` (new), `src/chat/commands.test.ts`, `e2e/chat.spec.ts` |

---

### Task 1: The transcript's persisted form — `log.ts`

**Files:** Modify `src/chat/log.ts`, `src/chat/log.test.ts`.

**Produces:** `nextTurn(log): number`, `stripImages(event): ChatEvent`, `reviveLog(raw: unknown): ChatEvent[]`.

- [ ] **Step 1: Failing tests** (append to `log.test.ts`)

```ts
import { buildWindow, nextTurn, reviveLog, stripImages, type ChatEvent } from './log'

test('the next turn continues a revived transcript instead of restarting at 1', () => {
  expect(nextTurn([])).toBe(1)
  expect(nextTurn([user(1, 'a'), assistant(1, 'b'), user(4, 'c')])).toBe(5)
})

test('stripping images leaves every other event untouched, by identity', () => {
  const plain = user(1, 'no image')
  expect(stripImages(plain)).toBe(plain)
  const withImage = user(2, 'like this', ['data:image/jpeg;base64,AAA'])
  expect(stripImages(withImage)).toEqual({ id: withImage.id, ts: 0, turn: 2, kind: 'user', text: 'like this' })
  expect('images' in stripImages(withImage)).toBe(false)
})

test('a revived log keeps every well-formed event and drops the rest', () => {
  const good: ChatEvent[] = [
    user(1, 'a box'),
    { id: 'x1', ts: 1, turn: 1, kind: 'assistant', text: 'here', stopped: true },
    compiled(1, false, 'ERROR: boom'),
    { id: 'x2', ts: 1, turn: 1, kind: 'note', text: 'n', tone: 'error' },
    { id: 'x3', ts: 1, turn: 1, kind: 'clear' },
    { id: 'x4', ts: 1, turn: 2, kind: 'summary', text: 's', coversThrough: 'x1' },
  ]
  expect(reviveLog(JSON.parse(JSON.stringify(good)))).toEqual(good)
  const bad = [
    null, 'text', 42,
    { id: 'b1', turn: 1, kind: 'user' },                     // no text → would put undefined on the wire
    { id: 'b2', turn: 1, kind: 'user', text: 42 },
    { id: 'b3', turn: 'one', kind: 'user', text: 'x' },
    { id: 'b4', turn: 1, kind: 'summary', text: 's' },       // no boundary
    { id: 'b5', turn: 1, kind: 'compile', ok: true },        // no stderr
    { id: 'b6', turn: 1, kind: 'wat', text: 'x' },
    { turn: 1, kind: 'user', text: 'no id' },
  ]
  expect(reviveLog(bad)).toEqual([])
  expect(reviveLog(undefined)).toEqual([])
  expect(reviveLog({ length: 2 })).toEqual([])
})

test('a revived log never carries two events with one id, so React keys stay unique', () => {
  const twice = [user(1, 'a'), user(1, 'a')].map((e) => ({ ...e, id: 'same' }))
  expect(reviveLog(twice)).toHaveLength(1)
})

test('a revived user event has no images, whatever the file said', () => {
  const raw = [{ id: 'u', ts: 0, turn: 1, kind: 'user', text: 't', images: ['data:image/jpeg;base64,AAA'] }]
  expect(reviveLog(raw)).toEqual([{ id: 'u', ts: 0, turn: 1, kind: 'user', text: 't' }])
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/chat/log.test.ts` — expect failures on the missing exports.

- [ ] **Step 3: Implement** (append to `log.ts`)

```ts
/** The next turn number for a log, so a revived transcript continues rather than restarts. */
export function nextTurn(log: readonly ChatEvent[]): number {
  let max = 0
  for (const event of log) if (event.turn > max) max = event.turn
  return max + 1
}

/** The persisted form of a user event — design.md §9: images never reach the store. */
export function stripImages(event: ChatEvent): ChatEvent {
  if (event.kind !== 'user' || !event.images) return event
  return { id: event.id, ts: event.ts, turn: event.turn, kind: 'user', text: event.text }
}

/**
 * Trust boundary for a transcript read back from the store or a project file.
 * An event with a missing text would put `undefined` on the wire on every later
 * request, so a malformed event is dropped rather than repaired.
 */
export function reviveLog(raw: unknown): ChatEvent[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const events: ChatEvent[] = []
  for (const item of raw) {
    const event = reviveEvent(item)
    if (event && !seen.has(event.id)) {
      seen.add(event.id)
      events.push(event)
    }
  }
  return events
}

function reviveEvent(raw: unknown): ChatEvent | null {
  const e = raw as Record<string, unknown> | null
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.turn !== 'number') return null
  const base = { id: e.id, ts: typeof e.ts === 'number' ? e.ts : 0, turn: e.turn }
  const text = typeof e.text === 'string' ? e.text : null
  switch (e.kind) {
    case 'user':
      return text === null ? null : { ...base, kind: 'user', text }
    case 'assistant':
      return text === null
        ? null
        : { ...base, kind: 'assistant', text, ...(e.stopped === true ? { stopped: true as const } : {}) }
    case 'note':
      return text === null ? null : { ...base, kind: 'note', text, tone: e.tone === 'error' ? 'error' : 'info' }
    case 'summary':
      return text === null || typeof e.coversThrough !== 'string'
        ? null
        : { ...base, kind: 'summary', text, coversThrough: e.coversThrough }
    case 'compile':
      return typeof e.stderr !== 'string'
        ? null
        : {
            ...base,
            kind: 'compile',
            ok: e.ok === true,
            ms: typeof e.ms === 'number' ? e.ms : 0,
            attempt: typeof e.attempt === 'number' ? e.attempt : 0,
            stderr: e.stderr,
          }
    case 'clear':
      return { ...base, kind: 'clear' }
    default:
      return null
  }
}
```

- [ ] **Step 4: Run** the file again — expect PASS.

---

### Task 2: Versions in the document model — `documents.ts`

**Files:** Modify `src/state/documents.ts`, rewrite `src/state/documents.test.ts` fixtures and the version tests.

**Consumes:** `reviveLog`, `stripImages`, `ChatEvent` from Task 1.

**Produces (exact):**

```ts
export interface Version { id: string; parentId: string | null; ts: number; label: string; source: string; compileOk: boolean }
export interface Doc { id: string; name: string; named?: true; createdAt: number; updatedAt: number; source: string; versions: Version[]; head: string; chat: ChatEvent[] }
export const EDIT = 'edit'; export const SAVED = 'saved'
export function newDoc(name: string, source: string, id: string, now: number): Doc            // one version '1', label 'new'
export function headVersion(doc: Doc): Version                                                  // total
export function commitTurn(session: Session, source: string, label: string, compileOk: boolean, now: number): Session
export function commitEdit(session: Session, source: string, now: number): Session
export function saveVersion(session: Session, now: number): Session
export function restoreVersion(session: Session, versionId: string, now: number): Session
export function undoVersion(session: Session, now: number): Session
export function setChat(session: Session, chat: readonly ChatEvent[]): Session
export function reviveDoc(raw: unknown, now: number, taken?: string[]): Doc | null
```

Version ids are `'1'`, `'2'`, … in commit order; `reviveDoc` renumbers so the next id can be minted blind. Deleted: `forkDoc`, `families`, `versionNumbers`, `versionFamily`, `versionNumber`; `Doc.parentId` is gone.

- [ ] **Step 1: Failing tests.** Replace the fixtures at the top of `documents.test.ts` and every test that mentions `parentId`, `forkDoc`, `versionFamily`, `versionNumber(s)`:

```ts
const v = (id: string, source: string, label = 'new', extra: Partial<Version> = {}): Version => ({
  id, parentId: id === '1' ? null : String(Number(id) - 1), ts: 0, label, source, compileOk: false, ...extra,
})
const doc = (id: string, name: string, source: string, ts: number): Doc => ({
  id, name, source, createdAt: ts, updatedAt: ts, versions: [v('1', source)], head: '1', chat: [],
})
const three = (): Session => ({
  docs: [doc('a', 'A', 'cube(1);', 1), doc('b', 'B', 'cube(2);', 2), doc('c', 'C', 'cube(3);', 3)],
  currentId: 'b',
})
```

New version tests:

```ts
test('an LLM turn commits a version labelled by its prompt, and the head follows it', () => {
  const next = commitTurn(three(), 'cube(20);', 'make it   bigger please', true, 500)
  const d = currentDoc(next)
  expect(d.source).toBe('cube(20);')
  expect(d.head).toBe('2')
  expect(d.versions[1]).toEqual({ id: '2', parentId: '1', ts: 500, label: 'make it bigger please', source: 'cube(20);', compileOk: true })
  expect(d.updatedAt).toBe(500)
})

test('a turn that overwrites manual edits keeps them as a version first', () => {
  const edited = updateSource(three(), 'cube(2.5);', 10)
  const next = commitTurn(edited, 'cube(20);', 'bigger', true, 500)
  expect(currentDoc(next).versions.map((x) => [x.id, x.label, x.source, x.compileOk])).toEqual([
    ['1', 'new', 'cube(2);', false],
    ['2', 'edit', 'cube(2.5);', false],
    ['3', 'bigger', 'cube(20);', true],
  ])
  expect(currentDoc(next).versions[2]?.parentId).toBe('2')
})

test('consecutive manual edits fold into one version; a later change starts a new one', () => {
  let s = updateSource(three(), 'cube(3);', 10)
  s = commitEdit(s, 'cube(3);', 11)
  expect(currentDoc(s).versions.map((x) => [x.id, x.label, x.source, x.compileOk])).toEqual([
    ['1', 'new', 'cube(2);', false], ['2', 'edit', 'cube(3);', true],
  ])
  s = updateSource(s, 'cube(4);', 20)
  s = commitEdit(s, 'cube(4);', 21)
  expect(currentDoc(s).versions).toHaveLength(2)
  expect(currentDoc(s).versions[1]).toMatchObject({ source: 'cube(4);', ts: 21, compileOk: true })
  s = commitTurn(s, 'cube(9);', 'nine', true, 30)
  s = updateSource(s, 'cube(10);', 40)
  s = commitEdit(s, 'cube(10);', 41)
  expect(currentDoc(s).versions.map((x) => x.id)).toEqual(['1', '2', '3', '4'])
  expect(currentDoc(s).versions[3]).toMatchObject({ label: 'edit', parentId: '3' })
})

test('a compile of the head itself only marks it verified, and a stale compile is ignored', () => {
  const s = commitEdit(three(), 'cube(2);', 5)
  expect(currentDoc(s).versions).toHaveLength(1)
  expect(currentDoc(s).versions[0]?.compileOk).toBe(true)
  expect(commitEdit(s, 'cube(2);', 6)).toBe(s)
  const typed = updateSource(s, 'cube(7);', 7)
  expect(commitEdit(typed, 'cube(6);', 8)).toBe(typed)
})

test('saving names the current edits so later edits do not fold into them', () => {
  let s = updateSource(three(), 'cube(3);', 10)
  s = saveVersion(s, 11)
  expect(currentDoc(s).versions[1]).toMatchObject({ label: 'saved', source: 'cube(3);' })
  expect(saveVersion(s, 12)).toBe(s)
  s = updateSource(s, 'cube(4);', 20)
  s = commitEdit(s, 'cube(4);', 21)
  expect(currentDoc(s).versions.map((x) => x.label)).toEqual(['new', 'saved', 'edit'])
  expect(currentDoc(saveVersion(s, 22)).versions.map((x) => x.label)).toEqual(['new', 'saved', 'saved'])
})

test('restore moves the head without removing anything, and keeps unsaved edits first', () => {
  let s = commitTurn(three(), 'cube(20);', 'bigger', true, 1)
  s = commitTurn(s, 'cube(30);', 'bigger still', true, 2)
  s = updateSource(s, 'cube(31);', 3)
  s = restoreVersion(s, '1', 4)
  const d = currentDoc(s)
  expect(d.head).toBe('1')
  expect(d.source).toBe('cube(2);')
  expect(d.versions.map((x) => [x.id, x.label, x.source])).toEqual([
    ['1', 'new', 'cube(2);'], ['2', 'bigger', 'cube(20);'], ['3', 'bigger still', 'cube(30);'], ['4', 'edit', 'cube(31);'],
  ])
  expect(restoreVersion(s, '1', 5)).toBe(s)
  expect(restoreVersion(s, '99', 5)).toBe(s)
  // A commit from a restored head branches: parentId records it, the list stays linear.
  const branched = commitTurn(s, 'cube(40);', 'forty', true, 6)
  expect(currentDoc(branched).versions[4]).toMatchObject({ id: '5', parentId: '1' })
})

test('/undo steps back one version at a time and stops at the first', () => {
  let s = commitTurn(three(), 'cube(20);', 'bigger', true, 1)
  s = commitTurn(s, 'cube(30);', 'bigger still', true, 2)
  s = undoVersion(s, 3)
  expect(currentDoc(s)).toMatchObject({ head: '2', source: 'cube(20);' })
  s = undoVersion(s, 4)
  expect(currentDoc(s)).toMatchObject({ head: '1', source: 'cube(2);' })
  expect(undoVersion(s, 5)).toBe(s)
})

test('the transcript is stored on the document with its images stripped', () => {
  const chat: ChatEvent[] = [
    { id: 'u', ts: 0, turn: 1, kind: 'user', text: 'like this', images: ['data:image/jpeg;base64,AAA'] },
    { id: 'a', ts: 0, turn: 1, kind: 'assistant', text: 'ok' },
  ]
  const s = setChat(three(), chat)
  expect(currentDoc(s).chat).toEqual([{ id: 'u', ts: 0, turn: 1, kind: 'user', text: 'like this' }, chat[1]])
  expect(JSON.stringify(s)).not.toContain('base64')
})

test('a row written before versions existed revives as one saved version of its source', () => {
  const legacy = { docs: [{ id: 'a', name: 'A', source: 'cube(1);', createdAt: 1, updatedAt: 2, parentId: null }], currentId: 'a' }
  const d = currentDoc(reviveSession(legacy, STARTER, 'fresh', 99))
  expect(d.versions).toEqual([{ id: '1', parentId: null, ts: 1, label: 'saved', source: 'cube(1);', compileOk: false }])
  expect(d.head).toBe('1')
  expect(d.chat).toEqual([])
  expect('parentId' in d).toBe(false)
})

test('revive renumbers versions, remaps head and parents, and drops what it cannot read', () => {
  const raw = {
    docs: [{
      id: 'a', source: 'C', versions: [
        { id: 'x', source: 'A', label: 'new', ts: 1 },
        null,
        { id: 'y', source: 'B', parentId: 'x', label: '', compileOk: 'yes' },
        { id: 'z', source: 'C', parentId: 'y', compileOk: true },
        { id: 'w' },
      ], head: 'y', chat: [{ id: 'u', turn: 1, kind: 'user', text: 'hi' }, 'junk'],
    }],
    currentId: 'a',
  }
  const d = currentDoc(reviveSession(raw, STARTER, 'fresh', 99))
  expect(d.versions.map((x) => [x.id, x.parentId, x.label, x.compileOk])).toEqual([
    ['1', null, 'new', false], ['2', '1', 'saved', false], ['3', '2', 'saved', true],
  ])
  expect(d.head).toBe('2')
  expect(d.chat).toEqual([{ id: 'u', ts: 0, turn: 1, kind: 'user', text: 'hi' }])
  const dangling = currentDoc(reviveSession({ docs: [{ id: 'a', source: 'S', versions: [{ id: 'q', source: 'S' }], head: 'nope' }], currentId: 'a' }, STARTER, 'fresh', 99))
  expect(dangling.head).toBe('1')
})
```

Update `a new session holds one document…`, `deleting the only document…`, `currentDoc returns a document even when the pointer has rotted`, `one corrupt row…`, and `two rows sharing an id…` to the new `Doc` shape (versions `[v('1', source)]`, `head: '1'`, `chat: []`, no `parentId`). Delete the five fork/family tests and the 200-version timing test.

- [ ] **Step 2: Run** `pnpm vitest run src/state/documents.test.ts` — expect compile failures and red tests.

- [ ] **Step 3: Implement.** Replace the `Doc` interface and the version half of `documents.ts`:

```ts
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

export interface Doc {
  id: string
  name: string
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
}

export const EDIT = 'edit'
export const SAVED = 'saved'
const NEW = 'new'
const LABEL_MAX = 48

export function newDoc(name: string, source: string, id: string, now: number): Doc {
  const first: Version = { id: '1', parentId: null, ts: now, label: NEW, source, compileOk: false }
  return { id, name, source, createdAt: now, updatedAt: now, versions: [first], head: '1', chat: [] }
}

/** Total: revive guarantees a version, and the synthetic fallback covers a hand-built doc. */
export function headVersion(doc: Doc): Version {
  return (
    doc.versions.find((v) => v.id === doc.head) ??
    doc.versions[doc.versions.length - 1] ?? {
      id: '1', parentId: null, ts: doc.createdAt, label: NEW, source: doc.source, compileOk: false,
    }
  )
}

/** Replaces the document, or adopts one currentDoc synthesised for an empty session. */
function withDoc(session: Session, doc: Doc): Session {
  return session.docs.some((d) => d.id === doc.id)
    ? { ...session, docs: session.docs.map((d) => (d.id === doc.id ? doc : d)) }
    : { docs: [...session.docs, doc], currentId: doc.id }
}

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

/** Uncommitted manual edits become a version before anything replaces them (design.md §7). */
function keepEdits(doc: Doc, now: number): Doc {
  return doc.source === headVersion(doc).source ? doc : append(doc, doc.source, EDIT, false, now)
}

/** (a) An LLM turn. */
export function commitTurn(session: Session, source: string, label: string, compileOk: boolean, now: number): Session {
  const doc = keepEdits(currentDoc(session), now)
  if (headVersion(doc).source === source) return withDoc(session, { ...doc, source })
  return withDoc(session, append(doc, source, label, compileOk, now))
}

/**
 * (c) A successful compile of manual edits. Consecutive edits fold into one
 * version so the timeline reads as changes, not pauses in typing; the
 * keystroke-level history is the editor's own.
 */
export function commitEdit(session: Session, source: string, now: number): Session {
  const doc = currentDoc(session)
  // A newer keystroke owns the next compile.
  if (doc.source !== source) return session
  const head = headVersion(doc)
  if (head.source === source) {
    if (head.compileOk) return session
    return withDoc(session, { ...doc, versions: doc.versions.map((v) => (v === head ? { ...v, compileOk: true } : v)) })
  }
  const last = doc.versions[doc.versions.length - 1]
  if (last && last.id === head.id && last.label === EDIT) {
    const folded = { ...last, source, ts: now, compileOk: true }
    return withDoc(session, { ...doc, updatedAt: now, versions: [...doc.versions.slice(0, -1), folded] })
  }
  return withDoc(session, append(doc, source, EDIT, true, now))
}

/** (b) Explicit save: what is in the editor becomes a named point later edits will not fold into. */
export function saveVersion(session: Session, now: number): Session {
  const kept = keepEdits(currentDoc(session), now)
  const head = headVersion(kept)
  const doc =
    head.label === EDIT
      ? { ...kept, versions: kept.versions.map((v) => (v === head ? { ...v, label: SAVED } : v)) }
      : kept
  return doc === currentDoc(session) ? session : withDoc(session, doc)
}

/** Moves the head. The list is untouched, so nothing is ever lost — including edits made since it. */
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
```

`updateSource` becomes `withDoc(session, { ...doc, source, updatedAt: now })` after the identity guard. `deleteDoc` loses its reparenting `map`. `currentDoc`'s fallback is `newDoc(UNTITLED, '', session.currentId, 0)`. `reviveDoc` is exported and ends with `...reviveVersions(d.versions, d.head, d.source, createdAt), chat: reviveLog(d.chat)`:

```ts
/**
 * Renumbered '1'..'n' so append() can mint the next id blind. A row written
 * before versions existed becomes one SAVED version of its source.
 */
function reviveVersions(raw: unknown, rawHead: unknown, source: string, ts: number): Pick<Doc, 'versions' | 'head'> {
  const kept: Partial<Record<keyof Version, unknown>>[] = []
  for (const row of Array.isArray(raw) ? raw : []) {
    const v = row as Partial<Record<keyof Version, unknown>> | null
    if (v && typeof v === 'object' && typeof v.id === 'string' && typeof v.source === 'string') kept.push(v)
  }
  if (kept.length === 0) {
    return { versions: [{ id: '1', parentId: null, ts, label: SAVED, source, compileOk: false }], head: '1' }
  }
  const renumbered = new Map(kept.map((v, i) => [v.id as string, String(i + 1)]))
  const versions = kept.map(
    (v, i): Version => ({
      id: String(i + 1),
      parentId: typeof v.parentId === 'string' ? (renumbered.get(v.parentId) ?? null) : null,
      ts: typeof v.ts === 'number' ? v.ts : ts,
      label: typeof v.label === 'string' && v.label !== '' ? v.label : SAVED,
      source: v.source as string,
      compileOk: v.compileOk === true,
    }),
  )
  const head = (typeof rawHead === 'string' && renumbered.get(rawHead)) || versions[versions.length - 1]!.id
  return { versions, head }
}
```

`reviveSession` drops the `linked` parent-repair pass. Delete `forkDoc`, `families`, `versionNumbers`, `versionFamily`, `versionNumber`.

- [ ] **Step 4: Run** `pnpm vitest run src/state/documents.test.ts` and `npx tsc --noEmit -p tsconfig.test.json` — expect PASS on the tests; App.tsx will not compile yet (Task 5).

---

### Task 3: The project file — `project.ts`

**Files:** Create `src/state/project.ts`, `src/state/project.test.ts`.

**Consumes:** `Doc`, `reviveDoc` from Task 2. **Produces:** `exportProject(doc): string`, `importProject(text, id, now, taken?): Doc`, `SCHEMA_VERSION`.

- [ ] **Step 1: Failing tests**

```ts
import { expect, test } from 'vitest'
import { newDoc, commitTurn, setChat, currentDoc } from './documents'
import { exportProject, importProject, PROJECT_TYPE, SCHEMA_VERSION } from './project'

const sample = () => {
  const s = { docs: [newDoc('Bracket', 'cube(1);', 'd1', 1)], currentId: 'd1' }
  return currentDoc(setChat(commitTurn(s, 'cube(2);', 'bigger', true, 2), [
    { id: 'u', ts: 2, turn: 1, kind: 'user', text: 'bigger', images: ['data:image/jpeg;base64,AAA'] },
  ]))
}

test('the file carries exactly the named fields — no id, no settings, no key, no images', () => {
  const parsed = JSON.parse(exportProject(sample())) as Record<string, unknown>
  expect(Object.keys(parsed).sort()).toEqual(['chat', 'head', 'name', 'schemaVersion', 'source', 'type', 'versions'])
  expect(parsed).toMatchObject({ type: PROJECT_TYPE, schemaVersion: SCHEMA_VERSION, name: 'Bracket', head: '2' })
  expect(exportProject(sample())).not.toContain('base64')
})

test('a file round-trips into a document with a fresh id and its own timestamps', () => {
  const doc = importProject(exportProject(sample()), 'fresh', 99, ['Bracket'])
  expect(doc.id).toBe('fresh')
  expect(doc.name).toBe('Bracket 2')
  expect(doc.versions).toEqual(sample().versions)
  expect(doc.head).toBe('2')
  expect(doc.source).toBe('cube(2);')
  expect(doc.chat).toEqual([{ id: 'u', ts: 2, turn: 1, kind: 'user', text: 'bigger' }])
  expect(doc.createdAt).toBe(99)
})

test('what is not a project is refused with a reason, and a newer schema is refused by name', () => {
  expect(() => importProject('not json', 'x', 1)).toThrow('not JSON')
  expect(() => importProject('{"type":"other/thing","schemaVersion":1}', 'x', 1)).toThrow('not a Vibe3D project')
  expect(() => importProject('{"type":"vibe3d/project"}', 'x', 1)).toThrow('not a Vibe3D project')
  expect(() => importProject('{"type":"vibe3d/project","schemaVersion":2,"source":"cube(1);"}', 'x', 1)).toThrow('schema 2')
  expect(() => importProject('{"type":"vibe3d/project","schemaVersion":1}', 'x', 1)).toThrow('no source')
})
```

- [ ] **Step 2: Run** `pnpm vitest run src/state/project.test.ts` — expect "Cannot find module".

- [ ] **Step 3: Implement**

```ts
import { reviveDoc, type Doc } from './documents'

export const PROJECT_TYPE = 'vibe3d/project'
export const SCHEMA_VERSION = 1

/**
 * Named fields, never a spread: design.md §7 — the file must not be able to
 * grow a secret by accident. `id` stays behind so an import can never collide
 * with a row already open.
 */
export function exportProject(doc: Doc): string {
  const { name, source, head, versions, chat } = doc
  return JSON.stringify({ type: PROJECT_TYPE, schemaVersion: SCHEMA_VERSION, name, source, head, versions, chat }, null, 2)
}

/** Throws with a message meant for the user. */
export function importProject(text: string, id: string, now: number, taken: string[] = []): Doc {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file is not JSON.')
  }
  const p = raw as { type?: unknown; schemaVersion?: unknown } | null
  if (!p || typeof p !== 'object' || p.type !== PROJECT_TYPE || typeof p.schemaVersion !== 'number') {
    throw new Error('That file is not a Vibe3D project.')
  }
  if (p.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`This project was saved by a newer Vibe3D (schema ${p.schemaVersion}); update the app to open it.`)
  }
  const doc = reviveDoc({ ...p, id, createdAt: now, updatedAt: now }, now, taken)
  if (!doc) throw new Error('That project file has no source in it.')
  return doc
}
```

- [ ] **Step 4: Run** the test — expect PASS.

---

### Task 4: `/undo` and the dead exports

**Files:** Modify `src/chat/commands.ts`, `src/chat/commands.test.ts`, `src/state/store.ts`, `src/llm/openrouter.ts`, `src/llm/openrouter.test.ts`.

- [ ] **Step 1:** In `commands.test.ts` replace the `/undo` expectation with `expect(parseCommand('/undo')).toEqual({ name: 'undo' })` and add `expect(parseCommand('/UNDO now')).toEqual({ name: 'undo' })`. Run — expect FAIL.
- [ ] **Step 2:** Add `| { name: 'undo' }` to `Command`, `case 'undo': return { name: 'undo' }`, and rewrite the doc comment's `/undo` sentence to "`/undo` steps the document back one version (design.md §10)". Run — expect PASS.
- [ ] **Step 3:** Delete `loadSession` and `loadLastSource` from `store.ts` (keep their reasoning in `loadAll`'s comment), `checkKey` from `openrouter.ts`, and its two tests from `openrouter.test.ts`. Run `pnpm test` — expect all green except nothing (App still uncompiled but not under vitest).

---

### Task 5: App wiring — commit points, picker, project file, review fixes

**Files:** Modify `src/App.tsx`, `src/chat/Chat.tsx`, `src/index.css`.

**Consumes:** everything above. This task is verified by Task 6's e2e suite; type-check as you go with `npx tsc --noEmit -p tsconfig.json`.

- [ ] **Step 1: Chat.tsx props.** Replace `onApply`, add three props:

```ts
/** The transcript this document had when it was opened. Read once. */
initialLog: readonly ChatEvent[]
/** Every change to the log, images included — the receiver strips them. */
onLogChange: (log: readonly ChatEvent[]) => void
onApply: (next: string, result: CompileResult, label: string) => void
/** Steps the document back one version; the note to show, or null when there is nothing to undo. */
onUndo: () => string | null
```

`const [log, setLog] = useState<ChatEvent[]>(() => [...initialLog])`, `const [turn, setTurn] = useState(() => nextTurn(initialLog))`. Report changes through a ref so the effect does not depend on the parent's identity:

```ts
const onLogChangeRef = useRef(onLogChange)
onLogChangeRef.current = onLogChange
useEffect(() => {
  if (log !== initialLogRef.current) onLogChangeRef.current(log)
}, [log])
```

(`initialLogRef` holds the first state array so the mount does not write the doc back to itself.)

- [ ] **Step 2: Abort on unmount** (review finding 1):

```ts
// A document switch remounts this pane; the turn it was running must die with
// it, or its onApply lands in whichever document is current by then.
useEffect(() => () => { abortRef.current?.abort(); compiler.dispose() }, [compiler])
```

- [ ] **Step 3: `/undo` and the compaction turn.** `compact(explicit: boolean, at: number)`: explicit call passes `turn`, the auto path passes `finished + 1`; the `runCompact` comment about the stale closure becomes "belt and braces — the turn passed here is the real next turn, and `images: false` stays as the guarantee". In `runCommand`: `case 'undo': { const restored = onUndo(); note(restored ?? 'Nothing to undo.', restored ? 'info' : 'error'); return }`. `onApply(outcome.source, outcome.result, text)`.

- [ ] **Step 4: App.tsx.** Imports: `commitEdit, commitTurn, headVersion, restoreVersion, saveVersion, setChat, undoVersion` from documents, `exportProject, importProject` from project. Delete `versionNumbers`, `forkDoc`.

Preview effect: deps become `[source, previewDefines, compiler, ready]` with `const ready = session !== null` (a chat append must not restart an in-flight compile). After the key check:

```ts
// A blank document has nothing to compile, and would otherwise show the
// kernel's "top level object is empty" as an error for having done nothing.
if (source.trim() === '') {
  appliedKeyRef.current = key
  setBusy(false); setMesh(null); setError(null); setMs(null)
  return
}
```

In the timeout, after `applyCompiled(key, result)`:

```ts
// design.md §7 (c): a successful compile of manual edits is a version.
if (result.ok && previewDefines.length === 0) {
  setSession((s) => (s ? commitEdit(s, source, Date.now()) : s))
}
```

`onApply`:

```ts
onApply={(next, result, label) => {
  // A preview compile still in flight would land on top of this and put a
  // stale mesh under the new source.
  compiler.cancel()
  setSession((s) => (s ? commitTurn(s, next, label, result.ok, Date.now()) : s))
  applyCompiled(compileKey(next, NO_DEFINES), result)
  setFitToken((n) => n + 1)
}}
```

Chat gets `initialLog={session ? currentDoc(session).chat : []}`, `onLogChange={(log) => setSession((s) => (s ? setChat(s, log) : s))}`, and

```ts
onUndo={() => {
  const s = sessionRef.current
  if (!s) return null
  const next = undoVersion(s, Date.now())
  if (next === s) return null
  setSession(next)
  setFitToken((n) => n + 1)
  return `Restored v${headVersion(currentDoc(next)).id}.`
}}
```

`persistRequested()` result feeds `const [durable, setDurable] = useState(true)`; `StartWindow` gets `durable` and renders, when false, `<p className="start-durability">This browser may evict local data when it needs space. Export anything you want to keep.</p>`.

`whenEdited`: replace the loop with

```ts
for (const [size, unit] of STEPS) {
  if (ago < size * 60 || unit === 'day') return RELATIVE.format(-Math.floor(ago / size), unit)
}
return RELATIVE.format(-Math.floor(ago / 86_400_000), 'day')
```

(the day arm is unconditional, so the trailing constant goes).

`MenuBar` props gain `busy: boolean`. Replace the `Version` button with `Save version` (`onChange(saveVersion(session, Date.now()))`, disabled while busy), add after it:

```tsx
<select
  className="menubar-versions"
  aria-label="Version"
  title="Every LLM turn, save and edit is a version. Pick one to go back to it."
  value={doc.head}
  disabled={busy}
  onChange={(e) => onChange(restoreVersion(session, e.target.value, Date.now()))}
>
  {doc.versions.map((v) => (
    <option key={v.id} value={v.id}>
      v{v.id} · {v.label}{v.compileOk ? '' : ' ✗'}
    </option>
  ))}
</select>
```

then `Export project` (`downloadBlob(new TextEncoder().encode(exportProject(doc)), `${doc.name.replace(/[\\/:*?"<>|]+/g, '_')}.json`, 'application/json')`) and `Import project` (a button that clicks a hidden `<input type="file" accept=".json,application/json">`; on change: `file.text()` → `importProject(text, crypto.randomUUID(), Date.now(), session.docs.map((d) => d.name))` → `onChange({ docs: [...session.docs, doc], currentId: doc.id })`, `catch (e) { window.alert(e instanceof Error ? e.message : String(e)) }`, reset `e.target.value = ''`). `.menubar-doc` shows `doc.name` only. `StartWindow` rows show `v{d.versions.length}` when `> 1`.

- [ ] **Step 5: CSS** (append near `.menubar-doc`):

```css
.menubar select {
  font: 500 11px/1 ui-monospace, monospace; padding: 5px 6px; color: #414741; background: #fff;
  border: 1px solid #c8ccc4; border-radius: 2px; max-width: 240px;
}
.menubar select:disabled { opacity: .35; }
.menubar select:focus-visible { outline: 2px solid #b8860b; outline-offset: 1px; }
.start-durability { margin: 0 0 14px; font: 12px/1.5 system-ui, sans-serif; color: #8a5a00; }
```

- [ ] **Step 6:** `npx tsc --noEmit -p tsconfig.json && pnpm test` — expect clean and green.

---

### Task 6: Browser suite

**Files:** Modify `e2e/chat.spec.ts`.

- [ ] **Step 1:** Replace `a new version becomes the current document and leaves the old one intact` with:

```ts
test('save, edit, and step back through the version picker without losing either state', async ({ page }) => {
  await page.goto('/')
  await waitForStarter(page)
  const picker = page.getByRole('combobox', { name: 'Version' })
  await expect(picker).toHaveValue('1')

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('cube([8, 8, 8]);')
  await expect(page.locator('.tag', { hasText: '8.0 × 8.0 × 8.0 mm' })).toBeVisible({ timeout: 60_000 })
  // A successful compile of an edit is a version.
  await expect(picker).toHaveValue('2')
  await expect(picker.locator('option[value="2"]')).toHaveText(/edit/)

  await page.getByRole('button', { name: 'Save version' }).click()
  await expect(picker.locator('option[value="2"]')).toHaveText(/saved/)

  // Back to v1: the list keeps v2, and the source is exactly the starter again.
  await picker.selectOption('1')
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({ timeout: 60_000 })
  await expect(picker.locator('option')).toHaveCount(2)
  await expect(page.locator('.menubar-doc')).not.toContainText('v')
})
```

- [ ] **Step 2:** Add after the CodeMirror-undo test:

```ts
test('/undo steps the document back to the version a turn replaced', async ({ page }) => {
  await seedKey(page)
  await page.route(CHAT_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(fenced('cube([15, 5, 5]);')) }),
  )
  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a bar')
  await expect(page.locator('.tag', { hasText: '15.0 × 5.0 × 5.0 mm' })).toBeVisible({ timeout: 60_000 })
  const picker = page.getByRole('combobox', { name: 'Version' })
  await expect(picker).toHaveValue('2')
  await expect(picker.locator('option[value="2"]')).toHaveText(/a bar/)

  await send(page, '/undo')
  await expect(page.locator('.chat-note', { hasText: 'Restored v1' })).toBeVisible()
  await expect(picker).toHaveValue('1')
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({ timeout: 60_000 })
  // Nothing was thrown away: the turn's version is still there to go forward to.
  await expect(picker.locator('option')).toHaveCount(2)

  await send(page, '/undo')
  await expect(page.locator('.chat-note.bad', { hasText: 'Nothing to undo' })).toBeVisible()
})
```

- [ ] **Step 3:** In the reload test, after reopening the document add `await expect(page.locator('.msg-user', { hasText: 'make me a knurled knob' })).toBeVisible()` — the transcript survives too.

- [ ] **Step 4:** Add a project round trip:

```ts
test('a project exports as one JSON file that imports back as a new document', async ({ page }) => {
  await page.goto('/')
  await waitForStarter(page)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export project' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('A mounting plate.json')
  const text = (await (await import('node:fs/promises')).readFile(await file.path())).toString()
  const project = JSON.parse(text) as { type: string; schemaVersion: number; versions: unknown[] }
  expect(project.type).toBe('vibe3d/project')
  expect(project.schemaVersion).toBe(1)
  expect(project.versions).toHaveLength(1)
  expect(text).not.toContain('sk-or-')

  await page.locator('.menubar input[type="file"]').setInputFiles({
    name: 'plate.json', mimeType: 'application/json', buffer: Buffer.from(text),
  })
  await expect(page.locator('.menubar-doc')).toContainText('A mounting plate 2')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.locator('.start-open')).toHaveCount(2)
})
```

- [ ] **Step 5:** `pnpm e2e` — expect all green (allow ~5 min; the kernel compiles per test).

---

### Task 7: CI and docs

**Files:** Modify `.github/workflows/deploy.yml`, `README.md`, `docs/design.md`.

- [ ] **Step 1:** In `deploy.yml`, delete the `- run: pnpm build` step after `pnpm e2e` (the e2e webServer already built `dist/`); update the comment above `pnpm e2e` to say so.
- [ ] **Step 2: README.** Replace the "Paste a key works too, including keys for other OpenAI-compatible hosts…" bullet with "**Paste a key** works too." and add one sentence under the CSP paragraph: "That allowlist is also why only OpenRouter works as a host in the deployed build." Update "Nothing is saved: the images go on reload and when you switch documents, exactly like the conversation." → "The images are not saved — the conversation is, without them." Add a **Versions** section: every LLM turn, explicit save and successful edit compile is a version; the picker in the menu bar and `/undo` step back; nothing is ever deleted; **Export project** writes one `.json` you can import anywhere.
- [ ] **Step 3: design.md.** Status line → "Milestones 1–3 shipped; Milestone 4 not started." §4 file map: `documents.ts   Doc{versions, head, chat}, the commit rules (§7)`, `project.ts   the .json project file`, `log.ts   … + reviveLog/stripImages`. §7: rewrite the middle to what shipped — the `Version` type as implemented, the three commit points with the folding rule, **restore moves head** (and why: repeatable `/undo`; the list stays append-only and `parentId` keeps the tree), chat persisted with images stripped, the project file shape `{ type: "vibe3d/project", schemaVersion, name, source, head, versions, chat }` with no settings (nothing in a document needs the host), and the "migrate stub" line → "revive is the migration: a pre-version row becomes one `saved` version; a project file with a higher `schemaVersion` is refused by name". §9 "Never persisted" paragraph: the log *is* in the store now; `stripImages` at the boundary is what keeps §7's rule. §9 line 408 `X-Title` → "`X-Title` / `X-OpenRouter-Title` (both allow-listed; verified by preflight 2026-08-31)". §9 line 460: strike the multi-host sentence; note the CSP forbids it in the built artifact by design. §10 `/undo` row → "Steps the head to the previous version. The window is not truncated: the current source is re-attached verbatim on every turn, so the model sees the truth either way, and the transcript keeps the failed turn visible (§7)." Add **§14 Review 2026-08-31** listing the two runtime bugs fixed (turn survives a document switch; preview compile landing after a commit) in two lines.

---

## Self-Review

- **Spec coverage.** §7 Version type ✓ (Task 2), commit on (a)(b)(c) ✓, append-only ✓, restore semantics — changed from "append a copy" to "move head", reasoned and documented (Task 7) ✓, chat persisted ✓ (Tasks 1, 2, 5), images never in the store ✓ (`stripImages`, `reviveLog`), `persist()` boolean surfaced ✓ (durability note), project file with `schemaVersion` refusal ✓ (Task 3), never `apiKey` ✓ (named fields + exact-keys test), §10 `/undo` ✓ (Tasks 4, 5, 6), §12 migrate ✓ (`reviveVersions` + legacy test). Review findings 1–6 ✓ (Tasks 4, 5, 7).
- **Placeholders.** None; every step carries its code.
- **Type consistency.** `commitTurn(session, source, label, compileOk, now)` is used identically in Tasks 2, 3 and 5; `onApply(next, result, label)` matches between Chat and App; `headVersion(doc).id` is what the picker's `value` and the `/undo` note both read.
