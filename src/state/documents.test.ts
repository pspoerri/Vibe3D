import { expect, test } from 'vitest'
import type { ChatEvent } from '../chat/log'
import {
  addComponent,
  commitEdit,
  commitTurn,
  createSession,
  currentDoc,
  deleteDoc,
  headVersion,
  nameFromFirstPrompt,
  nameFromFirstTurn,
  nameFromPrompt,
  newDoc,
  removeComponent,
  renameDoc,
  restoreVersion,
  reviveSession,
  saveVersion,
  selectDoc,
  setChat,
  suggestName,
  undoVersion,
  updateSource,
  type Component,
  type Doc,
  type Session,
  type Version,
} from './documents'

/** The starter document from App.tsx: its first line is a `//` comment. */
const STARTER = `// A mounting plate. Drag the numbers, or edit freely.
$fn = 64;

plate_x = 60;  // [20:120]
cube([plate_x, 10, 3]);
`

const v = (id: string, source: string, label = 'new'): Version => ({
  id,
  parentId: id === '1' ? null : String(Number(id) - 1),
  ts: 0,
  label,
  source,
  compileOk: false,
})
const doc = (id: string, name: string, source: string, ts: number): Doc => ({
  id,
  name,
  source,
  createdAt: ts,
  updatedAt: ts,
  versions: [{ ...v('1', source), ts }],
  head: '1',
  chat: [],
  components: [],
})
const three = (): Session => ({
  docs: [doc('a', 'A', 'cube(1);', 1), doc('b', 'B', 'cube(2);', 2), doc('c', 'C', 'cube(3);', 3)],
  currentId: 'b',
})
const shape = (d: Doc) => d.versions.map((x) => [x.id, x.label, x.source, x.compileOk])

test('a new session holds one document, named after the source, and it is current', () => {
  const session = createSession(STARTER, 'id-1', 1000)
  expect(session).toEqual({ docs: [doc('id-1', 'A mounting plate', STARTER, 1000)], currentId: 'id-1' })
  expect(currentDoc(session)).toBe(session.docs[0])
  expect(newDoc('Bracket', 'cube(1);', 'id-2', 7)).toEqual(doc('id-2', 'Bracket', 'cube(1);', 7))
})

test('every operation leaves its input untouched', () => {
  const session = three()
  const before = structuredClone(session)
  selectDoc(session, 'c')
  updateSource(session, 'sphere(1);', 99)
  renameDoc(session, 'b', 'Renamed')
  deleteDoc(session, 'b', 'fresh', 99)
  commitTurn(session, 'cube(9);', 'nine', true, 99)
  commitEdit(session, 'cube(2);', 99)
  saveVersion(session, 99)
  restoreVersion(session, '1', 99)
  undoVersion(session, 99)
  setChat(session, [{ id: 'x', ts: 0, turn: 1, kind: 'clear' }])
  expect(session).toEqual(before)
})

test('selecting switches the current document, and an unknown id changes nothing', () => {
  const session = three()
  expect(currentDoc(selectDoc(session, 'c')).id).toBe('c')
  expect(selectDoc(session, 'gone')).toEqual(session)
})

test('editing rewrites only the current document and stamps it', () => {
  const next = updateSource(three(), 'sphere(1);', 500)
  expect(currentDoc(next)).toEqual({ ...doc('b', 'B', 'cube(2);', 2), source: 'sphere(1);', updatedAt: 500 })
  expect(next.docs[0]).toEqual(three().docs[0])
  expect(next.docs[2]).toEqual(three().docs[2])
})

test('an unchanged source is not a change, so an idle autosave loop stops', () => {
  const session = three()
  const next = updateSource(session, 'cube(2);', 500)
  expect(currentDoc(next).updatedAt).toBe(2)
  expect(next).toBe(session)
})

test('renaming touches the name alone, and a blank name is not a name', () => {
  const next = renameDoc(three(), 'b', '  Bracket  ')
  // `named` marks it as the user's own title, so a later prompt cannot replace it.
  expect(currentDoc(next)).toMatchObject({ id: 'b', name: 'Bracket', source: 'cube(2);', named: true })
  expect(renameDoc(next, 'b', '   ')).toEqual(next)
  expect(renameDoc(next, 'gone', 'x')).toEqual(next)
})

test('deleting the current document selects a neighbour', () => {
  const next = deleteDoc(three(), 'b', 'fresh', 99)
  expect(next.docs.map((d) => d.id)).toEqual(['a', 'c'])
  expect(currentDoc(next).id).toBe('c')
})

test('deleting the last row falls back to the row above it', () => {
  const next = deleteDoc(selectDoc(three(), 'c'), 'c', 'fresh', 99)
  expect(currentDoc(next).id).toBe('b')
})

test('deleting some other document leaves the selection where it was', () => {
  const next = deleteDoc(three(), 'a', 'fresh', 99)
  expect(currentDoc(next).id).toBe('b')
  expect(deleteDoc(three(), 'gone', 'fresh', 99)).toEqual(three())
})

test('deleting the only document leaves a fresh empty one selected, never none', () => {
  const next = deleteDoc(createSession(STARTER, 'only', 1), 'only', 'fresh', 99)
  expect(next).toEqual({ docs: [doc('fresh', 'Untitled', '', 99)], currentId: 'fresh' })
  expect(currentDoc(next).id).toBe('fresh')
})

test('currentDoc returns a document even when the pointer has rotted', () => {
  const rotten: Session = { docs: three().docs, currentId: 'gone' }
  expect(currentDoc(rotten).id).toBe('a')
  expect(currentDoc({ docs: [], currentId: 'gone' })).toEqual(doc('gone', 'Untitled', '', 0))
})

test('a session round-trips through revive unchanged', () => {
  const session = setChat(commitTurn(three(), 'cube(20);', 'bigger', true, 5), [
    { id: 'u', ts: 5, turn: 1, kind: 'user', text: 'bigger' },
  ])
  expect(reviveSession(JSON.parse(JSON.stringify(session)), STARTER, 'fresh', 99)).toEqual(session)
})

test('anything that is not a session degrades to a fresh one', () => {
  const fresh = createSession(STARTER, 'fresh', 99)
  const garbage: unknown[] = [
    null,
    undefined,
    'cube(1);',
    42,
    [],
    [{ id: 'a', name: 'A', source: 'cube(1);', updatedAt: 1 }],
    {},
    { docs: [] },
    { docs: {}, currentId: 'a' },
    { docs: [null], currentId: 'a' },
    { docs: [{ id: 'a', name: 'A', updatedAt: 1 }], currentId: 'a' },
    { docs: [{ id: 'a', name: 'A', source: 42, updatedAt: 1 }], currentId: 'a' },
    { docs: [{ name: 'A', source: 'cube(1);', updatedAt: 1 }], currentId: 'a' },
  ]
  for (const raw of garbage) {
    const label = JSON.stringify(raw) ?? 'undefined'
    expect(reviveSession(raw, STARTER, 'fresh', 99), label).toEqual(fresh)
  }
})

test('a currentId naming a deleted document resolves to the first surviving one', () => {
  const raw = { docs: three().docs, currentId: 'deleted-long-ago' }
  const revived = reviveSession(raw, STARTER, 'fresh', 99)
  expect(currentDoc(revived).id).toBe('a')
})

test('one corrupt row does not cost the user every other document', () => {
  const raw = { docs: [null, { id: 'b', source: 'cube(2);' }], currentId: 'b' }
  const revived = reviveSession(raw, STARTER, 'fresh', 99)
  expect(revived).toEqual({
    docs: [{ ...doc('b', 'Untitled', 'cube(2);', 99), versions: [{ ...v('1', 'cube(2);', 'saved'), ts: 99 }] }],
    currentId: 'b',
  })
})

test('a name is derived from the source so a list reads without being named', () => {
  expect(suggestName(STARTER, [])).toBe('A mounting plate')
  // A trailing `// [20:120]` parameter annotation is not a title.
  expect(suggestName('plate_x = 60; // [20:120]\nmodule bracket(w) {}', [])).toBe('bracket')
  expect(suggestName('function fillet(r) = r * 2;', [])).toBe('fillet')
  expect(suggestName('cube(1);', [])).toBe('Untitled')
  expect(suggestName('', [])).toBe('Untitled')
  expect(suggestName(`// ${'x'.repeat(80)}`, [])).toBe(`${'x'.repeat(40)}…`)
})

test('two rows never carry the same name', () => {
  expect(suggestName(STARTER, ['A mounting plate'])).toBe('A mounting plate 2')
  expect(suggestName(STARTER, ['A mounting plate', 'A mounting plate 2'])).toBe('A mounting plate 3')
  expect(suggestName(STARTER, ['A mounting plate 2'])).toBe('A mounting plate')
})

test('a name comes from the prompt, with the asking stripped off the front', () => {
  expect(nameFromPrompt('make me a knurled knob with a D-shaft', [])).toBe(
    'Knurled knob with a D-shaft',
  )
  expect(nameFromPrompt('Please could you design an enclosure', [])).toBe('Enclosure')
  expect(nameFromPrompt('a 30 mm bracket', [])).toBe('30 mm bracket')
  // Not a request at all — the words are the part.
  expect(nameFromPrompt('hex bolt, M8', [])).toBe('Hex bolt, M8')
})

test('a long prompt is cut at a word, and a blank one names nothing', () => {
  const name = nameFromPrompt('a parametric vase with twenty flutes and a rolled lip on top', [])
  expect(name.length).toBeLessThanOrEqual(41)
  expect(name.endsWith('…')).toBe(true)
  // Cut on a word boundary: what is kept must be followed by a space in the
  // original, so the last word shown is never half a word.
  const kept = name.slice(0, -1)
  const original = 'Parametric vase with twenty flutes and a rolled lip on top'
  expect(original.startsWith(kept)).toBe(true)
  expect(original.charAt(kept.length)).toBe(' ')
  expect(nameFromPrompt('   ', [])).toBe('Untitled')
  expect(nameFromPrompt('make me a', [])).toBe('Untitled')
})

test('two documents never end up with the same name', () => {
  expect(nameFromPrompt('a bracket', ['Bracket'])).toBe('Bracket 2')
  expect(nameFromPrompt('a bracket', ['Bracket', 'Bracket 2'])).toBe('Bracket 3')
})

test('the prompt names a document provisionally, and never over a chosen title', () => {
  const fresh: Session = { docs: [newDoc('Untitled', '', 'a', 1)], currentId: 'a' }
  const named = nameFromFirstPrompt(fresh, 'a hex bolt')
  expect(currentDoc(named)).toMatchObject({ name: 'Hex bolt' })
  expect(currentDoc(named).named).toBeUndefined()

  // A name merely derived from the source is a placeholder, so the first prompt
  // replaces it — that is the common case, since the starter is source-named.
  const fromSource = createSession(STARTER, 'z', 1)
  expect(currentDoc(fromSource).name).toBe('A mounting plate')
  expect(currentDoc(nameFromFirstPrompt(fromSource, 'a knurled knob')).name).toBe('Knurled knob')

  // A title the user typed is theirs.
  const mine = renameDoc(fresh, 'a', 'My bolt')
  expect(nameFromFirstPrompt(mine, 'a hex bolt')).toBe(mine)
})

test('the first turn names the document from its title line, and then the name is final', () => {
  const fresh: Session = { docs: [newDoc('Untitled', '', 'a', 1)], currentId: 'a' }
  const asked = nameFromFirstPrompt(fresh, 'a hex bolt')

  // The model's title beats the prompt: one is the thing, the other the wish.
  const titled = nameFromFirstTurn(asked, '// M8 hex bolt, 30 mm. Printable.\ncylinder(8);')
  expect(currentDoc(titled)).toMatchObject({ name: 'M8 hex bolt, 30 mm', named: true })
  // The second prompt is an edit, not a description of the part.
  expect(nameFromFirstPrompt(titled, 'make it 2 mm taller')).toBe(titled)
  expect(nameFromFirstTurn(titled, '// Something else\ncube(1);')).toBe(titled)

  // No title line: the provisional name stands, and becomes final.
  expect(currentDoc(nameFromFirstTurn(asked, 'cylinder(8);'))).toMatchObject({
    name: 'Hex bolt', named: true,
  })
  // Nothing to name it after at all: it stays open for the next prompt.
  expect(nameFromFirstTurn(fresh, 'cylinder(8);')).toBe(fresh)
  // Deduped against the other documents, like every name.
  const two: Session = { docs: [newDoc('Knob', 'x', 'k', 1), ...fresh.docs], currentId: 'a' }
  expect(currentDoc(nameFromFirstTurn(two, '// Knob\nsphere(5);')).name).toBe('Knob 2')
  // And never over the user's own title.
  const mine = renameDoc(fresh, 'a', 'My bolt')
  expect(nameFromFirstTurn(mine, '// Hex bolt\ncylinder(8);')).toBe(mine)
})

test('two rows sharing an id cannot both survive revive', () => {
  // Duplicates destroy documents twice over: editing the first overwrites the
  // second's source, and deleting either removes BOTH, emptying the list and
  // replacing the library with one blank document.
  const revived = reviveSession(
    {
      docs: [
        { id: 'a', name: 'Knob', source: 'KNOB' },
        { id: 'a', name: 'Bracket', source: 'BRACKET' },
      ],
      currentId: 'a',
    },
    STARTER,
    'fresh',
    99,
  )
  expect(revived.docs).toHaveLength(1)

  const edited = updateSource(revived, 'EDITED', 100)
  expect(edited.docs).toHaveLength(1)
  const gone = deleteDoc(edited, 'a', 'fresh', 101)
  expect(gone.docs.map((d) => d.source)).toEqual([''])
})

test('a hyphenated part name keeps its first letter', () => {
  // \b fires on a hyphen, so the article was being eaten out of the word.
  expect(nameFromPrompt('A-frame shelf bracket', [])).toBe('A-frame shelf bracket')
  expect(nameFromPrompt('AN-8 fitting', [])).toBe('AN-8 fitting')
  expect(nameFromPrompt('a 30 mm bracket', [])).toBe('30 mm bracket')
})

test('recovery never invents two documents with the same name', () => {
  const revived = reviveSession(
    {
      docs: [
        { id: 'a', source: '// Plate\ncube(1);' },
        { id: 'b', source: '// Plate\ncube(2);' },
      ],
      currentId: 'a',
    },
    STARTER,
    'fresh',
    99,
  )
  expect(revived.docs.map((d) => d.name)).toEqual(['Plate', 'Plate 2'])
})

test('an edit is never dropped, even against a session with no rows', () => {
  const rescued = updateSource({ docs: [], currentId: 'x' }, 'THE USERS WORK', 5)
  expect(currentDoc(rescued).source).toBe('THE USERS WORK')
  expect(rescued.docs).toHaveLength(1)
})

// ---- versions (design.md §7) ------------------------------------------------

test('an LLM turn commits a version labelled by its prompt, and the head follows it', () => {
  const next = commitTurn(three(), 'cube(20);', 'make it   bigger please', true, 500)
  const d = currentDoc(next)
  expect(d.source).toBe('cube(20);')
  expect(d.head).toBe('2')
  expect(d.versions[1]).toEqual({
    id: '2', parentId: '1', ts: 500, label: 'make it bigger please', source: 'cube(20);', compileOk: true,
  })
  expect(d.updatedAt).toBe(500)
  expect(headVersion(d)).toBe(d.versions[1])
  // A label is cut to a line, and a blank one still reads as something.
  expect(headVersion(currentDoc(commitTurn(next, 'cube(21);', 'x'.repeat(80), true, 501))).label).toHaveLength(48)
  expect(headVersion(currentDoc(commitTurn(next, 'cube(22);', '   ', true, 502))).label).toBe('edit')
})

test('a turn that overwrites manual edits keeps them as a version first', () => {
  const edited = updateSource(three(), 'cube(2.5);', 10)
  const next = commitTurn(edited, 'cube(20);', 'bigger', true, 500)
  expect(shape(currentDoc(next))).toEqual([
    ['1', 'new', 'cube(2);', false],
    ['2', 'edit', 'cube(2.5);', false],
    ['3', 'bigger', 'cube(20);', true],
  ])
  expect(currentDoc(next).versions[2]?.parentId).toBe('2')
})

test('consecutive manual edits fold into one version; a later change starts a new one', () => {
  let s = updateSource(three(), 'cube(3);', 10)
  s = commitEdit(s, 'cube(3);', 11)
  expect(shape(currentDoc(s))).toEqual([['1', 'new', 'cube(2);', false], ['2', 'edit', 'cube(3);', true]])
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
    ['1', 'new', 'cube(2);'],
    ['2', 'bigger', 'cube(20);'],
    ['3', 'bigger still', 'cube(30);'],
    ['4', 'edit', 'cube(31);'],
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
  const legacy = {
    docs: [{ id: 'a', name: 'A', source: 'cube(1);', createdAt: 1, updatedAt: 2, parentId: null }],
    currentId: 'a',
  }
  const d = currentDoc(reviveSession(legacy, STARTER, 'fresh', 99))
  expect(d.versions).toEqual([
    { id: '1', parentId: null, ts: 1, label: 'saved', source: 'cube(1);', compileOk: false },
  ])
  expect(d.head).toBe('1')
  expect(d.chat).toEqual([])
  expect('parentId' in d).toBe(false)
})

test('revive renumbers versions, remaps head and parents, and drops what it cannot read', () => {
  const raw = {
    docs: [
      {
        id: 'a',
        source: 'C',
        versions: [
          { id: 'x', source: 'A', label: 'new', ts: 1 },
          null,
          { id: 'y', source: 'B', parentId: 'x', label: '', compileOk: 'yes' },
          { id: 'z', source: 'C', parentId: 'y', compileOk: true },
          { id: 'w' },
        ],
        head: 'y',
        chat: [{ id: 'u', turn: 1, kind: 'user', text: 'hi' }, 'junk'],
      },
    ],
    currentId: 'a',
  }
  const d = currentDoc(reviveSession(raw, STARTER, 'fresh', 99))
  expect(d.versions.map((x) => [x.id, x.parentId, x.label, x.compileOk])).toEqual([
    ['1', null, 'new', false],
    ['2', '1', 'saved', false],
    ['3', '2', 'saved', true],
  ])
  expect(d.head).toBe('2')
  expect(d.chat).toEqual([{ id: 'u', ts: 0, turn: 1, kind: 'user', text: 'hi' }])
  const dangling = currentDoc(
    reviveSession(
      { docs: [{ id: 'a', source: 'S', versions: [{ id: 'q', source: 'S' }], head: 'nope' }], currentId: 'a' },
      STARTER,
      'fresh',
      99,
    ),
  )
  expect(dangling.head).toBe('1')
})

// ---- components (design.md §8) ---------------------------------------------------

const comp = (name: string, byte = 1): Component => ({
  name,
  bytes: new Uint8Array([byte]),
  min: [0, 0, 0],
  max: [10, 20, 30],
})

test('a new document has no components, and adding one stamps the document', () => {
  const s = three()
  expect(currentDoc(s).components).toEqual([])
  const next = addComponent(s, comp('bracket.stl'), 99)
  expect(currentDoc(next).components).toEqual([comp('bracket.stl')])
  expect(currentDoc(next).updatedAt).toBe(99)
  expect(currentDoc(s).components).toEqual([])
})

test('adding a component under a taken name replaces it in place', () => {
  let s = addComponent(three(), comp('a.stl', 1), 1)
  s = addComponent(s, comp('b.obj', 2), 2)
  s = addComponent(s, comp('a.stl', 3), 3)
  expect(currentDoc(s).components.map((c) => [c.name, c.bytes[0]])).toEqual([
    ['a.stl', 3],
    ['b.obj', 2],
  ])
})

test('removing a component by name, and removing one that is not there changes nothing', () => {
  const s = addComponent(three(), comp('a.stl'), 1)
  expect(currentDoc(removeComponent(s, 'a.stl', 2)).components).toEqual([])
  expect(removeComponent(s, 'zzz.stl', 2)).toBe(s)
})

test('revive keeps well-formed components, accepts base64 bytes, and drops the rest', () => {
  const raw = {
    ...doc('a', 'A', 'cube(1);', 1),
    components: [
      comp('good.stl', 7),
      { name: 'b64.obj', bytes: btoa('\x05'), min: [1, 2, 3], max: [4, 5, 6] },
      { name: '../evil.stl', bytes: new Uint8Array([1]), min: [0, 0, 0], max: [1, 1, 1] },
      { name: 'notes.txt', bytes: new Uint8Array([1]), min: [0, 0, 0], max: [1, 1, 1] },
      { name: 'nobytes.stl', min: [0, 0, 0], max: [1, 1, 1] },
      { name: 'badbox.stl', bytes: new Uint8Array([1]), min: [0, 0], max: [1, 1, 1] },
      { name: 'nan.stl', bytes: new Uint8Array([1]), min: [0, 0, 'x'], max: [1, 1, 1] },
      'garbage',
    ],
  }
  const revived = reviveSession({ docs: [raw], currentId: 'a' }, '', 'x', 0)
  expect(currentDoc(revived).components).toEqual([
    comp('good.stl', 7),
    { name: 'b64.obj', bytes: new Uint8Array([5]), min: [1, 2, 3], max: [4, 5, 6] },
  ])
})

test('a row with no components field revives with an empty list', () => {
  const revived = reviveSession({ docs: [doc('a', 'A', 'cube(1);', 1)], currentId: 'a' }, '', 'x', 0)
  expect(currentDoc(revived).components).toEqual([])
})
