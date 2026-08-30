import { expect, test } from 'vitest'
import { parseCommand } from './commands'

test('the argument-free commands', () => {
  expect(parseCommand('/clear')).toEqual({ name: 'clear' })
  expect(parseCommand('/compact')).toEqual({ name: 'compact' })
  expect(parseCommand('/key')).toEqual({ name: 'key' })
})

test('surrounding whitespace and case do not matter', () => {
  expect(parseCommand('  /Clear  ')).toEqual({ name: 'clear' })
})

test('a trailing argument on an argument-free command is ignored', () => {
  expect(parseCommand('/clear everything')).toEqual({ name: 'clear' })
})

test('/model carries its id, or null to open the picker', () => {
  expect(parseCommand('/model')).toEqual({ name: 'model', id: null })
  expect(parseCommand('/model  ')).toEqual({ name: 'model', id: null })
  // Model ids are case-sensitive slugs, so the argument is never lowercased.
  expect(parseCommand('/model Qwen/Qwen3-Max')).toEqual({ name: 'model', id: 'Qwen/Qwen3-Max' })
})

test('/export defaults to 3mf and accepts stl', () => {
  expect(parseCommand('/export')).toEqual({ name: 'export', format: '3mf' })
  expect(parseCommand('/export 3mf')).toEqual({ name: 'export', format: '3mf' })
  expect(parseCommand('/export stl')).toEqual({ name: 'export', format: 'binstl' })
  expect(parseCommand('/export STL')).toEqual({ name: 'export', format: 'binstl' })
  expect(parseCommand('/export binstl')).toEqual({ name: 'export', format: 'binstl' })
})

test('an unrecognised slash word never reaches the model', () => {
  // /undo is M3's; a stub that half-works is worse than an honest error.
  expect(parseCommand('/undo')).toEqual({ name: 'unknown', word: 'undo' })
  expect(parseCommand('/help me')).toEqual({ name: 'unknown', word: 'help' })
})

test('ordinary messages are not commands', () => {
  expect(parseCommand('make it 1/2 as tall')).toBeNull()
  expect(parseCommand('')).toBeNull()
  expect(parseCommand('   ')).toBeNull()
  // A lone slash, a path and a comment are prose, not a mistyped command.
  expect(parseCommand('/')).toBeNull()
  expect(parseCommand('/ clear')).toBeNull()
  expect(parseCommand('/usr/local is where it lives')).toBeNull()
  expect(parseCommand('// a comment')).toBeNull()
})
