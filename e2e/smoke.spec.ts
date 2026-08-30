import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test('compiles the starter model and reports its size', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/')
  // 60 x 40 x 3 mm starter plate.
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.locator('.tag', { hasText: 'cm³' })).toBeVisible()
  expect(errors).toEqual([])
})

test('surfaces a compile error and recovers from it', async ({ page }) => {
  await page.goto('/')
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
  await expect(page.locator('.tag', { hasText: 'mm' })).toBeVisible({ timeout: 90_000 })

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 3MF' }).click()
  const file = await (await download).path()
  expect((await download).suggestedFilename()).toBe('model.3mf')

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
