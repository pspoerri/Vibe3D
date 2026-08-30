import { expect, test } from 'vitest'
import { defineFor, formatLiteral, scanParams, setParam, type Param } from './params'

// Every expectation below was taken from the vendored kernel's own
// `--export-format=param` output, run against these exact snippets. That is
// OpenSCAD's customizer parse, so it is an exact oracle rather than a reading
// of the wiki — and it is what falsifies the folk rules (see COLLECTION).
// Regenerate on the first kernel bump.

/** Kind, value, and whatever control the annotation produced, on one line. */
const brief = (p: Param): string => {
  if (p.kind === 'bool') return `${p.name}=${p.value}`
  if (p.kind === 'enum') {
    const options = p.options.map((o) => `${JSON.stringify(o.value)}:${o.label}`).join(',')
    return `${p.name}=${JSON.stringify(p.value)} (${options})`
  }
  const range = p.range ? ` [${p.range.min}:${p.range.step}:${p.range.max}]` : ''
  return `${p.name}=${p.value}${range}`
}

const scan = (source: string): string[] => scanParams(source).map(brief)

const table = (cases: readonly (readonly [string, string, string[]])[]) => {
  for (const [name, source, expected] of cases) {
    test(name, () => expect(scan(source)).toEqual(expected))
  }
}

table([
  // Collection stops at the LINE of the first brace, not at the first module
  // instantiation — the rule everyone gets wrong.
  ['a brace on line 1 stops collection before it starts', 'a=1; module m(){}\nb=2;\n', []],
  ['a module instantiation does not stop collection', 'a=1;\ncube(1);\nb=2;\n', ['a=1', 'b=2']],
  ['use, function and echo do not stop collection', 'use <x.scad>\nfunction f(x)=x;\necho(1);\na=1;\n', ['a=1']],
  ['for does not stop collection', 'a=1;\nfor (i=[0:3]) sphere(1);\nb=2;\n', ['a=1', 'b=2']],
  // The upstream brace test is not guarded by the in-string flag. We reproduce
  // the bug on purpose: matching the kernel beats matching the wiki.
  ['a brace inside a string still stops collection', 'a=1;\ns="{"; // 5\nb=2;\n', ['a=1']],
  ['a brace inside a comment does not stop collection', 'a=1;\n// {\nb=2;\n', ['a=1', 'b=2']],
  ['the last assignment wins, carrying its own annotation', 'a=1; // [0:10]\na=5; // [0:99]\n', ['a=5 [0:1:99]']],
  ['a param disappears when its last assignment is past the cut-off', 'a=1; // [0:10]\nmodule m(){}\na=5;\n', []],
  ['an assignment inside a module body is not a param', 'a=1;\nmodule m(){ a=5; }\n', ['a=1']],
  ['a named argument is not a param', 'a=1;\ncube(size = 5);\nb=2;\n', ['a=1', 'b=2']],
  ['an assignment inside a string literal is not a param', 's = " a=1; ";\nb=2;\n', ['b=2']],
  ['only literals qualify', 'a = 1+2;\nb = undef;\nc = 3;\n', ['c=3']],
  ['vectors and plain strings are recognised and dropped', 'v = [10,20];\ns = "abc"; // 8\nn = 1;\n', ['n=1']],
  // OpenSCAD exposes $fn, but the drag path appends its own `-D $fn=`, where the
  // last -D for a name wins — a $fn slider would silently do nothing.
  ['$-prefixed names are excluded', '$fn = 32; // [16,32,64,128]\nw = 2;\n', ['w=2']],
])

table([
  ['min:max', 'a = 1; // [0:10]\n', ['a=1 [0:1:10]']],
  ['min:step:max', 'a = 1; // [0:0.5:10]\n', ['a=1 [0:0.5:10]']],
  ['max alone', 'a = 1; // [10]\n', ['a=1 [0:1:10]']],
  ['the value widens the range upwards', 'a = 99; // [0:10]\n', ['a=99 [0:1:99]']],
  ['the value widens the range downwards', 'a = -5; // [0:10]\n', ['a=-5 [-5:1:10]']],
  ['a bare number carries no bounds', 'a = 1; // 0.5\n', ['a=1']],
  ['no annotation', 'a = 1;\n', ['a=1']],
  ['booleans ignore the annotation', 'b = true; // [0:10]\nc = false;\n', ['b=true', 'c=false']],
  ['a numeric option list', 'n = 1; // [1,2,3]\n', ['n=1 (1:1,2:2,3:3)']],
  ['a quoted option list', 's = "a"; // ["a","b"]\n', ['s="a" ("a":a,"b":b)']],
  ['value:Label options', 's = "a"; // [a:Alpha, b:Beta]\n', ['s="a" ("a":Alpha,"b":Beta)']],
  ['an absent current value is prepended as option 0', 'n = 9; // [1,2]\n', ['n=9 (9:9,1:1,2:2)']],
  // The annotation lexer aborts at the second `;` on the line, so neither
  // assignment gets it.
  ['two assignments on one line share no annotation', 'a=1; b=2; // [0:10]\n', ['a=1', 'b=2']],
  ['trailing prose degrades to a plain number', 'a = 1; // [0:10] description\n', ['a=1']],
  ['a trailing semicolon degrades to a plain number', 'a = 1; // [0:10];\n', ['a=1']],
  ['a block comment is not an annotation', 'a = 1; /* [0:10] */\n', ['a=1']],
  ['trailing spaces survive', 'a = 1;   // [0:10]   \n', ['a=1 [0:1:10]']],
  ['a missing space survives', 'a=1;//[0:10]\n', ['a=1 [0:1:10]']],
  // The trailing \r lexes as a WORD and the annotation parse fails. Model text
  // is normalised to LF on ingest (fence.ts) precisely because of this.
  ['CRLF destroys every annotation', 'a = 1; // [0:10]\r\nb = 2;\r\n', ['a=1', 'b=2']],
])

test('a caption comes from the previous line, which must start with // at column 0', () => {
  const params = scanParams('// Wall thickness\nwall = 2;\n  // indented\nb = 1;\nx = 9; // [0:10]\nc = 1;\n')
  expect(params.map((p) => p.caption)).toEqual(['Wall thickness', '', '', ''])
})

test('a blank line between the comment and the assignment kills the caption', () => {
  expect(scanParams('// Wall\n\nwall = 2;\n')[0]?.caption).toBe('')
})

test('a group header applies from the next line and joins multiple brackets', () => {
  const params = scanParams('/* [Lid] */ a=1;\nb=2;\n/* [Lid] [Inner] */\nc=3;\n')
  expect(params.map((p) => p.group)).toEqual(['Parameters', 'Lid', 'Lid-Inner'])
})

test('an indented header still counts and a multi-line one does not', () => {
  expect(scanParams('  /* [Lid] */\na=1;\n')[0]?.group).toBe('Lid')
  expect(scanParams('/* [Box]\n*/\na=1;\n')[0]?.group).toBe('Parameters')
})

test('[Hidden] suppresses until the next header', () => {
  expect(scan('/* [Hidden] */\na=1;\n')).toEqual([])
  expect(scan('/* [ Hidden ] */\na=1;\n')).toEqual([])
  expect(scan('/* [Hidden] */\na=1;\n/* [Lid] */\nb=2;\n')).toEqual(['b=2'])
})

test('offsets cover the value literal alone', () => {
  const source = 'wall = 2.4; // [0.8:0.4:5]\n'
  const param = scanParams(source)[0]!
  expect(source.slice(param.start, param.end)).toBe('2.4')
})

test('setParam rewrites the literal and leaves the annotation comment byte-identical', () => {
  const source = '// Wall\nwall = 2.4; // [0.8:0.4:5]\ncube(wall);\n'
  const param = scanParams(source)[0]!
  expect(setParam(source, param, 3.2)).toBe('// Wall\nwall = 3.2; // [0.8:0.4:5]\ncube(wall);\n')
})

test('setParam quotes a string and writes a bool', () => {
  const source = 's = "a"; // ["a","b"]\nlid = true;\n'
  const [style, lid] = scanParams(source)
  expect(setParam(source, style!, 'b')).toBe('s = "b"; // ["a","b"]\nlid = true;\n')
  expect(setParam(source, lid!, false)).toBe('s = "a"; // ["a","b"]\nlid = false;\n')
})

test('setParam returns the source unchanged when the re-scan does not confirm the write', () => {
  // A stale param — scanned from a document the user has since replaced. Its
  // offsets now point at someone else's literal, and writing there would
  // silently corrupt the document.
  const stale = scanParams('wall = 2.4;\n')[0]!
  const current = 'other = 8.8;\n'
  expect(setParam(current, stale, 3.2)).toBe(current)
})

test('formatLiteral quotes strings and escapes what OpenSCAD would re-lex', () => {
  expect(formatLiteral(2.5)).toBe('2.5')
  expect(formatLiteral(-3)).toBe('-3')
  expect(formatLiteral(true)).toBe('true')
  expect(formatLiteral('flat')).toBe('"flat"')
  expect(formatLiteral('a"; cube(1); s="')).toBe('"a\\"; cube(1); s=\\""')
})

test('defineFor builds one -D entry and rejects a name that is not a name', () => {
  expect(defineFor('wall', 2.5)).toBe('wall=2.5')
  expect(defineFor('$fn', 16)).toBe('$fn=16')
  expect(defineFor('style', 'flat')).toBe('style="flat"')
  // Verified against the kernel: `-D 'wall=2; translate([50,0,0]) cube(1)'`
  // injects an extra solid.
  expect(() => defineFor('a; cube(1)', 1)).toThrow(/name/)
  expect(() => defineFor('', 1)).toThrow(/name/)
})

test('a numeric enum survives a round trip through the select', () => {
  const source = 'n = 1; // [1,2,3]\ncube(n);\n'
  const param = scanParams(source).find((p) => p.name === 'n')
  if (!param) throw new Error('expected n to be scanned')

  expect(setParam(source, param, 2)).toBe('n = 2; // [1,2,3]\ncube(n);\n')
  // A <select> hands back a string. Writing that produced `n = "2";`, which
  // scanned back as the enum '2' and compared equal to what was asked for —
  // the guard passed while the document had quietly stopped compiling.
  expect(setParam(source, param, '2')).toBe(source)
})

test('every name the scanner emits is one defineFor accepts', () => {
  // The two used to disagree: the scanner took `$` anywhere, defineFor only
  // leading, so one slider touch threw from a pointer handler.
  const source = 'a$b = 1;\n_c = 2;\nd2 = 3;\ncube(1);\n'
  for (const param of scanParams(source)) {
    expect(() => defineFor(param.name, 1)).not.toThrow()
  }
})

test('a long digit run does not blow up the scanner', () => {
  // scanParams runs on every keystroke and on model-written source. The old
  // ambiguous \d+\.?\d* backtracked O(N^2): 40k digits took over two seconds.
  const started = performance.now()
  scanParams(`a = ${'1'.repeat(40_000)}\n`)
  expect(performance.now() - started).toBeLessThan(250)
})
