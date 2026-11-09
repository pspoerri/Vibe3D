import { expect, test, type Page } from '@playwright/test'

// The redesign's own flows, as a first visit sees them: no editor seed here.

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const KEY = 'sk-or-v1-test-key-not-real'

function sseBody(text: string): string {
  const frames = [...text].map((ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`)
  frames.push(
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })}\n\n`,
    'data: [DONE]\n\n',
  )
  return frames.join('')
}

/** A model that answers with an 11 mm cube, thinking off so a turn is one call. */
async function stubModel(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('vibe3d.settings', JSON.stringify({ thinking: 'off' })))
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: '~anthropic/claude-sonnet-latest',
            name: 'Claude Sonnet Latest',
            context_length: 200000,
            architecture: { input_modalities: ['text', 'image'] },
            pricing: { prompt: '0', completion: '0' },
          },
        ],
      },
    }),
  )
  await page.route(CHAT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody('A cube.\n\n```openscad\ncube([11, 11, 11]);\n```\n'),
    }),
  )
}

async function create(page: Page, text: string): Promise<void> {
  await page.getByLabel('Describe the part').fill(text)
  await page.getByRole('button', { name: 'Create model' }).click()
}

test('a prompt on the start window makes the document, and its result card opens History', async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem('vibe3d.key', key), KEY)
  await stubModel(page)
  await page.goto('/')
  await create(page, 'a small cube')

  await expect(page.locator('.msg-user')).toContainText('a small cube')
  await expect(page.locator('.tag', { hasText: '11.0 × 11.0 × 11.0 mm' })).toBeVisible({ timeout: 90_000 })
  const card = page.locator('.card.result')
  await expect(card).toContainText('Model updated · v2')
  await expect(card).toContainText(/11.0 × 11.0 × 11.0 mm · 1 part · \+\d+ −\d+ lines/)
  await expect(page.locator('.history-pill')).toContainText('v2')

  await card.getByRole('button', { name: 'Changes' }).click()
  const history = page.getByRole('dialog', { name: 'History' })
  await expect(history.locator('li.open')).toContainText('v2')
  await expect(history.locator('li.open .diff')).toContainText('cube([11, 11, 11]);')
})

test('without a key the prompt waits in the composer, and goes once a key is saved', async ({ page }) => {
  await stubModel(page)
  await page.goto('/')
  await create(page, 'a small cube')

  const connect = page.getByRole('dialog', { name: 'Connect a model' })
  await expect(connect).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.chat-input textarea')).toHaveValue('a small cube')
  await connect.getByLabel('API key', { exact: true }).fill(KEY)
  await connect.getByRole('button', { name: 'Save' }).click()

  await expect(connect).toBeHidden()
  await expect(page.locator('.msg-user')).toContainText('a small cube')
  await expect(page.locator('.tag', { hasText: '11.0 × 11.0 × 11.0 mm' })).toBeVisible({ timeout: 90_000 })
})

test('a message waiting when sign-in leaves the page goes once the key is minted', async ({ page }) => {
  await stubModel(page)
  await page.route('https://openrouter.ai/auth**', (route) => route.abort())
  await page.route('https://openrouter.ai/api/v1/auth/keys', (route) => route.fulfill({ json: { key: KEY } }))
  await page.goto('/')
  await create(page, 'a small cube')

  // Let the save debounce write the new document the return trip lands on.
  await page.waitForTimeout(1000)
  const leaving = page.waitForRequest(/openrouter\.ai\/auth/)
  await page.getByRole('dialog', { name: 'Connect a model' }).getByRole('button', { name: 'Connect OpenRouter' }).click()
  await leaving
  await page.goto('/?code=test-code')

  await expect(page.locator('.msg-user')).toContainText('a small cube', { timeout: 90_000 })
  await expect(page.locator('.tag', { hasText: '11.0 × 11.0 × 11.0 mm' })).toBeVisible({ timeout: 90_000 })
})

test('a first visit opens documents with the editor closed; opened, it stays open', async ({ page }) => {
  await page.goto('/')
  await page.locator('.start-open').first().click({ timeout: 90_000 })
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({ timeout: 90_000 })
  const pane = page.locator('.pane.edit')
  await expect.poll(async () => (await pane.boundingBox())?.width).toBe(0)

  // A second load must not flip the first visit's choice.
  await page.waitForTimeout(1000)
  await page.reload()
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({ timeout: 90_000 })
  await expect.poll(async () => (await pane.boundingBox())?.width).toBe(0)

  // CodeMirror was mounted hidden: shown, it must still lay out and hold the source.
  await page.getByRole('button', { name: 'Show the editor' }).click()
  await expect(page.locator('#param-plate_x')).toBeVisible()
  await page.getByRole('tab', { name: 'Code' }).click()
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  await expect.poll(async () => (await page.locator('.cm-content').boundingBox())?.width ?? 0).toBeGreaterThan(100)

  await page.reload()
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60', { timeout: 90_000 })
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('Share and Help are in the document menu', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Help' })).toBeVisible()
    await page.locator('.start-open').first().click({ timeout: 90_000 })
    await page.locator('.doc-menu').click()
    await expect(page.getByRole('menuitem', { name: 'Copy share link' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Help' }).click()
    await expect(page.locator('.help-card')).toBeVisible()
  })
})
