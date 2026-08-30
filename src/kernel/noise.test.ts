import { expect, test } from 'vitest'
import { stripKernelNoise } from './noise'

test('strips the localization warning the kernel always prints', () => {
  const raw =
    "Could not initialize localization (application path is '/').\n" +
    'ERROR: Parser error: syntax error in file /in.scad, line 1\n'
  // The virtual path is rewritten too — see the next test.
  expect(stripKernelNoise(raw)).toBe('ERROR: Parser error: syntax error in file model.scad, line 1')
})

test('rewrites the kernel virtual path to something a user recognises', () => {
  const raw = 'ERROR: Parser error: syntax error in file /in.scad, line 3\n'
  expect(stripKernelNoise(raw)).toBe('ERROR: Parser error: syntax error in file model.scad, line 3')
})

test('drops blank lines but keeps real content', () => {
  expect(stripKernelNoise('\n\nWARNING: something\n\n')).toBe('WARNING: something')
})

test('returns an empty string when there is nothing but noise', () => {
  expect(stripKernelNoise("Could not initialize localization (application path is '/').\n")).toBe('')
})

test('caps runaway output at 100 lines, keeping head and tail', () => {
  const raw = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
  const out = stripKernelNoise(raw).split('\n')
  expect(out).toHaveLength(101) // 50 head + 1 elision + 50 tail
  expect(out[0]).toBe('line 0')
  expect(out[50]).toBe('... 150 more lines ...')
  expect(out[100]).toBe('line 249')
})
