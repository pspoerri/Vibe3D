import { existsSync } from 'node:fs'
import { expect, test } from 'vitest'
import { FONT_FILES, installFonts, usesText } from './fonts'

test('every face the prompt promises is vendored', () => {
  for (const name of FONT_FILES) {
    expect(existsSync(new URL(`./vendor/fonts/${name}`, import.meta.url)), name).toBe(true)
  }
  expect(existsSync(new URL('./vendor/fonts/LICENSE', import.meta.url))).toBe(true)
})

test('usesText spots text() and textmetrics(), not a variable called text', () => {
  expect(usesText('linear_extrude(1) text("hi");')).toBe(true)
  expect(usesText('m = textmetrics ("hi");')).toBe(true)
  expect(usesText('text = 3; cube(text);')).toBe(false)
  expect(usesText('context(1);')).toBe(false)
})

test('installFonts writes the config and the faces, and points fontconfig at the config', () => {
  const written = new Map<string, string | Uint8Array>()
  const dirs: string[] = []
  const kernel = {
    FS: { writeFile: (p: string, d: string | Uint8Array) => void written.set(p, d), readFile: () => new Uint8Array(), unlink: () => {}, mkdir: (p: string) => void dirs.push(p) },
    ENV: {} as Record<string, string>,
  }
  installFonts(kernel, { 'LiberationSans-Regular.ttf': new Uint8Array([1]) })
  expect(dirs).toEqual(['/fonts'])
  expect(kernel.ENV.FONTCONFIG_FILE).toBe('/fonts/fonts.conf')
  expect(written.get('/fonts/fonts.conf')).toMatch(/<dir>\/fonts<\/dir>/)
  expect(written.get('/fonts/LiberationSans-Regular.ttf')).toEqual(new Uint8Array([1]))
})
