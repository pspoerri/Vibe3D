import { expect, test } from 'vitest'
import { errorLineOf } from './Editor'

test('the error line is read off the kernel diagnostic', () => {
  expect(errorLineOf('ERROR: Parser error: syntax error in file model.scad, line 12\nExecution aborted')).toBe(12)
  expect(errorLineOf('WARNING: Ignoring unknown variable wal in file model.scad, line 3')).toBe(3)
  expect(errorLineOf('Compile cancelled.')).toBe(null)
  expect(errorLineOf(null)).toBe(null)
})
