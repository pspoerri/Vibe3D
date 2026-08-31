import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js'

test('compiles the starter model and reports its size', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  // 60 x 40 x 3 mm starter plate.
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.locator('.tag', { hasText: 'cm³' })).toBeVisible()
  expect(errors).toEqual([])
})

test('opens the potted plant example and compiles it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  await page.getByRole('button', { name: 'A potted plant' }).click({ timeout: 90_000 })
  await expect(page.locator('.menubar-doc')).toHaveText('A potted plant')
  // Hulls of spheres at $fn = 48: the slowest example by far, so the long wait.
  await expect(page.locator('.tag', { hasText: 'mm' })).toBeVisible({ timeout: 180_000 })
  await expect(page.locator('.error')).toBeHidden()
  expect(errors).toEqual([])
})

test('the brand in the menu bar goes back to the start window', async ({ page }) => {
  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  await expect(page.locator('.start-card')).toBeHidden()
  await page.getByRole('button', { name: 'Vibe3D' }).click()
  await expect(page.locator('.start-card')).toBeVisible()
})

test('surfaces a compile error and recovers from it', async ({ page }) => {
  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  await expect(page.locator('.tag', { hasText: 'mm' })).toBeVisible({ timeout: 90_000 })

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('cube([10,10,10);')

  const error = page.locator('.error')
  await expect(error).toBeVisible({ timeout: 60_000 })
  await expect(error).toContainText('syntax error')
  // The kernel prints this on every run; it must never reach the user.
  await expect(error).not.toContainText('Could not initialize localization')

  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('cube([10,10,10]);')
  await expect(error).toBeHidden({ timeout: 60_000 })
})

test('exports a 3MF', async ({ page }) => {
  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  await expect(page.locator('.tag', { hasText: 'mm' })).toBeVisible({ timeout: 90_000 })

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 3MF' }).click()
  const file = await (await download).path()
  // Named after the document, which the starter takes from its title comment.
  expect((await download).suggestedFilename()).toBe('A mounting plate.3mf')

  const buf = await readFile(file)
  expect(buf.subarray(0, 2).toString()).toBe('PK') // it is a zip
  const text = buf.toString('latin1')
  expect(text).toContain('3D/3dmodel.model') // the StartPart target
  expect(text).toContain('_rels/.rels') // what Bambu Studio hard-fails without
})

// three's setSize(w, h, false) leaves canvas.style unset, so the canvas lays
// out at its dpr-scaled backing size. OrbitControls converts drag pixels to
// radians with element.clientHeight, so an oversized canvas silently halves
// the rotation per pixel on a retina display — invisible at the default dpr 1.
test.describe('on a retina display', () => {
  test.use({ deviceScaleFactor: 2 })

  test('the canvases lay out at their CSS size, not their backing size', async ({ page }) => {
    await page.goto('/')
    await page.locator('.start-open').first().click({ timeout: 90_000 })
    await expect(page.locator('.tag', { hasText: 'mm' }).first()).toBeVisible({ timeout: 90_000 })

    const box = async (selector: string) => {
      const rect = await page.locator(selector).boundingBox()
      return rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null
    }
    expect(await box('.viewport-canvas canvas')).toEqual(await box('.viewport-canvas'))
    expect(await box('.view-cube canvas')).toEqual({ w: 84, h: 84 })
    // An oversized canvas also pushes the document wider than the viewport.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1280)
  })
})

async function openStarter(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
}

async function typeSource(page: Page, source: string): Promise<void> {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(source)
}

test('exports an OBJ', async ({ page }) => {
  await openStarter(page)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export OBJ' }).click()
  expect((await download).suggestedFilename()).toBe('A mounting plate.obj')
  const text = await readFile(await (await download).path(), 'utf8')
  expect(text.startsWith('# OpenSCAD obj exporter')).toBe(true)
  expect(text).toMatch(/^v /m)
  expect(text).toMatch(/^f /m)
})

test('two top-level statements are two parts on screen and two objects in the 3MF', async ({ page }) => {
  await openStarter(page)
  await typeSource(page, 'cube(10); translate([20, 0, 0]) cube(5);')
  await expect(page.locator('.tag', { hasText: '2 parts' })).toBeVisible({ timeout: 60_000 })

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 3MF' }).click()
  const zip = await readFile(await (await download).path())
  const model = strFromU8(unzipSync(new Uint8Array(zip))['3D/3dmodel.model']!)
  expect(model.match(/<object /g)).toHaveLength(2)
})

/** A w × d × h box as ASCII STL — the kernel recomputes the normals. */
function asciiStl(w: number, d: number, h: number): string {
  const v = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
  ]
  const f = [
    [0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ]
  const facets = f.map(
    (t) =>
      `facet normal 0 0 0\nouter loop\n${t.map((i) => `vertex ${v[i]!.join(' ')}`).join('\n')}\nendloop\nendfacet`,
  )
  return `solid box\n${facets.join('\n')}\nendsolid box\n`
}

test('an imported mesh is measured, placed by import(), and survives a reload', async ({ page }) => {
  await openStarter(page)
  await page.getByLabel('Import mesh').setInputFiles({
    name: 'box.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from(asciiStl(10, 20, 30)),
  })
  const chip = page.locator('.component', { hasText: 'box.stl' })
  await expect(chip).toContainText('10.0 × 20.0 × 30.0', { timeout: 60_000 })

  await typeSource(page, 'translate([0, 0, 5]) import("box.stl");')
  await expect(page.locator('.tag', { hasText: '10.0 × 20.0 × 30.0 mm' })).toBeVisible({
    timeout: 60_000,
  })

  // The bytes live in IndexedDB with the document, so the source still compiles after a reload.
  await page.reload()
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  await expect(page.locator('.component', { hasText: 'box.stl' })).toBeVisible()
  await expect(page.locator('.tag', { hasText: '10.0 × 20.0 × 30.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.locator('.error')).toBeHidden()

  await page.getByRole('button', { name: 'Remove box.stl' }).click()
  await expect(page.locator('.component')).toHaveCount(0)
})

test('an unreadable mesh is refused with the kernel\'s own reason', async ({ page }) => {
  await openStarter(page)
  const dialogs: string[] = []
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  await page.getByLabel('Import mesh').setInputFiles({
    name: 'bad.stl',
    mimeType: 'model/stl',
    buffer: Buffer.from('garbage'),
  })
  await expect.poll(() => dialogs.length, { timeout: 60_000 }).toBe(1)
  expect(dialogs[0]).toContain('STL format not recognized')
  await expect(page.locator('.component')).toHaveCount(0)
})

test('clicking the part selects it for the chat, and empty space clears it', async ({ page }) => {
  await openStarter(page)
  const canvas = page.locator('.viewport-canvas canvas')
  await canvas.click()
  const selection = page.locator('.chat-selection')
  await expect(selection).toContainText('part 1 of 1')
  await expect(selection).toContainText('60 × 40 × 3 mm')
  await canvas.click({ position: { x: 4, y: 4 } })
  await expect(selection).toBeHidden()
})

test('Help lists the commands on hover and opens the manual on click', async ({ page }) => {
  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  const help = page.getByRole('button', { name: 'Help' })
  const pop = page.locator('.help-pop')
  await expect(pop).toBeHidden()
  await help.hover()
  await expect(pop).toBeVisible()
  await expect(pop).toContainText('/export')
  await expect(pop).toContainText('/undo')

  await help.click()
  const manual = page.locator('.help-card')
  await expect(manual).toBeVisible()
  await expect(manual).toContainText('Import mesh')
  await expect(manual.locator('table')).toContainText('/compact')
  await page.keyboard.press('Escape')
  await expect(manual).toBeHidden()
})

test('deleting the open document goes back to the start window', async ({ page }) => {
  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  await expect(page.locator('.start-card')).toBeHidden()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.locator('.start-card')).toBeVisible()
  // The document row is gone; the example of the same name is not a document.
  await expect(page.locator('.start-open', { hasText: 'A mounting plate' })).toHaveCount(0)
  await expect(page.locator('.start-open')).toHaveCount(1)
})
