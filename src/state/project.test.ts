import { expect, test } from 'vitest'
import { commitTurn, currentDoc, newDoc, setChat } from './documents'
import { exportProject, importProject, PROJECT_TYPE, SCHEMA_VERSION } from './project'

const sample = () => {
  const session = { docs: [newDoc('Bracket', 'cube(1);', 'd1', 1)], currentId: 'd1' }
  return currentDoc(
    setChat(commitTurn(session, 'cube(2);', 'bigger', true, 2), [
      { id: 'u', ts: 2, turn: 1, kind: 'user', text: 'bigger', images: ['data:image/jpeg;base64,AAA'] },
    ]),
  )
}

test('the file carries exactly the named fields — no id, no settings, no key, no images', () => {
  const parsed = JSON.parse(exportProject(sample())) as Record<string, unknown>
  expect(Object.keys(parsed).sort()).toEqual([
    'chat', 'head', 'name', 'schemaVersion', 'source', 'type', 'versions',
  ])
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
  expect(() => importProject('{"type":"other/thing","schemaVersion":1}', 'x', 1)).toThrow(
    'not a Vibe3D project',
  )
  expect(() => importProject('{"type":"vibe3d/project"}', 'x', 1)).toThrow('not a Vibe3D project')
  expect(() =>
    importProject('{"type":"vibe3d/project","schemaVersion":2,"source":"cube(1);"}', 'x', 1),
  ).toThrow('schema 2')
  expect(() => importProject('{"type":"vibe3d/project","schemaVersion":1}', 'x', 1)).toThrow(
    'no source',
  )
})
