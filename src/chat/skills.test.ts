import { expect, test } from 'vitest'
import { FONT_FILES } from '../kernel/fonts'
import { parseOff, type Mesh } from '../kernel/off'
import { extractSource } from './fence'
import { listParts, parseSkill, renderSkill, SKILLS } from './skills'

test('parseSkill reads the last skill block, first word, lowercased; a skill block is never a source', () => {
  expect(parseSkill('Let me check.\n\n```skill\nFonts\n```')).toEqual({ name: 'fonts', complete: true })
  expect(parseSkill('```skill\nviews\n```\n```skill\n parts \n```').name).toBe('parts')
  expect(parseSkill('```skill\n```').name).toBeNull()
  expect(parseSkill('```skill\nfon').complete).toBe(false)
  expect(parseSkill('```openscad\ncube(1);\n```').name).toBeNull()
  expect(extractSource('```skill\nfonts\n```').source).toBeNull()
})

test('every skill renders, and an unknown name renders nothing', () => {
  for (const { name } of SKILLS) expect(renderSkill(name, { source: '', mesh: null, looks: true })).toBeTruthy()
  expect(renderSkill('nope', { source: '', mesh: null, looks: true })).toBeNull()
})

test('the fonts skill lists every vendored face by family and style', () => {
  const body = renderSkill('fonts', { source: '', mesh: null, looks: true })!
  expect(body).toMatch(/"Liberation Sans" \(the default\): Regular, Bold, Italic, Bold Italic/)
  expect(body).toMatch(/"Liberation Serif": Regular, Bold, Italic, Bold Italic/)
  expect(body).toMatch(/"Liberation Mono": Regular, Bold, Italic, Bold Italic/)
  expect(body).toContain('font = "Liberation Serif:style=Bold Italic"')
  // Generated from the files: as many styles named as faces vendored.
  expect(body.match(/Regular/g)).toHaveLength(FONT_FILES.length / 4 + 1)
})

test('the views skill is the view grammar with looks on, and the way to turn them on with looks off', () => {
  const on = renderSkill('views', { source: '', mesh: null, looks: true })!
  expect(on).toMatch(/"closeup"/)
  expect(on).toMatch(/auto/)
  expect(on).toMatch(/section/)
  const off = renderSkill('views', { source: '', mesh: null, looks: false })!
  expect(off).toMatch(/\/think/)
  expect(off).not.toMatch(/closeup/)
})

const SOURCE = `// Two parts
wall = 2;

// ---- PART 1 ----
module hook() { cube(10); }
color("red") hook();
// ---- PART 1 END ----

// ---- PART 2 ----
module lid() {
  cube(5);
}
translate([30, 0, 0]) lid();
// ---- PART 2 END ----
`

/** Two boxes, the first coloured red, the second uncoloured. */
function twoParts(): Mesh {
  const corners = (w: number, at: number) => [
    [at, 0, 0], [at + w, 0, 0], [at + w, w, 0], [at, w, 0],
    [at, 0, w], [at + w, 0, w], [at + w, w, w], [at, w, w],
  ]
  const faces = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const v = [...corners(10, 0), ...corners(5, 30)]
  const f = [...faces, ...faces.map((t) => t.map((i) => i + 8))]
  const mesh = parseOff(`OFF\n${v.length} ${f.length} 0\n${v.map((p) => p.join(' ')).join('\n')}\n${f.map((t) => `3 ${t.join(' ')}`).join('\n')}\n`)
  const colors = new Uint8Array(f.length * 3)
  for (let t = 0; t < f.length; t++) colors.set(t < 12 ? [255, 0, 0] : [249, 215, 44], t * 3)
  return { ...mesh, colors }
}

test('the parts listing names each part by its call, colour and box, and flags a count mismatch', () => {
  const listing = listParts(SOURCE, twoParts())
  expect(listing).toContain('2 PART sections in the source, 2 solids on screen.')
  expect(listing).toContain('1. `color("red") hook();` — red (#ff0000) 100%; 10 × 10 × 10 mm, from [0, 0, 0] to [10, 10, 10]')
  expect(listing).toContain('2. `translate([30, 0, 0]) lid();` — no colour; 5 × 5 × 5 mm, from [30, 0, 0] to [35, 5, 5]')

  expect(listParts(SOURCE, null)).toMatch(/nothing compiled yet/)
  expect(listParts(SOURCE, null)).toContain('1. `color("red") hook();` — no colour; not compiled yet')

  const onePart = SOURCE.replace(/\/\/ ---- PART 2 ----[\s\S]*PART 2 END ----\n/, '')
  const extra = listParts(onePart, twoParts())
  expect(extra).toMatch(/More solids than sections/)
  expect(extra).toContain('2. no PART section — an extra solid')
  expect(listParts('cube(1);', null)).toMatch(/No PART sections/)
})

test('the parts skill teaches the blocks and carries the listing', () => {
  const body = renderSkill('parts', { source: SOURCE, mesh: twoParts(), looks: true })!
  expect(body).toMatch(/openscad-part N/)
  expect(body).toMatch(/openscad-edit/)
  expect(body).toMatch(/color\("red"\)/)
  expect(body).toContain('## The parts of this document')
  expect(body).toContain('1. `color("red") hook();` — red (#ff0000) 100%')
})

test('the diff skill explains every report field and the render', () => {
  const body = renderSkill('diff', { source: '', mesh: null, looks: true })!
  for (const field of ['per_part', 'moved_mm', 'voids', 'genus', 'changed_pieces', 'seen_from', 'added_volume_mm3']) {
    expect(body, field).toContain(field)
  }
  expect(body).toMatch(/green.*magenta/)
  expect(body).toMatch(/round before it/)
})
