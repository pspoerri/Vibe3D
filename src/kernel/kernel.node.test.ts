/**
 * The real kernel, under Node: what the probe of 2026-08-31 verified, kept as
 * a test so the next snapshot pin cannot silently lose it. Each compile is a
 * fresh instance (callMain runs to exit), ~0.5 s apiece.
 */
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { expect, test } from 'vitest'
import { compileNode as compile } from '../../eval/kernel'
import { parseOff } from './off'
import { meshStats } from './stats'

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)
const THREE_PARTS = 'cube(10); translate([20,0,0]) sphere(5); translate([0,20,0]) cylinder(h=5, r=3);'

test('exports OBJ', async () => {
  const { code, data } = await compile('cube(10);', 'obj')
  expect(code).toBe(0)
  const obj = text(data)
  expect(obj.startsWith('# OpenSCAD obj exporter')).toBe(true)
  expect(obj.match(/^v /gm)).toHaveLength(8)
  expect(obj.match(/^f /gm)).toHaveLength(12)
})

test('three top-level statements become three objects in the 3MF, and three parts on screen', async () => {
  const mf = await compile(THREE_PARTS, '3mf')
  expect(mf.code).toBe(0)
  const model = strFromU8(unzipSync(mf.data)['3D/3dmodel.model']!)
  expect(model.match(/<object /g)).toHaveLength(3)
  expect(model.match(/<item /g)).toHaveLength(3)

  const off = await compile(THREE_PARTS, 'off')
  expect(off.code).toBe(0)
  expect(meshStats(parseOff(text(off.data))).parts).toBe(3)
})

test('a single-object source is unaffected by the lazy union', async () => {
  const source = 'difference() { cube(10); cylinder(h = 30, r = 2, center = true); }'
  const stats = meshStats(parseOff(text((await compile(source, 'off')).data)))
  expect(stats.parts).toBe(1)
  expect(stats.watertight).toBe(true)
})

test('an empty top level still exits 1 with the message inspect.ts reads', async () => {
  const { code, stderr } = await compile('difference() { cube(1); cube(2, center = true); }', 'off')
  expect(code).toBe(1)
  expect(stderr).toMatch(/top level object is empty/i)
})

test('a mesh file in the FS imports as a solid: STL, OBJ, 3MF and OFF', async () => {
  const box = 'cube([10, 20, 30]);'
  const exported = {
    'a.stl': (await compile(box, 'binstl')).data,
    'a.obj': (await compile(box, 'obj')).data,
    'a.3mf': (await compile(box, '3mf')).data,
    'a.off': (await compile(box, 'off')).data,
  }
  for (const [name, bytes] of Object.entries(exported)) {
    const { code, data } = await compile(`import("${name}");`, 'off', { [`/${name}`]: bytes })
    expect(code, name).toBe(0)
    const stats = meshStats(parseOff(text(data)))
    expect(stats.volume, name).toBeCloseTo(6000, 3)
    expect(stats.size, name).toEqual([10, 20, 30])
  }
})

test('an unreadable mesh file is the kernel error, never a silent empty part', async () => {
  const { code, stderr } = await compile('import("bad.stl");', 'off', {
    '/bad.stl': new TextEncoder().encode('garbage'),
  })
  expect(code).toBe(1)
  expect(stderr).toContain('STL format not recognized')
})

test('the % background modifier is dropped from every export: construction geometry never prints', async () => {
  const off = await compile('%cube(10); cube(5);', 'off')
  expect(off.code).toBe(0)
  const stats = meshStats(parseOff(text(off.data)))
  expect(stats.parts).toBe(1)
  expect(stats.volume).toBe(125)

  const mf = await compile('%cube(10); cube(5); module guide() { %sphere(20); } guide();', '3mf')
  expect(mf.code).toBe(0)
  expect(strFromU8(unzipSync(mf.data)['3D/3dmodel.model']!).match(/<object /g)).toHaveLength(1)

  // Only construction: the same empty-top-level exit inspect.ts already reads.
  const none = await compile('%cube(10);', 'off')
  expect(none.code).toBe(1)
  expect(none.stderr).toMatch(/top level object is empty/i)
})

const TEXT = (font: string) => `linear_extrude(2) text("A320neo", size = 10, font = "${font}");`

test('text() renders with the bundled Liberation fonts, in every face the model may name', async () => {
  for (const font of ['Liberation Sans', 'Liberation Sans:style=Bold', 'Liberation Serif:style=Italic', 'Liberation Mono']) {
    const { code, data, stderr } = await compile(TEXT(font), 'off')
    expect(code, font).toBe(0)
    expect(stderr, font).not.toMatch(/[Ff]ontconfig|Can't get font/)
    const stats = meshStats(parseOff(text(data)))
    expect(stats.volume!, font).toBeGreaterThan(100)
    expect(stats.size[0], font).toBeGreaterThan(30)
  }
})

test('a font the bundle lacks still renders, in the nearest bundled face', async () => {
  const { code, data } = await compile(TEXT('Comic Sans MS'), 'off')
  expect(code).toBe(0)
  expect(meshStats(parseOff(text(data))).volume!).toBeGreaterThan(100)
})

test('without fonts text() is the silent nothing this bundle exists to fix', async () => {
  const { code, stderr } = await compile(TEXT('Liberation Sans'), 'off', {}, null)
  expect(code).toBe(1)
  expect(stderr).toMatch(/Can't get font/)
})

test('a source without text() pays for no font scan and prints no fontconfig noise', async () => {
  const { stderr } = await compile('cube(10);', 'off')
  expect(stderr).not.toMatch(/[Ff]ontconfig/)
})

test('colours reach the OFF per face and the 3MF as materials, through union and difference alike', async () => {
  const source = `union() { color("saddlebrown") cube([40, 20, 3]); color("gold") translate([5, 5, 3]) cube([30, 10, 2]); }
difference() { color("red") translate([50, 0, 0]) cube(10); color("blue") translate([52, 2, 5]) cube(6); }`
  const off = parseOff(text((await compile(source, 'off')).data))
  const seen = new Set<string>()
  for (let t = 0; t < off.triangleCount; t++) seen.add([off.colors![t * 3], off.colors![t * 3 + 1], off.colors![t * 3 + 2]].join(','))
  // The pocket's faces are the cutter's blue: an engraving is coloured by colouring the cutter.
  expect(seen).toEqual(new Set(['139,69,19', '255,215,0', '255,0,0', '0,0,255']))

  const model = strFromU8(unzipSync((await compile(source, '3mf')).data)['3D/3dmodel.model']!)
  expect(model).toMatch(/<basematerials id="1">/)
  for (const colour of ['#8B4513FF', '#FFD700FF', '#FF0000FF', '#0000FFFF']) expect(model).toContain(`displaycolor="${colour}"`)
  expect(model.match(/<triangle [^>]*p1="\d+"/g)?.length).toBeGreaterThan(0)
})

test('the Biergarten example is one solid on Z=0, its lettering, frame and mugs coloured apart from the plate', async () => {
  const source = readFileSync(new URL('../examples/biergarten-sign.scad', import.meta.url), 'utf8')
  const { code, data, stderr } = await compile(source, 'off')
  expect(code).toBe(0)
  expect(stderr).not.toMatch(/WARNING|Can't get font/)
  const mesh = parseOff(text(data))
  const stats = meshStats(mesh)
  expect(stats.parts).toBe(1)
  expect(stats.watertight).toBe(true)
  expect(stats.voids).toEqual([])
  // Two hanging holes, and no other loop.
  expect(stats.genus).toBe(2)
  expect(stats.min[2]).toBe(0)
  expect(stats.size.map((v) => Math.round(v * 10) / 10)).toEqual([198.1, 110.7, 12.9])
  const colours = new Set<string>()
  for (let t = 0; t < mesh.triangleCount; t++) colours.add([mesh.colors![t * 3], mesh.colors![t * 3 + 1], mesh.colors![t * 3 + 2]].join(','))
  // Green plate (#1B432C), gold trim and steins (#D4AF37), cream lettering (#FFF8E7), white foam.
  expect(colours).toEqual(new Set(['27,67,44', '212,175,55', '255,248,231', '255,255,255']))
})

test('BOSL2 is on the include path when the source names it, and a part built with it compiles', async () => {
  const source = 'include <BOSL2/std.scad>\ncuboid([20, 20, 10], rounding = 3, anchor = BOTTOM);'
  const { code, data, stderr, ms } = await compile(source, 'off')
  expect(code, stderr).toBe(0)
  const stats = meshStats(parseOff(text(data)))
  expect(stats.parts).toBe(1)
  expect(stats.watertight).toBe(true)
  expect(stats.min[2]).toBeCloseTo(0, 3)
  // The include is a 4 MB parse on top of the compile; keep an eye on it.
  expect(ms).toBeLessThan(15_000)
  // Without the include the same call is an unknown module, and the kernel says so.
  const bare = await compile('cuboid([20, 20, 10], rounding = 3);', 'off')
  expect(bare.code).toBe(1)
})
