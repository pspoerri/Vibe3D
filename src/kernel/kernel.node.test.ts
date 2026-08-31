/**
 * The real kernel, under Node: what the probe of 2026-08-31 verified, kept as
 * a test so the next snapshot pin cannot silently lose it. Each compile is a
 * fresh instance (callMain runs to exit), ~0.5 s apiece.
 */
import { readFileSync } from 'node:fs'
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { expect, test } from 'vitest'
import { parseOff } from './off'
import { IN_PATH, kernelArgs, outPath, type ExportFormat } from './protocol'
import { meshStats } from './stats'
import OpenSCAD from './vendor/openscad.js'

const wasmBinary = readFileSync(new URL('./vendor/openscad.wasm', import.meta.url))

async function compile(
  source: string,
  format: ExportFormat,
  files: Record<string, Uint8Array> = {},
): Promise<{ code: number; data: Uint8Array; stderr: string }> {
  let stderr = ''
  const kernel = await OpenSCAD({
    noInitialRun: true,
    // The web glue has no file reader for Node, so the bytes are handed over.
    wasmBinary,
    print: () => {},
    printErr: (text: string) => {
      stderr += text + '\n'
    },
  })
  kernel.FS.writeFile(IN_PATH, source)
  for (const [path, bytes] of Object.entries(files)) kernel.FS.writeFile(path, bytes)
  const code = kernel.callMain(kernelArgs(format))
  const data = code === 0 ? new Uint8Array(kernel.FS.readFile(outPath(format))) : new Uint8Array()
  return { code, data, stderr }
}

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
