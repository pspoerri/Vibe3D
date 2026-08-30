import { expect, test } from 'vitest'
import {
  createSession,
  currentDoc,
  deleteDoc,
  newDoc,
  renameDoc,
  reviveSession,
  selectDoc,
  forkDoc,
  nameFromFirstPrompt,
  nameFromPrompt,
  suggestName,
  updateSource,
  versionFamily,
  versionNumber,
  type Session,
} from './documents'

/** The starter document from App.tsx: its first line is a `//` comment. */
const STARTER = `// A mounting plate. Drag the numbers, or edit freely.
$fn = 64;

plate_x = 60;  // [20:120]
cube([plate_x, 10, 3]);
`

const three = (): Session => ({
  docs: [
    { id: 'a', name: 'A', source: 'cube(1);', createdAt: 1, updatedAt: 1, parentId: null },
    { id: 'b', name: 'B', source: 'cube(2);', createdAt: 2, updatedAt: 2, parentId: null },
    { id: 'c', name: 'C', source: 'cube(3);', createdAt: 3, updatedAt: 3, parentId: null },
  ],
  currentId: 'b',
})

test('a new session holds one document, named after the source, and it is current', () => {
  const session = createSession(STARTER, 'id-1', 1000)
  expect(session).toEqual({
    docs: [
      {
        id: 'id-1',
        name: 'A mounting plate',
        source: STARTER,
        createdAt: 1000,
        updatedAt: 1000,
        parentId: null,
      },
    ],
    currentId: 'id-1',
  })
  expect(currentDoc(session)).toBe(session.docs[0])
  expect(newDoc('Bracket', 'cube(1);', 'id-2', 7)).toEqual({
    id: 'id-2',
    name: 'Bracket',
    source: 'cube(1);',
    createdAt: 7,
    updatedAt: 7,
    parentId: null,
  })
})

test('every operation leaves its input untouched', () => {
  const session = three()
  const before = structuredClone(session)
  selectDoc(session, 'c')
  updateSource(session, 'sphere(1);', 99)
  renameDoc(session, 'b', 'Renamed')
  deleteDoc(session, 'b', 'fresh', 99)
  expect(session).toEqual(before)
})

test('selecting switches the current document, and an unknown id changes nothing', () => {
  const session = three()
  expect(currentDoc(selectDoc(session, 'c')).id).toBe('c')
  expect(selectDoc(session, 'gone')).toEqual(session)
})

test('editing rewrites only the current document and stamps it', () => {
  const next = updateSource(three(), 'sphere(1);', 500)
  expect(currentDoc(next)).toEqual({
    id: 'b', name: 'B', source: 'sphere(1);', createdAt: 2, updatedAt: 500, parentId: null,
  })
  // createdAt does not move: it is what orders a version family.
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
  expect(next).toEqual({
    docs: [
      { id: 'fresh', name: 'Untitled', source: '', createdAt: 99, updatedAt: 99, parentId: null },
    ],
    currentId: 'fresh',
  })
  expect(currentDoc(next).id).toBe('fresh')
})

test('currentDoc returns a document even when the pointer has rotted', () => {
  const rotten: Session = { docs: three().docs, currentId: 'gone' }
  expect(currentDoc(rotten).id).toBe('a')
  expect(currentDoc({ docs: [], currentId: 'gone' })).toEqual({
    id: 'gone',
    name: 'Untitled',
    source: '',
    createdAt: 0,
    updatedAt: 0,
    parentId: null,
  })
})

test('a session round-trips through revive unchanged', () => {
  const session = three()
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
    docs: [
      { id: 'b', name: 'Untitled', source: 'cube(2);', createdAt: 99, updatedAt: 99, parentId: null },
    ],
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
  // The cleaned form: the leading article is stripped and the first letter cased.
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

test('only the first prompt names a document, and never over a chosen title', () => {
  const fresh: Session = { docs: [newDoc('Untitled', '', 'a', 1)], currentId: 'a' }
  const named = nameFromFirstPrompt(fresh, 'a hex bolt', 2)
  expect(currentDoc(named).name).toBe('Hex bolt')

  // A name merely derived from the source is a placeholder, so the first prompt
  // replaces it — that is the common case, since the starter is source-named.
  const fromSource = createSession(STARTER, 'z', 1)
  expect(currentDoc(fromSource).name).toBe('A mounting plate')
  expect(currentDoc(nameFromFirstPrompt(fromSource, 'a knurled knob', 2)).name).toBe('Knurled knob')

  // The second prompt is an edit, not a description of the part.
  expect(nameFromFirstPrompt(named, 'make it 2 mm taller', 3)).toBe(named)
  // And a title the user typed is theirs.
  const mine = renameDoc(fresh, 'a', 'My bolt')
  expect(nameFromFirstPrompt(mine, 'a hex bolt', 4)).toBe(mine)
})

test('a new version is a document that remembers where it came from', () => {
  const forked = forkDoc(three(), 'b', 'b2', 500)
  expect(forked.currentId).toBe('b2')
  expect(forked.docs).toHaveLength(4)
  const copy = currentDoc(forked)
  expect(copy).toMatchObject({ source: 'cube(2);', name: 'B', parentId: 'b', createdAt: 500 })
  // The original is untouched, which is the whole point of keeping versions.
  expect(forked.docs[1]).toEqual(three().docs[1])
})

test('a version family is numbered by creation, so two forks of one parent differ', () => {
  let session = forkDoc(three(), 'b', 'b2', 500)
  session = forkDoc(session, 'b', 'b3', 600)

  expect(versionFamily(session, 'b').map((d) => d.id)).toEqual(['b', 'b2', 'b3'])
  expect(versionNumber(session, 'b')).toBe(1)
  expect(versionNumber(session, 'b2')).toBe(2)
  // Depth would label both forks v2; creation order does not.
  expect(versionNumber(session, 'b3')).toBe(3)
  // A document nobody forked carries no version tag at all.
  expect(versionNumber(session, 'a')).toBe(0)
})

test('a lineage that outlived its parent, or points at itself, still resolves', () => {
  // Both shapes are reachable from a partly-written store.
  const orphan = reviveSession(
    { docs: [{ id: 'x', source: 'cube(1);', parentId: 'deleted' }], currentId: 'x' },
    STARTER,
    'fresh',
    99,
  )
  expect(currentDoc(orphan).parentId).toBeNull()

  const cyclic: Session = {
    docs: [{ id: 'x', name: 'X', source: '', createdAt: 1, updatedAt: 1, parentId: 'x' }],
    currentId: 'x',
  }
  expect(() => versionFamily(cyclic, 'x')).not.toThrow()
  expect(versionFamily(cyclic, 'x').map((d) => d.id)).toEqual(['x'])
})
