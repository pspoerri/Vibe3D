# Image prompts

A user attaches one or more images to a chat message; they cross the wire to OpenRouter as
multimodal content parts alongside the text. The model dropdown says which models can read them.

Scope decided with the project owner, smallest-first on every fork:

- **Input methods:** paste into the composer, and a file-picker button. No drag-and-drop.
- **Lifetime:** the image lives on its `ChatEvent` and dies with the conversation — on reload and
  on document switch, exactly as the transcript already does. No blob store, no persistence.
- **Context:** the image rides its own turn only, including that turn's repair attempts. From the
  next turn on, the message degrades to its text.
- **Files:** images only. No PDF, STL or DXF.
- **Vision:** flagged in the model dropdown. Never enforced.

---

## 1. Why the lazy answers hold

`design.md` §7 rules image Blobs into IndexedDB and forbids base64 in the store. That rule binds
the *store*, and the chat log is not in it: `Doc` is `{id, name, source, createdAt, updatedAt,
parentId, named?}`, `reviveDoc` is a strict whitelist that drops anything else, and IndexedDB holds
exactly two records — `session` and `lastSource`. A data URL on a `ChatEvent` therefore never
reaches storage. `App.tsx:305` remounts `Chat` on `key={session.currentId}`, so the transcript is
already discarded on every document switch; an attachment that dies with it is consistent rather
than lossy.

The day the log is persisted, this decision has to be revisited. That is what the `ponytail:`
marker in `log.ts` is for.

`design.md` §6's finding that naive image feedback dropped GPT-4's compile rate 20%, and its
"structured verification questions, non-negotiable" rule, are about **rendered output fed back to
the model** — Milestone 4's vision-refine loop. They do not govern a user-supplied reference photo,
which is input, not feedback. Nothing here implements or presumes §6.

## 2. Wire format

OpenRouter takes one content part per image:

```json
{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,…"}}
```

`url` is the only required key; a `data:` URL and an `https:` URL are interchangeable. Facts that
constrain us:

- **Text part first.** OpenRouter recommends text before images explicitly. Getting it backwards
  is a silent quality regression, not an error.
- **No `detail` field.** The OpenAPI enum is `auto | low | high | original`, undocumented in the
  prose guide. Omitting it takes the `auto` default and keeps `design.md`'s single normalisation
  path a single path.
- **`prompt_tokens` already includes image tokens** — annotated "Including images, input audio, and
  tools if any". There is no `image_tokens` field for input. `cost.ts` needs no change.
- **`pricing.image` is not worth modelling.** It exists on 29 of 396 models, almost all Gemini,
  where its value is byte-identical to `pricing.prompt`. Given `addUsage`'s all-or-nothing `usd`
  rule, wiring it in would null the session total more often than it would sharpen it.
- **No CSP change.** `img-src 'self' data: blob:` already renders the thumbnails and
  `connect-src https://openrouter.ai` already carries the body. Note `connect-src` does *not* list
  `blob:`, which is one reason §3 never creates an object URL.
- **Accepted mime types** are png, jpeg, webp and gif. Normalising to JPEG lands inside that set.

## 3. Normalisation — `src/llm/images.ts`

One path, per `design.md:425`: downscale to ≤1568 px on the longest edge, JPEG q0.85, emit a
`data:` URL.

```ts
export const MAX_EDGE = 1568

export function fit(w: number, h: number, max = MAX_EDGE): [number, number]
export async function toDataUrl(file: Blob): Promise<string>
```

`toDataUrl` is `createImageBitmap(file, {imageOrientation: 'from-image'})` → `<canvas>` →
`canvas.toDataURL('image/jpeg', 0.85)`.

Three reasons this shape and not another:

- `toDataURL` returns the exact string the wire wants. No `FileReader`, no base64 assembly, and
  **no object URL** — so there is no `URL.revokeObjectURL` lifecycle to leak through the `Chat`
  remount at `App.tsx:305`.
- `imageOrientation: 'from-image'` applies EXIF rotation, which a bare `drawImage` drops silently.
  A phone photo of a part is the motivating input; sideways is the common case, not the edge case.
- `fit` is exported separately because `createImageBitmap` and `OffscreenCanvas` are both
  `undefined` under vitest's node environment while the DOM lib makes them typecheck. The
  arithmetic is unit-tested; the encode is exercised in Playwright. This is `design.md` §11's split,
  not a new one.

A decode failure rejects. The caller reports it as a chat note and stages nothing.

## 4. The window — `src/chat/log.ts`

`ChatEvent`'s `user` variant gains `images?: readonly string[]` (normalised data URLs).

`buildWindow`'s `case 'user'` becomes conditional on the live turn — the same
`event.turn === turn` test the `assistant` arm already uses three lines below:

```ts
case 'user': {
  // Bound to a local so the array narrows; `event.images?.length` as the test
  // leaves `event.images` possibly-undefined at the use site.
  const live = event.turn === turn && images !== false ? event.images : undefined
  if (!live?.length) { messages.push({ role: 'user', content: event.text }); break }
  messages.push({
    role: 'user',
    content: [
      ...(event.text ? [{ type: 'text' as const, text: event.text }] : []),
      ...live.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
    ],
  })
  break
}
```

`WindowInput` gains `images?: boolean`, defaulting true. It exists for exactly one caller — see
below.

Consequences, all intended:

- A turn's three repair attempts each rebuild the window from the log, so the image is present for
  every attempt of the turn that owns it — the model repairs against what it was shown.
- Every earlier turn degrades to its plain text string, so a long session's wire bytes are
  unchanged from today. This is `design.md:499`'s unbounded-context failure, headed off the same
  way `stubFences` heads it off for superseded source.
- **`runCompact` must pass `images: false`.** `compact` closes over `turn` from its render, and
  `send` calls it after `setTurn(finished + 1)` has been queued but before the closure sees it
  (`Chat.tsx:263-273`), so `runCompact` receives the turn that just ran — whose user event is
  therefore *live*, images and all. Auto-compact fires unattended at 60% of context, so without
  this a summarisation call silently re-bills every image in the turn, and the user never sees the
  request that did it. This is the one place the flag is needed and the reason it exists.
- An image-only message emits no empty text part. Anthropic and Google both 400 on an empty
  content block — the same hazard the empty-assistant guard at `log.ts:87` exists for. Do **not**
  add a symmetric empty-guard to the user arm, or an image-only message vanishes from the window.

## 5. Composer and transcript — `src/chat/Chat.tsx`

One `useState<string[]>` holding normalised data URLs, capped at **4** images. Attaching past the
cap keeps the first four and reports the rest as a chat note — silently dropping them would look
like the paste failed. The cap is a plain `if`, chosen over reasoning about `413 payload_too_large`:
OpenRouter documents no inline size limit and providers enforce their own, so a small fixed number
is the honest guess. Two ways in:

- `onPaste` on the textarea: walk `e.clipboardData.files`, keep `type.startsWith('image/')`. Call
  `preventDefault` **only** when an image was actually found, or ordinary text paste breaks.
- A button labelling a hidden `<input type="file" accept="image/*" multiple>`.

No drag-and-drop in v1: it needs page-level `dragover` suppression, and a missed drop navigates the
tab to the file.

A pending tray renders thumbnails with remove buttons; `ChatEventView`'s `user` case renders them
in the transcript. `.msg-user` is `white-space: pre-wrap; align-self: flex-end`, so thumbnails need
explicit max dimensions or they stretch.

Five one-line changes that are each a silent failure if missed:

| Line | Change | Missed → |
| --- | --- | --- |
| `:184` | `if (!text && attachments.length === 0) return` | image-only message unsendable |
| `:198` | clear the tray in the command branch | images staged before `/clear` leak into the next message |
| `:207` | `setAttachments([])` beside `setInput('')` | double-send on a long stream |
| `:219` | pass `images` into `TurnInput` | attachment silently never sent |
| `:334` | send enabled when the tray is non-empty | image-only path unreachable by mouse |

The new controls take the existing `disabled={busy}` — Milestone 2's cancellation story rests on
the whole composer being inert for the turn.

An image-only first message feeds `onPrompt('')`, and `nameFromPrompt` answers `UNTITLED`. Accepted:
the document is named on the next prompt that has words in it.

## 6. Vision flag — `src/llm/openrouter.ts`

`ModelInfo` gains `vision: boolean`, derived in `loadModels`:

```ts
vision: Array.isArray(m.architecture?.input_modalities) &&
        m.architecture.input_modalities.includes('image')
```

Displayed as a suffix on the model dropdown's option label. A `<select>` renders text only, so it is
text.

**Absent means unknown, never "no".** The flag is additive — a model that declares `image` is
marked, and everything else is simply unmarked. Nothing is hidden, disabled or blocked, for two
reasons: vision support is per-*provider* while OpenRouter load-balances providers, so the
catalogue flag can be right and the request still fail; and a model missing from the catalogue
entirely (a custom base URL) must stay usable.

When an image does reach a text-only model the response is HTTP 404 with
`No endpoints found that support image input`, which carries no `metadata.error_type`.
`errorMessage` already surfaces that string verbatim in `.chat-error`. No mapping code.

This widens `loadModels`' projection, which **breaks the deliberate tripwire at
`openrouter.test.ts:250`** (`expect(Object.keys(models[0])).toEqual([...])`) and needs the
`CATALOGUE` fixture and the e2e `seedKey` fixture updated alongside.

## 7. System prompt — `src/chat/prompt.ts`

`systemPromptFor` takes a second argument and appends a clause **only** when the turn carries
images, so a text-only user's cacheable prefix is byte-identical to today.

The clause tells the model: images give layout, proportion and intent; every dimension comes from
the user's words; state in one line what you read off the picture before building to it.
`design.md:193-200` measures models reading dimensions off pixels at 0.07–0.09 IoU, so this is a
known failure being headed off, not a speculative one.

`COMPACT_PROMPT` is unchanged, and a compacted summary does drop reference images. That is
consistent with §4 — the image was already gone from the window a turn earlier.

## 8. Tests

Unit, `src/llm/images.test.ts` — `fit` over landscape, portrait, square, already-smaller, and a
zero dimension.

Unit, `src/chat/log.test.ts` — the parts array is text-first; an image-only message emits no empty
text part; an image from an earlier turn is absent from the window while its text survives; and
`images: false` strips the live turn's images too. The last two mirror the existing "the source text
appears exactly once" assertion at `log.test.ts:181`, because getting either wrong fails silently
and surfaces only on the bill.

Unit, `src/chat/controller.test.ts` — a three-attempt repair turn carries the image on all three
windows, and `runCompact`'s window carries none.

Both suites need one shared helper, since `m.content` is no longer a string:

```ts
const text = (c: ChatMessage['content']): string =>
  typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('')
```

`controller.test.ts:134`'s `contents` helper is exactly this and becomes a type error until it uses
it.

E2E, `e2e/chat.spec.ts` — paste a 1×1 PNG via a synthetic `ClipboardEvent` (React 19 delegates at
the container root, so it must be `bubbles: true`), then assert the intercepted POST body carries
one `image_url` part, prefixed `data:image/jpeg`, ordered after the text part, exactly once. A
second test asserts the dropdown marks the vision model and not the text-only one.

## 9. Deliberately not in scope

No blob store. No chat-log persistence. No GC across `forkDoc` siblings. No `pricing.image`. No
`detail` field. No CSP change. No `provider: {require_parameters}` — `design.md:418` marks it
obsolete and it can only narrow routing into a 503. No drag-and-drop. No new dependency.

## 10. Open, and not part of this spec

The session cost meter resets under conditions not yet reproduced. `spend` lives in `Chat.tsx:52`'s
React state, so it is discarded on every document switch and reload by construction; the reported
symptom is narrower than that and is still under diagnosis. Accumulating cost per document requires
a `Doc` field and `reviveDoc` parsing, and must not be written until the reset's root cause is
known — moving the state would mask a per-prompt bug rather than fix it.
