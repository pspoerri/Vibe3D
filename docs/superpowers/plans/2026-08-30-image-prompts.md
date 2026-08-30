# Image Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user attaches images to a chat message — by paste or file picker — and they reach OpenRouter as multimodal content parts, with the model dropdown flagging which models can read them.

**Architecture:** Images are normalised once, at attach time, to a ≤1568 px JPEG `data:` URL and held in `Chat.tsx` state. They ride their own `ChatEvent`, and `buildWindow` emits them as content parts only for the live turn — so the wire bytes of every later turn are unchanged from today. Nothing is persisted; the attachment dies with the conversation, exactly as the transcript already does on reload and on document switch.

**Tech Stack:** TypeScript 7 (strict), React 19, vitest (node env, no DOM), Playwright against the production build. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-30-image-prompts-design.md`

## Global Constraints

- **No new dependencies.** `package.json` must be byte-identical at the end.
- **Normalisation is fixed:** ≤1568 px longest edge, JPEG quality 0.85, `data:` URL. `design.md:425`.
- **Text part before image parts**, always. OpenRouter's own recommendation; reversing it is a silent quality regression, not an error.
- **Never persist an image.** No IndexedDB writes, no `Doc` field, no chat-log persistence. `design.md:332` forbids base64 in the store, and this plan stays out of the store entirely.
- **No CSP change.** `img-src 'self' data: blob:` and `connect-src 'self' https://openrouter.ai` already cover this. Never `fetch()` a `data:` or `blob:` URL — `connect-src` lists neither.
- **`pnpm build` is the gate.** It runs `tsc --noEmit` over both `tsconfig.json` and `tsconfig.test.json`, so a type error in a *test* file breaks the build. Run it before every commit.
- **vitest runs in the node environment.** `createImageBitmap`, `OffscreenCanvas`, `document` and `HTMLCanvasElement` are all `undefined` there while the DOM lib makes them typecheck. Anything touching them is e2e-only.
- Commit messages follow the repo's convention: `type(scope): lowercase summary`, then a body explaining *why*, and `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Image normalisation

**Files:**
- Create: `src/llm/images.ts`
- Test: `src/llm/images.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_EDGE: number`, `fit(w: number, h: number, max?: number): [number, number]`, `toDataUrl(file: Blob): Promise<string>`.

- [ ] **Step 1: Write the failing test**

Create `src/llm/images.test.ts`. Only `fit` is tested — `toDataUrl` needs a canvas and is exercised in Task 6's e2e.

```ts
import { expect, test } from 'vitest'
import { fit, MAX_EDGE } from './images'

test('an image already inside the cap is left alone', () => {
  expect(fit(800, 600)).toEqual([800, 600])
  expect(fit(MAX_EDGE, MAX_EDGE)).toEqual([MAX_EDGE, MAX_EDGE])
})

test('the longest edge is what meets the cap, in either orientation', () => {
  expect(fit(3000, 1500)).toEqual([MAX_EDGE, 784])
  expect(fit(1500, 3000)).toEqual([784, MAX_EDGE])
})

test('a square scales to the cap on both edges', () => {
  expect(fit(4000, 4000)).toEqual([MAX_EDGE, MAX_EDGE])
})

// A zero dimension is not decodable, but the arithmetic must not answer NaN and
// hand a NaN width to canvas, which throws far away from the cause.
test('a degenerate dimension yields a usable pair, never NaN', () => {
  const [w, h] = fit(0, 0)
  expect(Number.isFinite(w) && Number.isFinite(h)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test images`
Expected: FAIL — `Failed to resolve import "./images"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/llm/images.ts`:

```ts
/**
 * One normalisation path, per design.md §9: downscale to a bounded longest edge,
 * re-encode as JPEG, emit a `data:` URL. Every upstream accepts that shape, so
 * there is nothing to branch on per provider.
 */

/** design.md:425. Above this, providers downsample server-side anyway. */
export const MAX_EDGE = 1568

/**
 * Pure, and exported separately from the encode because vitest runs in the node
 * environment where createImageBitmap and canvas are both undefined — while the
 * DOM lib makes them typecheck. So the arithmetic is unit-tested here and the
 * encode is asserted in Playwright (design.md §11).
 *
 * `Math.min(1, …)` is what makes this only ever shrink: an image already inside
 * the cap is returned at its own size rather than upscaled into blur and bytes.
 */
export function fit(w: number, h: number, max = MAX_EDGE): [number, number] {
  const longest = Math.max(w, h)
  // A zero longest edge would make the scale Infinity and the result NaN, which
  // surfaces as an opaque canvas throw rather than as a bad image.
  const scale = longest > 0 ? Math.min(1, max / longest) : 1
  return [Math.round(w * scale), Math.round(h * scale)]
}

/**
 * A picked or pasted file → the exact string the wire wants.
 *
 * `canvas.toDataURL` is the whole reason this is short: it returns the `data:`
 * URL directly, so there is no FileReader, no base64 assembly, and no object
 * URL — and therefore no revokeObjectURL lifecycle to leak through the Chat
 * remount at App.tsx's `key={session.currentId}`.
 *
 * `imageOrientation: 'from-image'` applies EXIF rotation. A bare drawImage drops
 * it silently, and a phone photo of a part is the motivating input, so sideways
 * is the common case rather than the edge case.
 *
 * Rejects on an undecodable file. The caller reports that as a chat note.
 */
export async function toDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const [w, h] = fit(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser would not give us a 2D canvas.')
    context.drawImage(bitmap, 0, 0, w, h)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    // Frees the decoded bitmap immediately rather than at the next GC. A few
    // 12-megapixel photos is a lot of resident memory to leave lying around.
    bitmap.close()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test images`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/llm/images.ts src/llm/images.test.ts
git commit -m "$(cat <<'EOF'
feat(llm): one normalisation path from a picked file to a data URL

canvas.toDataURL returns the exact string the wire wants, so there is no
FileReader and no object URL — and therefore no revokeObjectURL lifecycle
to leak through the Chat remount on document switch.

fit() is exported apart from the encode because vitest's node environment
has no createImageBitmap and no canvas while the DOM lib makes both
typecheck, so the arithmetic is unit-tested and the encode is left to
Playwright.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Content parts on the wire, and in the window

**Files:**
- Modify: `src/llm/openrouter.ts` (the `ChatMessage` interface, ~line 7-15)
- Modify: `src/chat/log.ts` (the `ChatEvent` union, `WindowInput`, `buildWindow`)
- Modify: `src/chat/log.test.ts`
- Modify: `src/chat/controller.test.ts` (the `contents` helper at ~line 134)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `ContentPart` from `src/llm/openrouter`; `ChatEvent`'s `user` variant gains `images?: readonly string[]`; `WindowInput` gains `images?: boolean` defaulting `true`.

- [ ] **Step 1: Write the failing tests**

In `src/chat/log.test.ts`, first extend the `user` helper and add a flattener beside the existing `count` helper:

```ts
const user = (turn: number, text: string, images?: readonly string[]): ChatEvent => ({
  id: nextId(),
  ts: 0,
  turn,
  kind: 'user',
  text,
  ...(images ? { images } : {}),
})

/** content is no longer always a string, and several assertions do string work. */
const text = (content: ChatMessage['content']): string =>
  typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('')
const texts = (messages: readonly ChatMessage[]): string[] => messages.map((m) => text(m.content))
```

Add `import type { ChatMessage } from '../llm/openrouter'` at the top.

Then apply one mechanical rule across the whole file: **every** `win(…).map((m) => m.content)`
becomes `texts(win(…))`. That is ten call sites — at lines 75, 93, 116, 131, 142, 162, 175, 181,
187 and 197 before any edits. Flattening a plain string returns that string, so every existing
`toEqual([SYS, …])` and `expect.stringContaining(SRC)` assertion still passes unchanged.

Two of those are hard type errors once `content` is a union and will fail the build if missed —
`contents.filter((c) => c.startsWith('ERROR:'))` at lines 162 and 175. The rest are correctness
insurance for when an image is present.

**Leave these four alone**, they are a different shape and are still correct:
`messages[1]?.content` at lines 64 and 230, and `messages.some((m) => m.content === …)` at lines
211 and 223. In particular do **not** flatten line 211 — it asserts no message has empty content,
and an image-only message legitimately flattens to `''`.

Now the new tests:

```ts
const PNG = 'data:image/jpeg;base64,AAAA'
const PNG2 = 'data:image/jpeg;base64,BBBB'

test('the live turn sends its images as parts, with the text part first', () => {
  const messages = win([user(1, 'like this bracket', [PNG, PNG2])], 1)
  expect(messages[1]).toEqual({
    role: 'user',
    content: [
      { type: 'text', text: 'like this bracket' },
      { type: 'image_url', image_url: { url: PNG } },
      { type: 'image_url', image_url: { url: PNG2 } },
    ],
  })
})

// Anthropic and Google both 400 on an empty content block — the same hazard the
// empty-assistant guard exists for.
test('an image with no words emits no empty text part', () => {
  const messages = win([user(1, '', [PNG])], 1)
  expect(messages[1]).toEqual({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: PNG } }],
  })
})

/**
 * The bill test. An image that rode turn 1 must not ride turn 2, or a long
 * session re-pays for every reference photo on every turn — design.md:499's
 * "default failure of this architecture", and it fails silently.
 */
test('an earlier turn keeps its words and loses its images', () => {
  const messages = win([user(1, 'like this', [PNG]), user(2, 'taller')], 2)
  expect(messages[1]).toEqual({ role: 'user', content: 'like this' })
  expect(JSON.stringify(messages)).not.toContain(PNG)
})

/**
 * runCompact's caller closes over the turn that just ran, so without this flag a
 * summarisation would re-bill the images of a turn it considers live — and
 * auto-compact fires unattended, so nobody would see the request that did it.
 */
test('images: false strips them even from the live turn', () => {
  const messages = buildWindow({
    log: [user(1, 'like this', [PNG])],
    turn: 1,
    systemPrompt: SYS,
    source: SRC,
    images: false,
  })
  expect(messages[1]).toEqual({ role: 'user', content: 'like this' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test log`
Expected: FAIL — the first three because `buildWindow` still pushes `event.text` as a bare string, the fourth because `images` is not a `WindowInput` key.

- [ ] **Step 3: Widen the wire type**

In `src/llm/openrouter.ts`, replace the `ChatMessage` interface and its reserved comment:

```ts
/**
 * One part of a multimodal message. `image_url.url` takes a `data:` URL exactly
 * as it takes an `https:` one — the field's own schema says "data: URLs
 * supported" — so normalisation can inline the bytes and nothing has to host a
 * file. No `detail`: the enum is undocumented in the prose guide, and one
 * normalisation path means there is nothing for it to select between.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /**
   * A plain string for every text-only message, so a session that attaches
   * nothing puts byte-identical bytes on the wire — and keeps a byte-identical
   * prompt-cache prefix — as it did before images existed.
   */
  content: string | ContentPart[]
}
```

- [ ] **Step 4: Carry images on the event and through the window**

In `src/chat/log.ts`, add the import and extend the `user` variant:

```ts
import type { ChatMessage, ContentPart } from '../llm/openrouter'
```

```ts
  | {
      id: string
      ts: number
      turn: number
      kind: 'user'
      text: string
      /**
       * Normalised data URLs, live for this turn only (see buildWindow). Held
       * here rather than in a store because the log itself is not persisted:
       * design.md §7's "never base64 in the store" binds the store, and this
       * never reaches it.
       *
       * ponytail: revisit the day the log IS persisted — that is the point at
       * which these must become blob ids and buildWindow must be handed a
       * pre-resolved id → data URL map rather than being made async.
       */
      images?: readonly string[]
    }
```

Extend `WindowInput`:

```ts
  /** The committed document. Never a streamed partial, never a retry candidate. */
  readonly source: string
  /**
   * False strips image parts from every message, live turn included. Exists for
   * exactly one caller — runCompact — whose window is built for the turn that
   * just ran and would otherwise re-bill its images unattended.
   */
  readonly images?: boolean
```

Change the signature and the `user` arm:

```ts
export function buildWindow({
  log,
  turn,
  systemPrompt,
  source,
  images = true,
}: WindowInput): ChatMessage[] {
```

```ts
      case 'user': {
        // Bound to a local so the array narrows: `event.images?.length` as the
        // test leaves `event.images` possibly-undefined at the use site.
        const attached = images && event.turn === turn ? event.images : undefined
        if (!attached?.length) {
          messages.push({ role: 'user', content: event.text })
          break
        }
        // Text first — OpenRouter recommends it explicitly, and getting it
        // backwards degrades the answer without erroring. No empty text part:
        // Anthropic and Google both 400 on an empty content block.
        const parts: ContentPart[] = event.text ? [{ type: 'text', text: event.text }] : []
        for (const url of attached) parts.push({ type: 'image_url', image_url: { url } })
        messages.push({ role: 'user', content: parts })
        break
      }
```

- [ ] **Step 5: Fix the helper that widening breaks**

In `src/chat/controller.test.ts`, the `contents` helper at ~line 134 declares `string[]` from `m.content` and is now a type error. Replace it:

```ts
const contents = (messages: readonly ChatMessage[]): string[] =>
  messages.map((m) =>
    typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
  )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS, whole suite green.

- [ ] **Step 7: Verify the build**

Run: `pnpm build`
Expected: exit 0. This is the step that catches any remaining `m.content` string assumption in a test file.

- [ ] **Step 8: Commit**

```bash
git add src/llm/openrouter.ts src/chat/log.ts src/chat/log.test.ts src/chat/controller.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): images cross the wire as content parts, for their own turn only

Widens ChatMessage.content to the union openrouter.ts had reserved a
comment for. `string` stays in it, so a text-only turn puts byte-identical
bytes on the wire and keeps a byte-identical prompt-cache prefix.

buildWindow emits parts only while event.turn === turn, reusing the test
the assistant arm already makes three lines below: every earlier turn
degrades to its plain text, so a long session's wire bytes are unchanged.
Without that, a reference photo is re-paid for on every turn — the
unbounded-context failure design.md:499 calls this architecture's default.

The `images` flag exists for runCompact alone and is asserted here rather
than left to review, because both it and the live-turn rule fail silently
and surface only on the bill.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The turn carries attachments, compaction does not

**Files:**
- Modify: `src/chat/controller.ts` (`TurnInput` ~line 42-50, `emit` call ~line 84, `runCompact` ~line 239-247)
- Modify: `src/chat/controller.test.ts`

**Interfaces:**
- Consumes: `ChatEvent.images` and `WindowInput.images` from Task 2.
- Produces: `TurnInput` gains `readonly images?: readonly string[]`.

- [ ] **Step 1: Write the failing tests**

In `src/chat/controller.test.ts`, extend the `turnInput` helper:

```ts
const turnInput = (
  userText = 'a box',
  log: ChatEvent[] = [],
  images?: readonly string[],
): TurnInput => ({
  userText,
  log,
  turn: 1,
  systemPrompt: SYS,
  source: SRC,
  ...(images ? { images } : {}),
})
```

Add these tests:

```ts
const IMG = 'data:image/jpeg;base64,AAAA'

test('a repair turn shows the model its image on every attempt', async () => {
  const h = harness({
    replies: [says(fenced('cube(')), says(fenced('cube(3);'))],
    compiles: [failResult('ERROR: one'), okResult()],
  })
  await runTurn(turnInput('like this', [], [IMG]), h.deps)

  // The model has to be repairing against what it was actually shown; dropping
  // the image on the retry changes the problem mid-turn.
  expect(h.windows).toHaveLength(2)
  for (const window of h.windows) {
    expect(JSON.stringify(window)).toContain(IMG)
  }
  expect(h.appended[0]).toMatchObject({ kind: 'user', text: 'like this', images: [IMG] })
})

test('a compaction never re-sends the images of the turn it is summarising', async () => {
  const h = harness({ replies: [says('A bracket, 40 mm wide.')] })
  const log: ChatEvent[] = [
    // Old enough (turn <= 3 - 2) that runCompact finds something to cover.
    { id: 'u0', ts: 0, turn: 1, kind: 'user', text: 'a box' },
    { id: 'a0', ts: 0, turn: 1, kind: 'assistant', text: fenced('cube(1);') },
    // THE POINT: same turn number runCompact is called with, because Chat's
    // compact() closes over the pre-bump turn. buildWindow reads this as live,
    // so without `images: false` the image IS in the window and this fails.
    { id: 'u1', ts: 0, turn: 3, kind: 'user', text: 'like this', images: [IMG] },
    { id: 'a1', ts: 0, turn: 3, kind: 'assistant', text: fenced('cube(3);') },
  ]

  await runCompact({ log, turn: 3, systemPrompt: SYS, source: SRC }, h.deps)

  expect(h.windows).toHaveLength(1)
  expect(JSON.stringify(h.windows[0])).not.toContain(IMG)
})
```

**The turn numbers are the whole test.** Put the image-bearing event on a turn
*older* than the compaction turn and it is not live, so `buildWindow` strips the
image whether or not the flag exists — the test passes against unmodified code
and asserts nothing. `assistant.text` is a `string`, so it takes `fenced(…)`
directly, not `says(fenced(…))`.

```
```

If `runCompact` is not already imported in this file, add it to the existing `./controller` import. If the `harness` helper's `deps` does not already satisfy `runCompact`'s `Pick<TurnDeps, …>`, pass `h.deps` as-is — `runCompact` takes a subset.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test controller`
Expected: FAIL — the first because `TurnInput` has no `images` and the emitted event carries none, the second because `runCompact` builds its window with images live.

- [ ] **Step 3: Thread images through the turn**

In `src/chat/controller.ts`, extend `TurnInput`:

```ts
export interface TurnInput {
  readonly userText: string
  /** Normalised data URLs attached to this message. Live for this turn only. */
  readonly images?: readonly string[]
  /** The log BEFORE this turn. runTurn appends the user event itself. */
  readonly log: readonly ChatEvent[]
```

And the emit at ~line 84:

```ts
    emit({ kind: 'user', text: input.userText, images: input.images })
```

`NewEvent`'s distributive conditional carries the new field with no other change.

- [ ] **Step 4: Strip images from the compaction window**

In `runCompact`, ~line 239:

```ts
  const messages: ChatMessage[] = [
    ...buildWindow({
      log: input.log,
      turn: input.turn,
      systemPrompt: input.systemPrompt,
      source: input.source,
      // Chat's `compact` closes over the turn that just ran — send() bumps the
      // turn state but the closure does not see it — so that turn's user event
      // is still "live" here and its images would be re-billed. Auto-compact
      // fires unattended at 60% of context, so nobody would see the request.
      images: false,
    }),
    { role: 'user', content: COMPACT_PROMPT },
  ]
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS, whole suite green.

- [ ] **Step 6: Verify the build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/chat/controller.ts src/chat/controller.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): the turn carries its images, the compaction call does not

runTurn emits them on the user event, so the turnEvents mirror carries
them into every repair attempt's window — the model repairs against what
it was actually shown rather than against a problem that changed mid-turn.

runCompact passes images: false. Chat's `compact` closes over the turn
that just ran, because send() bumps the turn state after the closure is
made, so that turn's user event still reads as live inside buildWindow.
Without the flag an unattended auto-compact silently re-bills every image
in the turn it is summarising.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The system prompt, only when there are images

**Files:**
- Modify: `src/chat/prompt.ts` (`systemPromptFor`)
- Modify: `src/chat/prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `systemPromptFor(units: 'mm' | 'in', images?: boolean): string`.

- [ ] **Step 1: Write the failing tests**

Append to `src/chat/prompt.test.ts`:

```ts
test('a text-only turn gets byte-identical prompts to before images existed', () => {
  // The prefix is the cacheable part. Adding a clause unconditionally would
  // move it for every user who never attaches anything.
  expect(systemPromptFor('mm', false)).toBe(systemPromptFor('mm'))
  expect(systemPromptFor('mm')).toBe(SYSTEM_PROMPT)
})

test('an image turn is told to read layout from the picture and dimensions from the words', () => {
  const prompt = systemPromptFor('mm', true)
  expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true)
  expect(prompt).toContain('Do NOT read dimensions')
})

test('the image clause composes with imperial rather than replacing it', () => {
  const prompt = systemPromptFor('in', true)
  expect(prompt).toContain('1 in = 25.4 mm')
  expect(prompt).toContain('Do NOT read dimensions')
})
```

Ensure `SYSTEM_PROMPT` and `systemPromptFor` are both imported in this file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test prompt`
Expected: FAIL — `systemPromptFor` takes one argument, so the image clause never appears.

- [ ] **Step 3: Write the implementation**

In `src/chat/prompt.ts`, add the clause and restructure `systemPromptFor`:

```ts
/**
 * design.md:193-200 measured models reading dimensions off pixels at 0.07-0.09
 * IoU — this is a known failure being headed off, not a speculative one. The
 * clause is appended only when a turn actually carries images, so a text-only
 * user's cacheable prefix stays byte-identical.
 */
const IMAGE_CLAUSE = `## Reference images

The user has attached one or more images. Read them for layout, proportion, part
count and intent — what the thing is, and how its features sit relative to each
other. Do NOT read dimensions off them: measured size from a picture is
unreliable, and a confidently wrong number is worse than an absent one. Every
dimension comes from the user's words or from an assumption you name. Say in one
line what you took from the image, then build to it.`

export function systemPromptFor(units: 'mm' | 'in', images = false): string {
  const base =
    units === 'mm'
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}

## Units

This user works in inches. Read every unqualified dimension they give you as
inches, and convert: 1 in = 25.4 mm. The source you write stays in millimetres
like all OpenSCAD — do not write inch values into it, and do not add a scale
factor. Where you name a dimension back to the user in prose, give the inch
figure they asked for, with the millimetre value in brackets.`
  return images ? `${base}\n\n${IMAGE_CLAUSE}` : base
}
```

Note this replaces the existing early-return form; the imperial text is unchanged, only relocated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test prompt`
Expected: PASS. The pre-existing imperial tests must still pass — if one asserted on the early-return shape, the relocation is what broke it, and the fix is in the test's expectation, not the prompt text.

- [ ] **Step 5: Verify the build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/chat/prompt.ts src/chat/prompt.test.ts
git commit -m "$(cat <<'EOF'
feat(chat): tell the model to read layout from a picture, not dimensions

design.md:193-200 measures models reading size off pixels at 0.07-0.09
IoU, so an unguarded reference photo produces confident wrong numbers.

Appended only when a turn actually carries images. The system prompt is
an explicitly cacheable prefix, and adding this unconditionally would move
it for every user who never attaches anything.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Flag vision support in the model list

**Files:**
- Modify: `src/llm/openrouter.ts` (`ModelInfo` ~line 189, `loadModels` ~line 226)
- Modify: `src/llm/openrouter.test.ts` (the `CATALOGUE` fixture ~line 200, the exact-keys assertion ~line 250)
- Modify: `src/chat/Chat.tsx` (the model `<option>` ~line 389)
- Modify: `e2e/chat.spec.ts` (the `seedKey` catalogue fixture ~line 32)

**Interfaces:**
- Consumes: nothing.
- Produces: `ModelInfo` gains `vision: boolean`.

- [ ] **Step 1: Write the failing tests**

In `src/llm/openrouter.test.ts`, give the first catalogue entry the modern field. The fixture currently carries only the legacy `architecture: { modality: 'text+image->text' }`; the live API reports `input_modalities`:

```ts
      architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
```

Update the exact-keys assertion at ~line 250 and its comment:

```ts
  // Only the declared fields survive the parse; pricing passes through whole.
  expect(Object.keys(models[0] ?? {})).toEqual([
    'id',
    'name',
    'context_length',
    'pricing',
    'vision',
  ])
```

Add:

```ts
test('vision is flagged from input_modalities, and absent means unknown not no', async () => {
  stubFetch(() => new Response(JSON.stringify(CATALOGUE), { status: 200 }))
  const models = await fetchModels('https://vision.example/v1')

  expect(models[0]?.vision).toBe(true)
  // The alias entry declares no architecture at all. That is "we cannot tell",
  // and it must never hide or disable the model — support is per-provider while
  // OpenRouter load-balances providers, so the flag is a hint either way.
  expect(models[1]?.vision).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test openrouter`
Expected: FAIL — `vision` is not a key on the parsed model.

- [ ] **Step 3: Derive the flag**

In `src/llm/openrouter.ts`, extend `ModelInfo`:

```ts
  /** USD per TOKEN, as decimal strings. Multiply by 1e6 to display $/M. */
  pricing: { prompt: string; completion: string }
  /**
   * True only where the catalogue explicitly lists image input. False means
   * "not flagged", NEVER "cannot" — vision support is per-provider while
   * OpenRouter load-balances providers, so this is a hint in both directions,
   * and a model served from a custom base URL may not be in the catalogue at
   * all. Nothing is hidden, disabled or blocked on it.
   */
  vision: boolean
}
```

Add a raw shape above `loadModels` and use it — the current code casts the untrusted body straight to `ModelInfo[]`, which would now be claiming a `vision` field the API never sends:

```ts
/** What the catalogue actually sends. Every field is a claim, not a fact. */
interface RawModel {
  id: string
  name: string
  context_length: number
  pricing: { prompt: string; completion: string }
  architecture?: { input_modalities?: string[] }
}

async function loadModels(baseUrl: string): Promise<readonly ModelInfo[]> {
  const response = await fetch(`${baseUrl}/models`)
  const data = ((await response.json()) as { data?: unknown } | null)?.data
  const models: readonly RawModel[] = Array.isArray(data) ? data : []
  return (
    models
      // `openrouter/*` prices itself with the -1 variable-pricing sentinel,
      // which corrupts any sort; `:batch` ids are async duplicates. `:free`
      // stays, and an id may legitimately start with `~` or contain `/`.
      .filter(({ id }) => !id.endsWith(':batch') && !id.startsWith('openrouter/'))
      .map(({ id, name, context_length, pricing, architecture }) => {
        // Bound first: `Array.isArray(architecture?.input_modalities)` narrows
        // the property but not `architecture` itself, so the inline form is a
        // type error. And the isArray check is not ceremony — a bare
        // `?.includes('image')` on a string field would substring-match.
        const modalities = architecture?.input_modalities
        return {
          id,
          name,
          context_length,
          pricing,
          vision: Array.isArray(modalities) && modalities.includes('image'),
        }
      })
  )
}
```

- [ ] **Step 4: Show it in the dropdown**

In `src/chat/Chat.tsx`, the model `<option>`:

```tsx
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                      {model.vision ? ' · vision' : ''}
                    </option>
                  ))}
```

A `<select>` renders text only, so the flag is text. Nothing else changes — the list is not filtered and no model is disabled.

- [ ] **Step 5: Update the e2e catalogue fixture**

In `e2e/chat.spec.ts`, inside `seedKey`, give the stubbed model the field so Task 6's assertion has something true to assert:

```ts
          {
            id: 'google/gemini-3.7-flash',
            name: 'Gemini 3.7 Flash',
            context_length: 1048576,
            architecture: { input_modalities: ['text', 'image'] },
            pricing: { prompt: '0.00000075', completion: '0.00000375' },
          },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: PASS, whole suite green.

- [ ] **Step 7: Verify the build**

Run: `pnpm build`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/llm/openrouter.ts src/llm/openrouter.test.ts src/chat/Chat.tsx e2e/chat.spec.ts
git commit -m "$(cat <<'EOF'
feat(llm): the model list says which models can read an image

Derived from architecture.input_modalities, which is what the catalogue
reports today — the fixture's `modality: 'text+image->text'` is the older
field and is kept only so the parse is exercised against both.

Additive, and deliberately so: false means "not flagged", never "cannot".
Vision support is per-provider while OpenRouter load-balances providers,
so the flag can be right and the request still fail, and a model behind a
custom base URL may not be in the catalogue at all. Nothing is filtered,
disabled or blocked on it.

This widens loadModels' projection past the four fields openrouter.test.ts
pins deliberately, so that tripwire moves with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The composer

**Files:**
- Modify: `src/chat/Chat.tsx`
- Modify: `src/index.css`
- Modify: `e2e/chat.spec.ts`

**Interfaces:**
- Consumes: `toDataUrl` (Task 1), `TurnInput.images` (Task 3), `systemPromptFor(units, images)` (Task 4).
- Produces: the finished feature. Nothing downstream.

- [ ] **Step 1: Write the failing e2e tests**

Add to `e2e/chat.spec.ts`. A 1×1 PNG as base64, no network fetch — `connect-src` lists neither `data:` nor `blob:`, so fetching one would be a CSP violation in the built app:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm e2e chat.spec.ts`
Expected: FAIL — there is no `.chat-attach` and no `.chat-thumb`.

- [ ] **Step 3: Wire the composer**

In `src/chat/Chat.tsx`, add the import:

```ts
import { toDataUrl } from '../llm/images'
```

Add the constant beside `REVOKE_HOME`:

```ts
/** A plain cap, chosen over reasoning about 413 payload_too_large: OpenRouter
 *  documents no inline size limit and providers enforce their own. */
const MAX_IMAGES = 4
```

Add the state beside `input` (~line 39):

```ts
  const [attachments, setAttachments] = useState<readonly string[]>([])
```

No ref mirror, unlike `logRef`: the composer is disabled for the duration of a
turn, so `attachments` cannot change between `send`'s render and its await.

Add the handler after `note` (~line 73):

```ts
  /**
   * Normalises at attach time rather than at send time, so the cost of a
   * 12-megapixel photo is paid once, while the user is still typing, and the
   * tray doubles as the signal that it finished.
   */
  const attach = async (picked: readonly File[]) => {
    const images = picked.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    const room = MAX_IMAGES - attachments.length
    if (room <= 0) {
      note(`Already at ${MAX_IMAGES} images.`, 'error')
      return
    }
    // Silently dropping the overflow looks like the paste failed.
    if (images.length > room) note(`Attached ${room} — ${MAX_IMAGES} images is the limit.`)
    try {
      const urls = await Promise.all(images.slice(0, room).map(toDataUrl))
      // Re-capped inside the updater, not just against the closure's `room`:
      // two picks racing each other both read the same stale length otherwise.
      setAttachments((current) => [...current, ...urls].slice(0, MAX_IMAGES))
    } catch {
      note('That image could not be read.', 'error')
    }
  }
```

In `send`, the guard (~line 184):

```ts
    const text = input.trim()
    if (!text && attachments.length === 0) return
```

In the command branch, beside `setInput('')` (~line 189) — images staged before
a `/clear` would otherwise leak into the next real message:

```ts
      setInput('')
      setAttachments([])
```

At the start of the turn, beside `setInput('')` (~line 207):

```ts
    setInput('')
    setAttachments([])
```

The `TurnInput` (~line 219). `attachments` is read from the closure, which still
holds the pre-clear array — that is why the clear above is safe:

```ts
        {
          userText: text,
          images: attachments,
          log: logRef.current,
          turn,
          systemPrompt: systemPromptFor(units, attachments.length > 0),
          source,
        },
```

- [ ] **Step 4: Add the tray, the picker and the thumbnails**

Inside `<form className="chat-form">`, above `<div className="chat-input">`:

```tsx
        {attachments.length > 0 && (
          <div className="chat-tray">
            {attachments.map((url, i) => (
              <button
                key={i}
                type="button"
                className="chat-thumb"
                title="Remove"
                disabled={busy}
                onClick={() => setAttachments((current) => current.filter((_, j) => j !== i))}
              >
                <img src={url} alt="" />
              </button>
            ))}
          </div>
        )}
```

On the `<textarea>`, add:

```tsx
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) =>
                f.type.startsWith('image/'),
              )
              // Conditional: an unconditional preventDefault breaks text paste.
              if (files.length === 0) return
              e.preventDefault()
              void attach(files)
            }}
```

Inside `<div className="chat-input">`, before the send button:

```tsx
          <label className="chat-attach" title="Attach images">
            <span aria-hidden="true">▣</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              // The label's `title` names the LABEL, not the input, so without
              // this the control has no accessible name at all.
              aria-label="Attach images"
              disabled={busy}
              onChange={(e) => {
                void attach([...(e.target.files ?? [])])
                // So the same file can be picked twice in a row.
                e.target.value = ''
              }}
            />
          </label>
```

And the send button's guard:

```tsx
            <button
              type="submit"
              className="chat-send"
              disabled={!input.trim() && attachments.length === 0}
              aria-label="Send"
            >
```

In `ChatEventView`, the `user` case:

```tsx
    case 'user':
      return (
        <div className="msg msg-user">
          {event.images && event.images.length > 0 && (
            <div className="msg-images">
              {event.images.map((url, i) => (
                <img key={i} src={url} alt="" />
              ))}
            </div>
          )}
          {event.text}
        </div>
      )
```

- [ ] **Step 5: Style it**

Append to the composer block in `src/index.css`, after `.chat-send.stop`:

```css
/* Staged images sit above the field rather than inside it: a thumbnail row in
   the flex line would fight the textarea for the width it grows into. */
.chat-tray { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
.chat-thumb {
  flex: none; width: 42px; height: 42px; padding: 0; cursor: pointer; overflow: hidden;
  border: 1px solid #c8ccc4; border-radius: 3px; background: #fff;
}
.chat-thumb:hover:not(:disabled) { border-color: #a8256b; }
.chat-thumb:disabled { opacity: .5; cursor: default; }
.chat-attach {
  flex: none; width: 26px; height: 26px; border-radius: 2px; cursor: pointer;
  border: 1px solid #c8ccc4; background: #fff; color: #414741;
  display: grid; place-items: center; font: 600 12px/1 system-ui, sans-serif;
}
.chat-attach:hover { border-color: #b8860b; color: #b8860b; }
.chat-attach:has(input:disabled) { opacity: .4; cursor: default; }
/* The control is the label; the input is only the file dialog behind it — but
   `display: none` would make it unfocusable and Tab would skip the control
   entirely, so it is clipped rather than removed. */
.chat-attach input {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
/* The focus ring has to be drawn on the label, because the thing that takes
   focus is a 1px clipped input nobody can see. */
.chat-attach:has(input:focus-visible) { border-color: #b8860b; box-shadow: 0 0 0 2px #faf3e0; }

/* .msg-user is pre-wrap, so the thumbnails need a block of their own or the
   surrounding whitespace becomes visible text between them. */
.msg-images { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.msg-images img { width: 88px; height: 88px; object-fit: cover; border-radius: 2px; display: block; }
.chat-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
```

- [ ] **Step 6: Run the e2e suite to verify it passes**

Run: `pnpm e2e chat.spec.ts`
Expected: PASS, including the pre-existing tests. Watch specifically that
`'the composer grows with a long prompt instead of clipping it'` still passes —
the attach button is a new flex item in `.chat-input`.

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm build && pnpm e2e`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/chat/Chat.tsx src/index.css e2e/chat.spec.ts
git commit -m "$(cat <<'EOF'
feat(chat): attach images to a prompt, by paste or by picker

Normalisation runs at attach time, not at send time, so a 12-megapixel
photo is paid for while the user is still typing and the tray doubles as
the signal that it finished.

No drag-and-drop: it needs page-level dragover suppression, and a missed
drop navigates the tab to the file. Paste and a picker cover both real
inputs.

Five guards that each fail silently: the empty-send test admits an
image-only message, the command branch clears the tray so images staged
before /clear cannot leak into the next message, the send button enables
on a non-empty tray, the turn reads attachments from its closure before
the clear lands, and onPaste calls preventDefault only when an image was
actually found — unconditionally, it breaks ordinary text paste.

Attachments are not persisted. They die with the conversation, which is
what the transcript already does on reload and on document switch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Reconcile the design doc

**Files:**
- Modify: `docs/design.md`

**Interfaces:** none.

The repo's own ritual — `cd52765`, `3a7b9da` — is that design.md is corrected when contact with the code falsifies it. Two things this work touched are now stale, plus one it introduces.

- [ ] **Step 1: Fix the status line and the file map**

`docs/design.md:7` still says Milestones 3-4 are not started, though M3 shipped in `2f7f50f`, `715ce90` and `bae0102`. §4's file map still lists `state/project.ts`, which does not exist — the shipped store is `state/documents.ts` plus `state/store.ts`. Correct both, and add `llm/images.ts` to the map.

- [ ] **Step 2: Record what images actually do**

Add a short subsection under §9 stating: user-supplied reference images are input, live for their own turn only, normalised to ≤1568 px JPEG data URLs, never persisted, and never gated on the catalogue's vision flag. Note explicitly that §6's −20% compile-rate finding and its non-negotiable structured-verification rule govern *rendered output fed back to the model* — Milestone 4's vision-refine loop — and not a user's reference photo, so nothing in this work implements or presumes §6.

- [ ] **Step 3: Verify nothing else drifted**

Run: `grep -n "project.ts\|Milestone 3\|Milestones 3" docs/design.md`
Expected: no stale hits remain.

- [ ] **Step 4: Commit**

```bash
git add docs/design.md
git commit -m "$(cat <<'EOF'
docs: design.md's status line and file map did not survive milestone 3

The status line still said milestones 3-4 were not started, and §4's map
still listed state/project.ts, which never shipped — the store is
state/documents.ts plus state/store.ts.

Also records what a reference image now does, and draws the line §6 does
not: the -20% compile-rate finding is about rendered output fed back to
the model, not about a photo the user attaches as input.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Out of scope

The session cost meter's reset is **not** in this plan. `spend` lives in `Chat.tsx`'s React state and is discarded on every document switch and reload by construction, but the reported symptom — the meter showing only the last turn — was not reproduced in either the dev server or the production build, and its root cause is unknown. Accumulating cost per document needs a `Doc` field and `reviveDoc` parsing; writing that before the diagnosis would mask a per-prompt bug rather than fix it. The diagnostic patch is parked outside the repo and re-applies with `git apply`.

Also not here, and each a deliberate no in the spec: no blob store, no chat-log persistence, no GC across `forkDoc` siblings, no `pricing.image`, no `detail` field, no CSP change, no `provider: {require_parameters}`, no drag-and-drop, no PDF or other non-image file, no new dependency.
