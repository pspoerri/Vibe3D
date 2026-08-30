import { expect, test, type Page } from '@playwright/test'

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const KEY = 'sk-or-v1-test-key-not-real'

/** One SSE frame per delta, then the accounting frame, then [DONE]. */
function sseBody(text: string, opts: { finish?: string } = {}): string {
  const frames = [...text].map(
    (ch) => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`,
  )
  // OpenRouter emits keepalive comments; they must never reach JSON.parse.
  frames.unshift(': OPENROUTER PROCESSING\n\n')
  frames.push(
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: opts.finish ?? 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })}\n\n`,
  )
  frames.push('data: [DONE]\n\n')
  return frames.join('')
}

const fenced = (source: string, prose = 'Here is the part.') =>
  `${prose}\n\n\`\`\`openscad\n${source}\n\`\`\`\n`

async function seedKey(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    window.localStorage.setItem('aimodeller.key', key)
  }, KEY)
}

const compiles = async (page: Page): Promise<number> =>
  Number(await page.locator('.app').getAttribute('data-compiles'))

async function waitForStarter(page: Page): Promise<void> {
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
}

async function send(page: Page, text: string): Promise<void> {
  await page.locator('.chat-form textarea').fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

test('a turn streams source into the editor and compiles it exactly once', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await seedKey(page)

  const source = 'cube([12, 8, 4]);'
  await page.route(CHAT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced(source)),
    }),
  )

  await page.goto('/')
  await waitForStarter(page)
  const before = await compiles(page)

  await send(page, 'a small block')

  await expect(page.locator('.tag', { hasText: '12.0 × 8.0 × 4.0 mm' })).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.locator('.cm-content')).toContainText('cube([12, 8, 4]);')

  // Outlast the 600 ms source debounce before counting. A missing
  // compile-identity guard schedules its duplicate compile on that timer, so
  // asserting the moment the dimensions land would pass either way.
  await page.waitForTimeout(1500)
  await expect(page.locator('.tag.busy')).toHaveCount(0)

  // The turn already paid for this compile; the debounce effect must not run it
  // again just because `source` changed.
  expect(await compiles(page)).toBe(before + 1)
  expect(errors).toEqual([])
})

test('the editor is read-only for the turn and editable again after', async ({ page }) => {
  await seedKey(page)
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(CHAT_URL, async (route) => {
    await gate
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced('cube([9, 9, 9]);')),
    })
  })

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a cube')

  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  release()
  await expect(page.locator('.tag', { hasText: '9.0 × 9.0 × 9.0 mm' })).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
})

test('a failed compile is retried with the verbatim stderr and no second copy of the source', async ({
  page,
}) => {
  await seedKey(page)
  const bodies: string[] = []
  let call = 0
  await page.route(CHAT_URL, (route) => {
    bodies.push(JSON.stringify(route.request().postDataJSON()))
    call += 1
    const source = call === 1 ? 'cube([10,10,10);' : 'cube([7, 7, 7]);'
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced(source)),
    })
  })

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a cube')

  await expect(page.locator('.tag', { hasText: '7.0 × 7.0 × 7.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
  expect(call).toBe(2)

  // The retry carries the kernel's own words, with the kernel's own path — the
  // model has to be able to trust the diagnostic against what it just wrote.
  const retry = bodies[1] ?? ''
  expect(retry).toContain('syntax error')
  expect(retry).toContain('/in.scad')
  expect(retry).not.toContain('model.scad')
  // design §5: do not re-attach the source it already has.
  expect(retry.split('cube([10,10,10);').length - 1).toBe(1)

  await expect(page.locator('.chat-stderr')).toContainText('syntax error')
})

/**
 * route.fulfill delivers its body as one chunk, so no test using it ever has a
 * partial on screen that differs from the committed source — which is exactly
 * the state the editor's feedback loop corrupts. This patches fetch instead, so
 * a half-finished reply really does sit in the editor mid-turn.
 */
async function stubProgressiveStream(page: Page): Promise<void> {
  await page.addInitScript((chunk) => {
    const realFetch = window.fetch.bind(window)
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/chat/completions')) return realFetch(input, init)
      const encoder = new TextEncoder()
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunk))
          // Deliberately never closed: the abort is the only way out, which is
          // what makes this a mid-stream stop rather than a completed turn.
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError')),
          )
        },
      })
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      )
    }
  }, `data: ${JSON.stringify({ choices: [{ delta: { content: '```openscad\ncube([3, 3, 3]);' } }] })}\n\n`)
}

test('a stopped turn discards the partial and restores the pre-turn document', async ({ page }) => {
  await seedKey(page)
  await stubProgressiveStream(page)

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'something slow')

  // The partial really is on screen — without this the rest asserts nothing.
  await expect(page.locator('.cm-content')).toContainText('cube([3, 3, 3]);')
  await expect(page.locator('.cm-content')).not.toContainText('plate_x = 60')

  const stop = page.getByRole('button', { name: 'Stop' })
  await expect(stop).toBeVisible()
  await stop.click()
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()

  // THE assertion for the editor feedback loop: if an external write re-entered
  // onChange, the partial above would have been committed into `source` and
  // would survive the stop.
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  await expect(page.locator('.cm-content')).not.toContainText('cube([3, 3, 3]);')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
})

test('undo restores the document a committed turn replaced', async ({ page }) => {
  await seedKey(page)
  await page.route(CHAT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced('cube([15, 5, 5]);')),
    }),
  )

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a bar')
  await expect(page.locator('.tag', { hasText: '15.0 × 5.0 × 5.0 mm' })).toBeVisible({
    timeout: 60_000,
  })

  // This is what makes committing a still-broken source on final failure a
  // recoverable decision rather than a destructive one.
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
})

test('/clear leaves the source alone', async ({ page }) => {
  await seedKey(page)
  await page.goto('/')
  await waitForStarter(page)
  const before = await compiles(page)

  await send(page, '/clear')

  await expect(page.locator('.chat-note', { hasText: 'cleared' }).first()).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  expect(await compiles(page)).toBe(before)
})

test('an auth failure does not mark the geometry stale or block export', async ({ page }) => {
  await seedKey(page)
  await page.route(CHAT_URL, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'User not found.', code: 401 } }),
    }),
  )

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a cube')

  await expect(page.locator('.chat-error')).toContainText('User not found.')
  // A network problem says nothing about the geometry: the HUD stays live and
  // both exports stay enabled.
  await expect(page.locator('.error')).toBeHidden()
  await expect(page.locator('.stats.stale')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Export 3MF' })).toBeEnabled()
})

test('dragging a slider previews without editing the document, then commits on release', async ({
  page,
}) => {
  await page.goto('/')
  await waitForStarter(page)

  const slider = page.locator('#param-plate_x')
  await expect(slider).toBeVisible()
  const box = await slider.boundingBox()
  if (!box) throw new Error('expected the slider to be laid out')

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 8 })

  // Still holding: the preview is a -D compile of the untouched source, so the
  // document must not have changed yet, and $fn is reduced.
  await expect(page.locator('.tag', { hasText: '1,052 tris' })).toBeHidden({ timeout: 60_000 })
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')

  await page.mouse.up()

  // On release the literal is rewritten and its annotation survives.
  await expect(page.locator('.cm-content')).not.toContainText('plate_x = 60;')
  await expect(page.locator('.cm-content')).toContainText('// [20:120]')
})

test('the PKCE start carries exactly the three documented params', async ({ page }) => {
  await page.goto('/')
  await waitForStarter(page)

  let authUrl = ''
  await page.route('https://openrouter.ai/auth**', (route) => {
    authUrl = route.request().url()
    return route.abort()
  })

  await page.getByRole('button', { name: 'Connect OpenRouter' }).click()
  await expect.poll(() => authUrl, { timeout: 15_000 }).toContain('openrouter.ai/auth')

  const params = new URL(authUrl).searchParams
  expect(params.get('code_challenge_method')).toBe('S256')
  expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(params.get('callback_url')).toContain('localhost')
  // There is no state, no client_id, no response_type and no scope in this
  // protocol — sending one would be inventing an API.
  expect(params.get('state')).toBeNull()
  expect(params.get('client_id')).toBeNull()
  expect([...params.keys()].sort()).toEqual([
    'callback_url',
    'code_challenge',
    'code_challenge_method',
  ])
})

test('a callback code with no stored verifier fails without firing an exchange', async ({
  page,
}) => {
  let exchanges = 0
  await page.route('https://openrouter.ai/api/v1/auth/keys', (route) => {
    exchanges += 1
    return route.fulfill({ status: 400, body: 'nope' })
  })

  await page.goto('/?code=not-a-real-code')
  await waitForStarter(page)

  await expect(page.locator('.chat-error')).toBeVisible()
  expect(exchanges).toBe(0)
  // The single-use code is stripped either way, so a reload cannot replay it.
  expect(new URL(page.url()).searchParams.get('code')).toBeNull()
})

test('the built page carries a CSP that the kernel still compiles under', async ({ page }) => {
  const violations: string[] = []
  await page.addInitScript(() => {
    window.addEventListener('securitypolicyviolation', (e) => {
      ;(window as unknown as { __csp: string[] }).__csp ??= []
      ;(window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective)
    })
  })

  await page.goto('/')
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
  expect(csp).toContain("connect-src 'self' https://openrouter.ai")

  // The kernel is a WebAssembly.compile in a worker: if the policy were wrong
  // this never resolves.
  await waitForStarter(page)

  violations.push(
    ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])),
  )
  expect(violations).toEqual([])
})
