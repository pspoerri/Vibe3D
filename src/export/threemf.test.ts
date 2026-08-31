import { strFromU8, strToU8, unzipSync, zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { expect, test } from 'vitest'
import { paint3mf, paintCode, paintModel } from './threemf'

/** The shape the kernel writes: one basematerials group, objects with a default pindex, p1 on coloured triangles. */
const model = (triangles: string): string => `<?xml version="1.0" encoding="utf-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">
 <resources>
  <basematerials id="1">
   <base name="Default" displaycolor="#F9D72CFF"/>
   <base name="Color 1" displaycolor="#8B4513FF"/>
   <base name="Color 2" displaycolor="#FFD700FF"/>
  </basematerials>
  <object id="2" type="model" pid="1" pindex="0">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/>
     <vertex x="10" y="0" z="0"/>
     <vertex x="0" y="10" z="0"/>
     <vertex x="0" y="1" z="0"/>
     <vertex x="1" y="0" z="0"/>
    </vertices>
    <triangles>
${triangles}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build><item objectid="2"/></build>
</model>`

test('the paint code is the slicers\' unsplit-triangle serialisation: 4, 8, 0C, 1C …', () => {
  expect([1, 2, 3, 4, 16].map(paintCode)).toEqual(['4', '8', '0C', '1C', 'DC'])
})

test('colour regions are ranked by area, the largest painted as filament 1, and the Prusa namespace declared', () => {
  // The big triangle (50 mm²) is Color 1; a default one (5 mm²) next; the sliver (0.5 mm²) is Color 2.
  const xml = model(`     <triangle v1="0" v2="1" v3="2" pid="1" p1="1" />
     <triangle v1="0" v2="4" v3="3" pid="1" p1="2" />
     <triangle v1="0" v2="2" v3="4" />`)
  const painted = paintModel(xml)
  expect(painted).toContain('<model xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06" ')
  expect(painted).toContain('<triangle v1="0" v2="1" v3="2" pid="1" p1="1" paint_color="4" slic3rpe:mmu_segmentation="4" />')
  expect(painted).toContain('<triangle v1="0" v2="2" v3="4" paint_color="8" slic3rpe:mmu_segmentation="8" />')
  expect(painted).toContain('<triangle v1="0" v2="4" v3="3" pid="1" p1="2" paint_color="0C" slic3rpe:mmu_segmentation="0C" />')
  expect(painted).toContain('<basematerials id="1">')
})

test('one colour is no painting: the bytes come back untouched, and a painted file re-zips with everything else kept', () => {
  const plain = model('     <triangle v1="0" v2="1" v3="2" />')
  const bytes = zipSync({ '[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8(plain) })
  expect(paint3mf(bytes)).toBe(bytes)

  const two = model(`     <triangle v1="0" v2="1" v3="2" pid="1" p1="1" />
     <triangle v1="0" v2="2" v3="4" />`)
  const painted = unzipSync(paint3mf(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), '3D/3dmodel.model': strToU8(two) })))
  expect(strFromU8(painted['[Content_Types].xml']!)).toBe('<Types/>')
  expect(strFromU8(painted['3D/3dmodel.model']!)).toContain('paint_color="4"')
})
