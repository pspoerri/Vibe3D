import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { applyParts, checkParts, constructionSource, parsePartBlocks } from './parts'

const SRC = [
  'wall = 2;',
  '',
  '// ---- PART 1 ----',
  'cube(10);',
  '// ---- PART 1 END ----',
  '',
  '// ---- PART 2 ----',
  'translate([20, 0, 0]) sphere(5);',
  '// ---- PART 2 END ----',
].join('\n')

test('parses numbered blocks and flags a missing number', () => {
  const text = 'Done.\n\n```openscad-part 2\ncylinder(h = 3, d = 8);\n```\n\n```openscad\ncube(1);\n```'
  expect(parsePartBlocks(text)).toEqual({
    blocks: [{ target: 2, body: 'cylinder(h = 3, d = 8);' }],
    complete: true,
    error: null,
  })
  expect(parsePartBlocks('```openscad-part\nx\n```').error).toMatch(/names its target/)
  expect(parsePartBlocks('```openscad-part lid\nmodule lid() {}\n```').blocks).toEqual([{ target: 'lid', body: 'module lid() {}' }])
  expect(parsePartBlocks('```openscad-part 1\nx').complete).toBe(false)
})

test('replaces, appends, deletes and renumbers', () => {
  const replaced = applyParts(SRC, [{ target: 2, body: 'cylinder(h = 3);' }])
  expect(replaced).toEqual({
    source: SRC.replace('translate([20, 0, 0]) sphere(5);', 'cylinder(h = 3);'),
  })

  const appended = applyParts(SRC, [{ target: 3, body: 'cube(1);' }])
  expect('source' in appended && appended.source.endsWith('\n\n// ---- PART 3 ----\ncube(1);\n// ---- PART 3 END ----')).toBe(true)

  const deleted = applyParts(SRC, [{ target: 1, body: '' }])
  expect(deleted).toEqual({
    source: 'wall = 2;\n\n\n// ---- PART 1 ----\ntranslate([20, 0, 0]) sphere(5);\n// ---- PART 1 END ----',
  })

  expect(applyParts(SRC, [{ target: 5, body: 'x' }])).toEqual({
    error: expect.stringMatching(/Part 5 is not in the current source, which has PART 1 to 2/),
  })
  expect(applyParts('cube(1);', [{ target: 2, body: 'x' }])).toEqual({
    error: expect.stringMatching(/no PART sections/),
  })
})

test('checks find an empty section, a stray call and an uncalled module', () => {

  expect(checkParts(SRC)).toEqual([])
  expect(checkParts('cube(1);')).toEqual([])
  // No markers at all still gets the module check: that is the "unused part" the user asked about.
  expect(checkParts('module a() { cube(1); }\ncube(2);')).toEqual(['module a() (outside the parts) is never called.'])
  const bad = [
    'w = 2;',
    'module lid() { cube(w); }',
    'module base() {',
    '  difference() { cube(10); sphere(4); }',
    '}',
    'pts = [',
    '  [0, 0],',
    '];',
    '// ---- PART 1 ----',
    'module hook() { cube(1); }',
    '// ---- PART 1 END ----',
    '// ---- PART 2 ----',
    'translate([20, 0, 0])',
    '  base();',
    '// ---- PART 2 END ----',
    'sphere(3);',
  ].join('\n')
  expect(checkParts(bad)).toEqual([
    'PART 1 has no top-level call, so it puts nothing in the viewport.',
    'A top-level call sits outside the PART sections; every part belongs inside one, or the viewport numbering is off.',
    'module lid() (outside the parts) is never called.',
    'module hook() (PART 1) is never called.',
  ])
})

test('a module is replaced whole by name, braced or braceless, deleted, or appended', () => {
  const src = [
    'w = 2;',
    '// The lid',
    'module lid(h = 1) {',
    '  difference() { cube([w, w, h]); sphere(1); }',
    '}',
    'module peg(d) cylinder(h = 5, d = d);',
    'lid(); peg(2);',
  ].join('\n')
  expect(applyParts(src, [{ target: 'lid', body: 'module lid(h = 2) {\n  cube([w, w, h]);\n}' }])).toEqual({
    source: 'w = 2;\n// The lid\nmodule lid(h = 2) {\n  cube([w, w, h]);\n}\nmodule peg(d) cylinder(h = 5, d = d);\nlid(); peg(2);',
  })
  expect(applyParts(src, [{ target: 'peg', body: 'module peg(d) { sphere(d); }' }])).toEqual({
    source: src.replace('module peg(d) cylinder(h = 5, d = d);', 'module peg(d) { sphere(d); }'),
  })
  expect(applyParts(src, [{ target: 'peg', body: '' }])).toEqual({
    source: src.replace('\nmodule peg(d) cylinder(h = 5, d = d);', ''),
  })
  expect(applyParts(src, [{ target: 'foot', body: 'module foot() { cube(1); }' }])).toEqual({
    source: `${src}\n\nmodule foot() { cube(1); }`,
  })
  expect(applyParts(src, [{ target: 'lid', body: 'cube(1);' }])).toEqual({
    error: expect.stringMatching(/must be its whole definition, starting with `module lid\(`/),
  })
  expect(applyParts(src, [{ target: 'nope', body: '' }])).toEqual({
    error: expect.stringMatching(/no module nope/),
  })
})

/** A model-written file, as it came: real nesting, and a PART 1 that was never closed. */
const TRACTOR = readFileSync(new URL('./fixtures/ferrari-tractor.scad', import.meta.url), 'utf8')
const tractorLines = TRACTOR.split('\n')
const lineOf = (lines: readonly string[], text: string): number => {
  const i = lines.indexOf(text)
  if (i < 0) throw new Error(`no line ${JSON.stringify(text)}`)
  return i
}

test('tractor: the unclosed PART 1 is reported, and every module is called', () => {
  expect(checkParts(TRACTOR)).toEqual([
    'PART 1 is opened but never closed with "// ---- PART 1 END ----".',
  ])
})

test('tractor: a module with nested blocks, an if/else and a defaulted parameter is replaced whole', () => {
  const body = 'module wheel_solid(dia, width, lug_count, is_rear = true) {\n  rotate([90, 0, 0]) cylinder(r = dia / 2, h = width, center = true);\n}'
  const out = applyParts(TRACTOR, [{ target: 'wheel_solid', body }])
  if ('error' in out) throw new Error(out.error)
  const lines = out.source.split('\n')
  // The old definition ran from its head to the `}` two lines above the PART marker.
  const head = lineOf(tractorLines, 'module wheel_solid(dia, width, lug_count, is_rear = true) {')
  const marker = lineOf(tractorLines, '// ---- PART 1 ----')
  expect(tractorLines[marker - 2]).toBe('}')
  expect(lines.slice(0, head)).toEqual(tractorLines.slice(0, head))
  expect(lines.slice(head, head + 3)).toEqual(body.split('\n'))
  expect(lines.slice(head + 3)).toEqual(tractorLines.slice(marker - 1))
  expect(out.source.match(/module wheel_solid/g)).toHaveLength(1)
  expect(out.source.match(/^module /gm)).toHaveLength(6)
})

test('tractor: replacing a middle module leaves its neighbours and their captions exactly in place', () => {
  const out = applyParts(TRACTOR, [{ target: 'single_rear_fender', body: 'module single_rear_fender() { cube(1); }' }])
  if ('error' in out) throw new Error(out.error)
  const lines = out.source.split('\n')
  const at = lineOf(lines, 'module single_rear_fender() { cube(1); }')
  expect(lines[at - 1]).toBe('')
  expect(lines[at - 2]).toBe('}')
  expect(lines[at + 1]).toBe('')
  expect(lines[at + 2]).toBe('module fenders_and_chassis() {')
  // Its callers are untouched.
  expect(out.source).toContain('  single_rear_fender();\n  mirror([0, 1, 0]) single_rear_fender();')
  expect(checkParts(out.source)).toEqual([
    'PART 1 is opened but never closed with "// ---- PART 1 END ----".',
  ])
})

test('tractor: replacing the unclosed PART 1 closes it, and the modules it dropped are flagged', () => {
  const body = 'module ferrari_tractor() { cube(10); }\n\nferrari_tractor();'
  const out = applyParts(TRACTOR, [{ target: 1, body }])
  if ('error' in out) throw new Error(out.error)
  const marker = lineOf(tractorLines, '// ---- PART 1 ----')
  expect(out.source.split('\n').slice(marker)).toEqual([
    '// ---- PART 1 ----',
    ...body.split('\n'),
    '// ---- PART 1 END ----',
  ])
  // The stub assembly calls nothing: exactly the orphans a real one would leave behind.
  expect(checkParts(out.source)).toEqual([
    'module hood_and_engine() (outside the parts) is never called.',
    'module operator_station() (outside the parts) is never called.',
    'module fenders_and_chassis() (outside the parts) is never called.',
    'module wheel_solid() (outside the parts) is never called.',
  ])
  // And PART 2 is now "one past the last", so it appends rather than erroring.
  const more = applyParts(out.source, [{ target: 2, body: 'module trailer() { cube(5); }\ntranslate([80, 0, 0]) trailer();' }])
  expect('source' in more && more.source.endsWith('// ---- PART 2 END ----')).toBe(true)
})

test('tractor: deleting the unclosed PART 1 removes it to the end of the file', () => {
  const out = applyParts(TRACTOR, [{ target: 1, body: '' }])
  if ('error' in out) throw new Error(out.error)
  expect(out.source).not.toContain('PART 1')
  expect(out.source).not.toContain('ferrari_tractor')
  expect(out.source.trimEnd().endsWith('}')).toBe(true)
  expect(checkParts(out.source)).toEqual([
    'module hood_and_engine() (outside the parts) is never called.',
    'module operator_station() (outside the parts) is never called.',
    'module fenders_and_chassis() (outside the parts) is never called.',
    'module wheel_solid() (outside the parts) is never called.',
  ])
})

const WITH_CONSTRUCTION = [
  'w = 20;',
  'module lid() { cube([w, w, 2]); }',
  '',
  '// ---- PART 1 ----',
  'lid();',
  '// ---- PART 1 END ----',
  '',
  '// ---- CONSTRUCTION ----',
  '// The box this lid must fit',
  '%translate([0, 0, -30]) cube([w, w, 30]);',
  '  %cylinder(h = 40, d = 3);',
  '// ---- CONSTRUCTION END ----',
].join('\n')

test('construction: the ghost source keeps parameters and modules, drops the parts, and unmasks the %', () => {
  expect(constructionSource(WITH_CONSTRUCTION)).toBe(
    [
      'w = 20;',
      'module lid() { cube([w, w, 2]); }',
      '',
      '',
      '// ---- CONSTRUCTION ----',
      '// The box this lid must fit',
      'translate([0, 0, -30]) cube([w, w, 30]);',
      '  cylinder(h = 40, d = 3);',
      '// ---- CONSTRUCTION END ----',
    ].join('\n'),
  )
  expect(constructionSource(SRC)).toBeNull()
  expect(constructionSource('// ---- CONSTRUCTION ----\n%cube(1);')).toBeNull()
})

test('construction: the section is replaced, deleted or added by name, and checked for a missing %', () => {
  expect(checkParts(WITH_CONSTRUCTION)).toEqual([])
  const replaced = applyParts(WITH_CONSTRUCTION, [{ target: 'construction', body: '%sphere(50);' }])
  expect(replaced).toEqual({
    source: WITH_CONSTRUCTION.replace(
      '// The box this lid must fit\n%translate([0, 0, -30]) cube([w, w, 30]);\n  %cylinder(h = 40, d = 3);',
      '%sphere(50);',
    ),
  })
  const deleted = applyParts(WITH_CONSTRUCTION, [{ target: 'CONSTRUCTION', body: '' }])
  expect('source' in deleted && deleted.source.trimEnd().endsWith('// ---- PART 1 END ----')).toBe(true)
  const added = applyParts(SRC, [{ target: 'construction', body: '%cube(100);' }])
  expect('source' in added && added.source.endsWith('\n\n// ---- CONSTRUCTION ----\n%cube(100);\n// ---- CONSTRUCTION END ----')).toBe(true)
  expect(applyParts(SRC, [{ target: 'construction', body: '' }])).toEqual({
    error: expect.stringMatching(/no CONSTRUCTION section/),
  })

  const unguarded = applyParts(WITH_CONSTRUCTION, [{ target: 'construction', body: '%cube(1);\ncube(2);\nsphere(3);' }])
  if ('error' in unguarded) throw new Error(unguarded.error)
  expect(checkParts(unguarded.source)).toEqual([
    'CONSTRUCTION lines 10, 11 lack the % modifier, so that geometry would print. Every construction statement starts with %.',
  ])
})
