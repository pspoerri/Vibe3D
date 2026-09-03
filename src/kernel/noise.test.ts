import { expect, test } from 'vitest'
import { kernelWarnings, stderrForModel, stripKernelNoise } from './noise'

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

test('the model form leaves the kernel path and line numbers untouched', () => {
  const raw =
    "Could not initialize localization (application path is '/').\n" +
    'ERROR: Parser error: syntax error in file /in.scad, line 1\n'
  // design.md §5: the model must be able to trust the diagnostic against the
  // source it just wrote, so nothing is rewritten — but the unconditional
  // localization line would read as a first error to repair, so it still goes.
  expect(stderrForModel(raw)).toBe('ERROR: Parser error: syntax error in file /in.scad, line 1')
})

test('the model form caps runaway output the same way', () => {
  const raw = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
  const out = stderrForModel(raw).split('\n')
  expect(out).toHaveLength(101)
  expect(out[50]).toBe('... 150 more lines ...')
  expect(out[100]).toBe('line 249')
})

test('the two forms differ only in the path rewrite', () => {
  const raw = 'ERROR: something in file /in.scad, line 9\n'
  expect(stripKernelNoise(raw)).toBe(stderrForModel(raw).replaceAll('/in.scad', 'model.scad'))
})

test('kernelWarnings keeps WARNING and DEPRECATED lines and drops the statistics chatter', () => {
  const stderr = [
    'Could not initialize localization (application path is ...)',
    'WARNING: Ignoring unknown variable "size" in file /in.scad, line 1',
    'Geometries in cache: 1',
    'DEPRECATED: The assign() module will be removed in future releases.',
    'Total rendering time: 0:00:00.002',
    'Top level object is a 3D object (PolySet):',
  ].join('\n')
  expect(kernelWarnings(stderr)).toBe(
    'WARNING: Ignoring unknown variable "size" in file /in.scad, line 1\nDEPRECATED: The assign() module will be removed in future releases.',
  )
  expect(kernelWarnings('Geometries in cache: 1\n')).toBe('')
})
