import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const sha = (p: string) =>
  createHash('sha256').update(readFileSync(new URL(p, import.meta.url))).digest('hex')

test('vendored kernel matches the pinned checksums', () => {
  const pins = readFileSync(new URL('./VERSION', import.meta.url), 'utf8')
  expect(pins).toContain(sha('./openscad.js'))
  expect(pins).toContain(sha('./openscad.wasm'))
})

test('vendored kernel is single-threaded', () => {
  const glue = readFileSync(new URL('./openscad.js', import.meta.url), 'utf8')
  expect(glue).not.toMatch(/SharedArrayBuffer|pthread/)
})
