import { readFile } from 'node:fs/promises'
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
    window.localStorage.setItem('vibe3d.key', key)
  }, KEY)
  // The pane loads the catalogue as soon as a key exists, because that is what
  // prices a turn. No test may reach the real endpoint for it.
  await page.route('**/api/v1/models', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 'google/gemini-3.7-flash',
            name: 'Gemini 3.7 Flash',
            context_length: 1048576,
            architecture: { input_modalities: ['text', 'image'] },
            pricing: { prompt: '0.00000075', completion: '0.00000375' },
          },
        ],
      }),
    }),
  )
}

const compiles = async (page: Page): Promise<number> =>
  Number(await page.locator('.app').getAttribute('data-compiles'))

/** The launcher is the entry point, so every test opens a document first. */
async function waitForStarter(page: Page): Promise<void> {
  await page.locator('.start-open').first().click({ timeout: 90_000 })
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
async function stubProgressiveStream(page: Page, frames?: string): Promise<void> {
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
  }, frames ?? `data: ${JSON.stringify({ choices: [{ delta: { content: '```openscad\ncube([3, 3, 3]);' } }] })}\n\n`)
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

test('/undo steps the document back to the version a turn replaced', async ({ page }) => {
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
  const picker = page.getByRole('combobox', { name: 'Version' })
  await expect(picker).toHaveValue('2')
  await expect(picker.locator('option[value="2"]')).toHaveText(/a bar/)

  await send(page, '/undo')
  await expect(page.locator('.chat-note', { hasText: 'Restored v1' })).toBeVisible()
  await expect(picker).toHaveValue('1')
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({
    timeout: 60_000,
  })
  // Nothing was thrown away: the turn's version is still there to go forward to.
  await expect(picker.locator('option')).toHaveCount(2)

  await send(page, '/undo')
  await expect(page.locator('.chat-note.bad', { hasText: 'Nothing to undo' })).toBeVisible()
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

test('reasoning is shown while the model is still thinking', async ({ page }) => {
  await seedKey(page)
  // A reasoning model emits no content for seconds. Before this the pane sat
  // on a static "thinking…" for the whole stream.
  await stubProgressiveStream(
    page,
    `data: ${JSON.stringify({
      choices: [
        { delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Sizing the plate' }] } },
      ],
    })}\n\n`,
  )

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a plate')

  await expect(page.locator('.chat-reasoning')).toContainText('Sizing the plate')
  // Still mid-turn: the document is untouched and Stop is live.
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  await page.getByRole('button', { name: 'Stop' }).click()
  await expect(page.locator('.chat-reasoning')).toHaveCount(0)
})

test('the reply text appears in the transcript before the turn settles', async ({ page }) => {
  await seedKey(page)
  await stubProgressiveStream(
    page,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Making a plate for you.' } }] })}\n\n`,
  )

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'a plate')

  await expect(page.locator('.msg-assistant')).toContainText('Making a plate for you.')
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible()
})

test('the session meter reports tokens and what they cost', async ({ page }) => {
  await seedKey(page)
  await page.route(CHAT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced('cube([5, 5, 5]);')),
    }),
  )

  await page.goto('/')
  await waitForStarter(page)
  await expect(page.locator('.chat-meter')).toContainText('0 tok')

  await send(page, 'a cube')
  await expect(page.locator('.tag', { hasText: '5.0 × 5.0 × 5.0 mm' })).toBeVisible({
    timeout: 60_000,
  })

  // sseBody bills 10 prompt + 20 completion at the stubbed catalogue's prices:
  // 10 * 7.5e-7 + 20 * 3.75e-6 = 0.0000825, which rounds to $0.0001.
  await expect(page.locator('.chat-meter')).toContainText('30 tok')
  await expect(page.locator('.chat-meter')).toContainText('$0.0001')
})

test('the composer grows with a long prompt instead of clipping it', async ({ page }) => {
  await page.goto('/')
  await waitForStarter(page)

  const field = page.locator('.chat-form textarea')
  const oneLine = (await field.boundingBox())?.height ?? 0
  await field.fill(Array.from({ length: 12 }, (_, i) => `line ${i} of a long prompt`).join('\n'))
  const many = (await field.boundingBox())?.height ?? 0

  expect(many).toBeGreaterThan(oneLine * 3)
  // And it shrinks back, which it cannot do if scrollHeight is read without
  // resetting the height first.
  await field.fill('short')
  expect((await field.boundingBox())?.height ?? 0).toBeLessThan(many)
})

/** A 1x1 transparent PNG. Small enough to inline, real enough to decode. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

test('a picked image reaches the model as a data URL, after the text, exactly once', async ({
  page,
}) => {
  await seedKey(page)
  let posted = ''
  await page.route(CHAT_URL, (route) => {
    posted = JSON.stringify(route.request().postDataJSON())
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced('cube([11, 11, 11]);')),
    })
  })

  await page.goto('/')
  await waitForStarter(page)

  await page.locator('.chat-attach input').setInputFiles({
    name: 'ref.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_B64, 'base64'),
  })
  // The tray is the only signal that normalisation finished before we send.
  await expect(page.locator('.chat-thumb')).toHaveCount(1)

  await send(page, 'like this bracket')
  await expect(page.locator('.tag', { hasText: '11.0 × 11.0 × 11.0 mm' })).toBeVisible({
    timeout: 60_000,
  })

  const body = JSON.parse(posted) as {
    messages: { role: string; content: unknown }[]
  }
  const parts = body.messages.find((m) => Array.isArray(m.content))?.content as
    | { type: string; text?: string; image_url?: { url: string } }[]
    | undefined
  if (!parts) throw new Error('expected one message to carry content parts')

  // Text first: OpenRouter recommends it, and reversing it degrades the answer
  // without erroring, so nothing else would catch it.
  expect(parts[0]).toEqual({ type: 'text', text: 'like this bracket' })
  expect(parts[1]?.type).toBe('image_url')
  expect(parts[1]?.image_url?.url.startsWith('data:image/jpeg')).toBe(true)
  // Normalised, not passed through: the input was a PNG.
  expect(posted).not.toContain('data:image/png')
  // Exactly once — a second copy is a doubled bill on every turn.
  expect(posted.split('data:image/jpeg').length - 1).toBe(1)

  // The tray is emptied by the send, not left staged for a double-send.
  await expect(page.locator('.chat-thumb')).toHaveCount(0)
  // And the transcript shows what was sent.
  await expect(page.locator('.msg-user img')).toHaveCount(1)
})

test('a pasted image attaches, and pasting text still types', async ({ page }) => {
  await seedKey(page)
  await page.goto('/')
  await waitForStarter(page)

  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'ref.png', { type: 'image/png' }))
    const field = document.querySelector('.chat-form textarea')
    // React 19 delegates at the container root, so this must bubble.
    field?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  }, PNG_B64)

  await expect(page.locator('.chat-thumb')).toHaveCount(1)

  // preventDefault must be conditional on an image actually being present, or
  // ordinary text paste stops working. This half goes through the real
  // clipboard: a synthetic ClipboardEvent is neither trusted nor cancelable, so
  // it can neither be prevented nor perform the default insert, and would read
  // as broken text paste however the handler is written.
  // grantPermissions for the clipboard is Chromium-only; the suite declares no
  // other project, so this is the browser it runs on.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('a 40 mm bracket'))
  await page.locator('.chat-form textarea').focus()
  await page.keyboard.press('ControlOrMeta+V')
  await expect(page.locator('.chat-form textarea')).toHaveValue('a 40 mm bracket')
})

test('the model dropdown flags which models can read an image', async ({ page }) => {
  await seedKey(page)
  await page.goto('/')
  await waitForStarter(page)

  await page.locator('.chat-meter button').first().click()
  await expect(page.locator('.chat-settings option').first()).toHaveText(/· vision/)
})

test('an image with no words is a message on its own', async ({ page }) => {
  await seedKey(page)
  let posted = ''
  await page.route(CHAT_URL, (route) => {
    posted = JSON.stringify(route.request().postDataJSON())
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced('cube([13, 13, 13]);')),
    })
  })

  await page.goto('/')
  await waitForStarter(page)
  await page.locator('.chat-attach input').setInputFiles({
    name: 'ref.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_B64, 'base64'),
  })
  await expect(page.locator('.chat-thumb')).toHaveCount(1)

  // Two guards that fail silently, and only this test holds them: the tray
  // alone must enable the button, or the image-only path is unreachable by
  // mouse; and send() must admit a wordless message, or the click is a no-op.
  const button = page.getByRole('button', { name: 'Send' })
  await expect(page.locator('.chat-form textarea')).toHaveValue('')
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page.locator('.msg-user img')).toHaveCount(1)

  await expect(page.locator('.tag', { hasText: '13.0 × 13.0 × 13.0 mm' })).toBeVisible({
    timeout: 60_000,
  })
  const body = JSON.parse(posted) as { messages: { content: unknown }[] }
  const parts = body.messages.find((m) => Array.isArray(m.content))?.content as
    | { type: string }[]
    | undefined
  // The image travels alone: no empty text part padding it out.
  expect(parts?.map((part) => part.type)).toEqual(['image_url'])
})

test('the tray empties when the turn starts, not when it ends', async ({ page }) => {
  await seedKey(page)
  // Never-closing stream, so the assertions below all land mid-turn.
  await stubProgressiveStream(page)

  await page.goto('/')
  await waitForStarter(page)
  await page.locator('.chat-attach input').setInputFiles({
    name: 'ref.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_B64, 'base64'),
  })
  await expect(page.locator('.chat-thumb')).toHaveCount(1)

  await send(page, 'like this bracket')

  // Still streaming — a tray cleared in the finally would sit populated for the
  // whole turn, inviting a second send that re-bills the same image.
  await expect(page.locator('.chat-send.stop')).toBeVisible()
  await expect(page.locator('.chat-thumb')).toHaveCount(0)
})

test('a command clears the tray instead of carrying it into the next message', async ({ page }) => {
  await seedKey(page)
  await page.goto('/')
  await waitForStarter(page)

  await page.locator('.chat-attach input').setInputFiles({
    name: 'ref.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_B64, 'base64'),
  })
  await expect(page.locator('.chat-thumb')).toHaveCount(1)

  await send(page, '/clear')

  await expect(page.locator('.chat-note', { hasText: 'Cleared' }).first()).toBeVisible()
  // The command branch has its own clear: without it the image rides the next
  // real message, which is a turn the user never attached it to.
  await expect(page.locator('.chat-thumb')).toHaveCount(0)
})

test('one unreadable image does not take the rest of the batch with it', async ({ page }) => {
  await seedKey(page)
  await page.goto('/')
  await waitForStarter(page)

  await page.locator('.chat-attach input').setInputFiles([
    { name: 'ref.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64') },
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image at all') },
  ])

  // Promise.all would reject on the corrupt one and drop the good one too.
  await expect(page.locator('.chat-thumb')).toHaveCount(1)
  await expect(page.locator('.chat-note.bad')).toContainText('could not be read')
})

test('the attach control is reachable from the keyboard and has a name', async ({ page }) => {
  await page.goto('/')
  await waitForStarter(page)

  // A `display: none` input is not focusable, which makes the picker mouse-only
  // — and the label's glyph is aria-hidden, so the name has to be on the input.
  await page.locator('.chat-form textarea').focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('.chat-attach input')).toBeFocused()
  await expect(page.locator('.chat-attach input')).toHaveAttribute('aria-label', 'Attach images')
})

test('display units switch without touching the model or the source', async ({ page }) => {
  await page.goto('/')
  await waitForStarter(page)

  await page.getByRole('button', { name: /metric/i }).click()
  await expect(page.locator('.tag', { hasText: '2.362 × 1.575 × 0.118 in' })).toBeVisible()
  // The source stays metric: it is what the kernel and the 3MF are written in.
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')

  await page.reload()
  await expect(page.locator('.tag', { hasText: 'in' }).first()).toBeVisible({ timeout: 90_000 })
})

test('a document survives a reload, and its name comes from the prompt', async ({ page }) => {
  await seedKey(page)
  await page.route(CHAT_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sseBody(fenced('cube([21, 21, 21]);')),
    }),
  )

  await page.goto('/')
  await waitForStarter(page)
  await send(page, 'make me a knurled knob')

  await expect(page.locator('.tag', { hasText: '21.0 × 21.0 × 21.0 mm' })).toBeVisible({
    timeout: 60_000,
  })
  // The prompt titles the document; the asking is stripped off the front.
  await expect(page.locator('.menubar-doc')).toContainText('Knurled knob')

  // Assert the guarantee itself before reloading, rather than racing the save
  // debounce: the source must actually be in IndexedDB.
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            new Promise<string>((resolve) => {
              const open = indexedDB.open('vibe3d')
              open.onerror = () => resolve('')
              open.onsuccess = () => {
                const read = open.result.transaction('state').objectStore('state').get('lastSource')
                read.onerror = () => resolve('')
                read.onsuccess = () => resolve(String(read.result ?? ''))
              }
            }),
        ),
      { timeout: 10_000 },
    )
    .toContain('cube([21, 21, 21]);')

  // The whole point: reopen and the latest code is still there.
  await page.reload()
  // Back at the launcher, with the work listed and openable.
  await expect(page.locator('.start-name').first()).toHaveText('Knurled knob')
  await page.locator('.start-open').first().click()
  await expect(page.locator('.cm-content')).toContainText('cube([21, 21, 21]);', {
    timeout: 90_000,
  })
  // And so is the conversation that produced it (design.md §7).
  await expect(page.locator('.msg-user', { hasText: 'make me a knurled knob' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Version' })).toHaveValue('2')
})

test('save, edit, and step back through the version picker without losing either state', async ({
  page,
}) => {
  await page.goto('/')
  await waitForStarter(page)
  const picker = page.getByRole('combobox', { name: 'Version' })
  await expect(picker).toHaveValue('1')

  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('cube([8, 8, 8]);')
  await expect(page.locator('.tag', { hasText: '8.0 × 8.0 × 8.0 mm' })).toBeVisible({
    timeout: 60_000,
  })
  // A successful compile of an edit is a version.
  await expect(picker).toHaveValue('2')
  await expect(picker.locator('option[value="2"]')).toHaveText(/edit/)

  await page.getByRole('button', { name: 'Save version' }).click()
  await expect(picker.locator('option[value="2"]')).toHaveText(/saved/)

  // Back to v1: the list keeps v2, and the source is exactly the starter again.
  await picker.selectOption('1')
  await expect(page.locator('.cm-content')).toContainText('plate_x = 60')
  await expect(page.locator('.tag', { hasText: '60.0 × 40.0 × 3.0 mm' })).toBeVisible({
    timeout: 60_000,
  })
  await expect(picker.locator('option')).toHaveCount(2)
})

test('a project exports as one JSON file that imports back as a new document', async ({ page }) => {
  await page.goto('/')
  await waitForStarter(page)

  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export project' }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('A mounting plate.json')
  const text = (await readFile((await file.path())!)).toString()
  const project = JSON.parse(text) as { type: string; schemaVersion: number; versions: unknown[] }
  expect(project.type).toBe('vibe3d/project')
  expect(project.schemaVersion).toBe(1)
  expect(project.versions).toHaveLength(1)
  expect(text).not.toContain('sk-or-')

  await page.locator('.menubar input[type="file"]').setInputFiles({
    name: 'plate.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  })
  await expect(page.locator('.menubar-doc')).toContainText('A mounting plate 2')
  await page.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.locator('.start-open')).toHaveCount(2)
})

test('a corrupt session still restores the last source', async ({ page }) => {
  // The recovery lane: the structured record is unreadable, so revive refuses
  // it — and the user must still get their code back, not the starter.
  await page.addInitScript(() => {
    const open = indexedDB.open('vibe3d')
    open.onupgradeneeded = () => open.result.createObjectStore('state')
    open.onsuccess = () => {
      const tx = open.result.transaction('state', 'readwrite')
      tx.objectStore('state').put({ docs: 'not an array' }, 'session')
      tx.objectStore('state').put('cube([33, 33, 33]);', 'lastSource')
    }
  })

  await page.goto('/')
  await expect(page.locator('.tag', { hasText: '33.0 × 33.0 × 33.0 mm' })).toBeVisible({
    timeout: 90_000,
  })
  await expect(page.locator('.cm-content')).toContainText('cube([33, 33, 33]);')
})
