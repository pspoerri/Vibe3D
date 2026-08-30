# Milestone 2 — Agent Loop, OpenRouter Client & Customizer Sliders

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Describe a part in chat; the model writes OpenSCAD, the browser compiles it, and a
deterministic controller — not the model — decides when to retry and when to stop. Plus
Customizer sliders that re-parametrise the model with zero LLM calls.

**Scope decided with the user:** the loop, the OpenRouter client, and the sliders. OAuth PKCE
primary with paste-a-key fallback. Commands `/clear`, `/model`, `/key`, `/export`, `/compact`.
No `/undo` (needs Milestone 3's version timeline), no vision-refine rounds (Milestone 4).

**Spec:** `docs/design.md` §5, §7, §9, §10, §12.


**Base:** proposal `minimal` (highest tally, 22.5), with `future`'s log/window architecture and
`testable`'s controller rules grafted in, and every judge-raised defect fixed.

**Everything in this document that describes existing code was copied from the source on
2026-08-30, not from a proposal.** Every external claim marked *verified* was re-executed today;
the transcripts are in §8. Anything I could not execute is in §7 as UNVERIFIED with the decision
taken.

---

## 1. Architecture statement

Milestone 2 adds three vertical slices over one spine. `src/llm/*` is pure network and parsing: a
hand-rolled 22-line SSE reader, one `streamChat` generator, the model catalogue, and OAuth PKCE —
no new runtime dependency, because the only genuinely hard part of SSE (multi-byte UTF-8 torn
across chunk boundaries) is solved by the native `TextDecoderStream` that `eventsource-parser`
would still require us to call. `src/chat/*` is an **append-only `ChatEvent[]` log** plus one pure
translator `buildWindow(log, turn, source)` that derives the wire `ChatMessage[]`, so `/clear` and
`/compact` are themselves log events treated as window boundaries — the log is never mutated or
truncated, which is exactly the shape Milestone 3's IndexedDB persistence and `/undo` need. The
controller `runTurn` is a plain async function with `stream`/`compile`/`append`/`now`/`newId`
injected and a total non-rejecting `TurnOutcome` return, so the entire retry state machine is a
Vitest node-env unit with no React, no network and no kernel. Three races are removed by
construction rather than handled: streamed tokens go to a separate `streamSource` and never into
`source` (so `source` is always a complete committed document — the thing export compiles, the
Customizer parses, and M3 will commit as a `Version`); the composer is disabled for the whole turn
(so `/clear`, `/model` and a second send are unreachable mid-turn); and the editor's external
transactions carry an `Annotation` that suppresses its own `onChange`, which closes the
**CodeMirror feedback loop none of the three proposals noticed** (`Editor.tsx:67` dispatches, and
`Editor.tsx:45-46`'s `updateListener` fires on that dispatch with `docChanged` true and calls
`onChange` — a path that never executes in M1 and would be the primary path in M2). Customizer
sliders scan the source once into byte offsets, substitute with `slice + literal + slice`, and
drag-preview by compiling the **untouched committed source** with `-D name=v -D $fn=16` through a
new `defines` field on `CompileRequest`, writing into the document only on release. Auth is OAuth
PKCE first (verified working against `http://localhost` on any port, falsifying design §9) with
paste-a-key as the fallback, and a build-only CSP meta tag carrying `'wasm-unsafe-eval'` ships in
the same milestone because that is when the key first exists.

---

## 2. File table

### Changed

| File | Single responsibility in M2 |
|---|---|
| `docs/design.md` | Corrected first, as Task 1. Six amendments listed in Task 1. |
| `src/kernel/protocol.ts` | Adds `defines?: readonly string[]` to `CompileRequest`. Nothing else. |
| `src/kernel/openscad.worker.ts` | Splices `-D` pairs into the `callMain` args array. |
| `src/kernel/compile.ts` | Third positional param becomes a `CompileOptions` object; the timeout and worker-crash paths gain `timedOut: true` / `crashed: true` discriminators. |
| `src/kernel/noise.ts` | Splits into private `dropNoise`/`capLines` plus two exports: `stripKernelNoise` (display, rewrites `/in.scad`) and `stderrForModel` (model, never rewrites a path or line number). |
| `src/editor/Editor.tsx` | Adds the `External` annotation that stops an externally-driven transaction re-entering `onChange`, a `readOnly` prop behind a `Compartment`, and scroll-to-end on external changes. |
| `src/App.tsx` | Third grid column; `streamSource`, `previewDefines`, `appliedKeyRef`; one `applyCompiled(key, result)`; a second `Compiler` for the turn. |
| `src/index.css` | Third grid column plus `.chat*` / `.params*` class names. Must not reuse `.error` or `.tag`, and must not render `mm` inside a `.tag`. |
| `vite.config.ts` | A ~12-line `apply: 'build'` `transformIndexHtml` plugin injecting the CSP meta into `dist/` only. |
| `README.md` | One paragraph: where the key lives, that it is revocable, and the revoke link. |

### New

| File | Single responsibility |
|---|---|
| `src/state/settings.ts` | `PortableSettings {baseUrl, model}` in its own localStorage record. Reads are try/catch-wrapped. |
| `src/state/key.ts` | The API key, alone, in its own localStorage record and its own module. Never a member of any settings object. |
| `src/llm/sse.ts` | `sseData(body)` — 22-line async generator. `TextDecoderStream` → `getReader` → line split → `data:` payloads → return on `[DONE]` → `reader.cancel()` in `finally`. |
| `src/llm/sse.test.ts` | Chunk-boundary correctness at 1/2/3/7/64/4096 bytes, CRLF torn across a boundary, comment lines, cancellation reaching the source stream. |
| `src/llm/openrouter.ts` | `streamChat`, `ChatError`, `readChunk` (module-private), `errorMessage`, `fetchModels`, `checkKey`, `contextLimit`. The one module that speaks HTTP to a chat host. |
| `src/llm/openrouter.test.ts` | `readChunk` against pasted chunk fixtures; `streamChat` against a stubbed `fetch`; `errorMessage` against the three real error bodies pasted verbatim; `fetchModels` trust-boundary guard. |
| `src/llm/auth.ts` | OAuth PKCE: verifier, S256 challenge, auth-URL builder, sessionStorage round trip, exchange, key-shape validation, `revokeUrl`, `pkceAvailable`. |
| `src/llm/auth.test.ts` | RFC 7636 Appendix B vector, base64url charset, verifier length, the auth-URL builder, `exchangeErrorMessage` over the three verbatim bodies. |
| `src/chat/fence.ts` | Fenced-block extraction with a completeness signal, fence stubbing, and the single CRLF→LF normalisation point for model text. |
| `src/chat/fence.test.ts` | ~15 reply shapes plus a prefix sweep: for a full reply of length N, `extractSource(reply.slice(0,i))` for every i must never report `complete: true` with a source differing from the final one. |
| `src/chat/prompt.ts` | `SYSTEM_PROMPT` in §5's order and `COMPACT_PROMPT`. Prose constants only. |
| `src/chat/log.ts` | `ChatEvent` union and `buildWindow` — the ONLY translator from log to wire. Pure. |
| `src/chat/log.test.ts` | Boundary scan, source-appears-exactly-once, current-turn assistant kept verbatim, other turns' fences stubbed, other turns' compile events dropped, notes excluded, stderr byte-identical. |
| `src/chat/controller.ts` | `runTurn` and `runCompact` — the §5 deterministic state machine. Zero imports from React, three, fetch or the kernel runtime (`import type` only). |
| `src/chat/controller.test.ts` | The milestone's correctness centre. Fake stream/compile/clock, ~16 cases (§4.3's invariant table). |
| `src/chat/commands.ts` | `parseCommand(text)` → a discriminated union or `null`. Pure. |
| `src/chat/commands.test.ts` | Each command with and without an argument; an unknown slash word falls through as an error variant. |
| `src/chat/Chat.tsx` | The third pane: transcript, composer, Stop, command dispatch, the key/model panel (PKCE button, paste field, revoke link, model list). |
| `src/editor/params.ts` | Customizer scanner with byte offsets, `setParam` (substitute + re-scan assertion), `formatLiteral`, `defineFor`, `DRAG_FN`. |
| `src/editor/params.test.ts` | Table-driven against the ~18 snippets whose expected output came from the kernel's own `--export-format=param`. |
| `src/editor/Params.tsx` | Slider / checkbox / select strip under the editor. Drag → `-D` preview on untouched source; release → `setParam`. |
| `e2e/chat.spec.ts` | The whole M2 browser surface in one spec file: stubbed turn, compile counter, retry, Stop, slider drag, PKCE callback, CSP. |

---

## 3. Interfaces

Everything below compiles under the project's exact `compilerOptions` (`strict`,
`noUnusedLocals`, `noUncheckedIndexedAccess`, `target/lib ES2022`, `moduleResolution bundler`,
tsc 7.0.2). Two type traps were reproduced live and are load-bearing:

- `ReadableStream<Uint8Array>.pipeThrough(new TextDecoderStream())` fails with **TS2769**. The
  annotation must be `ReadableStream<Uint8Array<ArrayBuffer>>`, which is exactly what
  `Response.body` already is (verified: assigning `Response.body` to that type compiles clean).
- `Array.prototype.findLastIndex` **does not exist** under `lib: ES2022` — **TS2550**, verified
  with the project's own tsc. Every backwards scan over the log must be a plain reverse `for`.

### 3.1 Existing code, changed

```ts
// ─── src/kernel/protocol.ts (CHANGED: one optional field) ───────────────────
export type ExportFormat = 'off' | 'binstl' | '3mf'

export interface CompileRequest {
  source: string
  format: ExportFormat
  /**
   * OpenSCAD `-D` overrides, e.g. `wall=2.5`. Each entry becomes a separate
   * `-D <entry>` pair. The text is spliced into the source and parsed, so it is
   * a code-injection surface: build entries ONLY with defineFor(), never from
   * free text.
   */
  defines?: readonly string[]
}

// CompileResponse is unchanged.
export type CompileResponse =
  | { type: 'ok'; data: Uint8Array; stderr: string; ms: number }
  | { type: 'error'; stderr: string; ms: number }

// ─── src/kernel/compile.ts (CHANGED) ────────────────────────────────────────
export type { ExportFormat }

/**
 * stderr is the cleaned form for display. stderrRaw is verbatim kernel stderr
 * on the two worker paths — but it is SYNTHETIC on three of five settle paths
 * (`Compile timed out after 60s.`, `Compile cancelled.`, and the DOM
 * ErrorEvent message, which is frequently ''). The three discriminators below
 * exist so the controller never feeds a fabricated diagnostic to the model.
 */
export type CompileResult =
  | { ok: true; data: Uint8Array; stderr: string; stderrRaw: string; ms: number }
  | {
      ok: false
      stderr: string
      stderrRaw: string
      ms: number
      /** Set only by cancel(). Something superseded this compile. */
      cancelled?: true
      /** Set only by the timeout path. Not a repairable diagnostic. */
      timedOut?: true
      /** Set only by worker.onerror. stderrRaw is a DOM message, often ''. */
      crashed?: true
    }

export interface CompileOptions {
  defines?: readonly string[]
  timeoutMs?: number
}

export declare class Compiler {
  // Third positional param was `timeoutMs = 60_000`. No non-test call site
  // passes it today (verified: App.tsx:47 and App.tsx:89 are the only two, and
  // both pass two arguments), so widening it to an options object is
  // source-compatible.
  compile(source: string, format?: ExportFormat, options?: CompileOptions): Promise<CompileResult>
  cancel(): void
  dispose(): void
}

// ─── src/kernel/noise.ts (CHANGED: settles the §5 contradiction) ────────────
/**
 * Display form. Drops the unconditional localization line and blank lines,
 * rewrites /in.scad → model.scad, caps at head-50 + tail-50.
 * Behaviour is UNCHANGED; the existing 5 tests in noise.test.ts stay green.
 */
export declare function stripKernelNoise(stderr: string): string

/**
 * Model form (design §5: "raw stderr, verbatim ... do not rewrite line
 * numbers"). Drops the same noise lines and applies the same cap, but NEVER
 * touches a path or a line number. Sending the unfiltered text instead would
 * open every retry message with "Could not initialize localization", which
 * reads to a model like an error to repair.
 */
export declare function stderrForModel(stderr: string): string

// ─── src/editor/Editor.tsx (CHANGED) ────────────────────────────────────────
export declare function Editor(props: {
  value: string
  onChange: (next: string) => void
  /**
   * false while a turn holds the document. Reconfigured through a single
   * Compartment with [EditorState.readOnly.of(true), EditorView.editable.of(false)],
   * so the doc stays selectable, scrollable and copyable.
   * NOTE: readOnly/editable do NOT block view.dispatch — they are consulted by
   * commands and by the contenteditable surface only. The correctness fix for
   * the external-write path is the External annotation, not this prop.
   */
  editable: boolean
}): React.ReactElement
```

### 3.2 LLM

```ts
// ─── src/llm/sse.ts ─────────────────────────────────────────────────────────
/**
 * Yields the payload of each `data:` line, stopping at the `[DONE]` sentinel.
 * Comment/keepalive lines (`: OPENROUTER PROCESSING`) fall out of the data:
 * filter and can never reach JSON.parse.
 *
 * Line-oriented, not event-oriented: a multi-line `data:` field would yield
 * two payloads instead of one joined value. Safe here because JSON.stringify
 * escapes newlines, so an OpenAI-compatible server would have to deliberately
 * pretty-print across lines. See §6 for the named upgrade path.
 *
 * The parameter annotation is load-bearing — see §3's TS2769 note.
 */
export declare function sseData(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<string, void, undefined>

// ─── src/llm/openrouter.ts ──────────────────────────────────────────────────
export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
/** One named constant: the catalogue moves and this is the only line to change. */
export const DEFAULT_MODEL = 'google/gemini-3.7-flash'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /**
   * M2 always sends a plain string. Milestone 4 widens this to
   * `| Array<{type:'text';text:string} | {type:'image_url';…}>` without
   * touching a call site. OpenRouter's guidance for that array form: text
   * parts before image parts.
   */
  content: string
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: string }

export class ChatError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null for an in-band error under HTTP 200. */
    readonly status: number | null,
    /** error.metadata.error_type. The stable vocabulary — branch on this, never on a code. */
    readonly errorType: string | null,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

export interface ChatOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

/**
 * POST {baseUrl}/chat/completions.
 * Headers: Authorization, Content-Type, HTTP-Referer, X-OpenRouter-Title.
 * Body: { model, messages, stream: true } and NOTHING else.
 *   - NO `provider: { require_parameters: true }`: it filters on request-body
 *     parameters, our body has none any provider lacks, the per-provider
 *     structured-output flakiness design §9 cited is now covered by default
 *     routing's soft preference, and turning it on can only produce a 503.
 *   - NO `usage: {include:true}` and NO `stream_options`: both are documented
 *     deprecated no-ops. Usage is always in the second-to-last chunk.
 *   - NO `credentials` option: the wildcard ACAO carries no
 *     access-control-allow-credentials, so `credentials:'include'` would fail CORS.
 *
 * Checks `response.ok` BEFORE touching `response.body` — verified live today
 * that a stream:true pre-stream failure returns application/json, not SSE.
 * Runs to `[DONE]`, never stopping at the first non-null finish_reason:
 * OpenRouter repeats finish_reason on the accounting frame that carries usage,
 * and /compact's trigger depends on that frame.
 *
 * Throws ChatError for a pre-stream failure and for an in-band `chunk.error`
 * under HTTP 200. Lets AbortError propagate — the caller is the one that aborted.
 */
export declare function streamChat(
  messages: readonly ChatMessage[],
  signal: AbortSignal,
  options: ChatOptions,
): AsyncGenerator<StreamEvent, void, undefined>

/**
 * Normalises the three structurally incompatible error bodies this API really
 * emits (all three re-verified live today, pasted verbatim as test fixtures):
 *   a) {"error":{"message":"Invalid code","code":400}}
 *   b) {"success":false,"error":{"name":"ZodError","message":"<a JSON string
 *      that must be parsed again>"}}   — never show the user the raw Zod array
 *   c) text/plain body `Malformed JSON in request body`
 * Always call this on `await res.text()`, never on a bare `res.json()`: (c)
 * would throw.
 */
export declare function errorMessage(bodyText: string): string

export interface ModelInfo {
  id: string
  name: string
  /**
   * The TOP-LEVEL field, not top_provider.context_length. Verified non-null on
   * all 396 models today; top_provider.context_length is null on 6 and lower on
   * 40 more. One field, no nested optional type.
   */
  context_length: number
  /** USD per TOKEN, as decimal strings. Multiply by 1e6 to display $/M. */
  pricing: { prompt: string; completion: string }
}

/**
 * GET {baseUrl}/models. Unauthenticated, one page (links.next is null and
 * total_count === data.length === 396 today), CORS-open. No cache layer: the
 * server sends `cache-control: public, max-age=300, stale-while-revalidate=3600`
 * and gzips 655 KB down to ~71 KB, so the browser HTTP cache is sufficient.
 * Fetched lazily on first need, memoised in a module-level promise.
 * Filters `:batch` variants and `openrouter/*` (the 5 entries carrying the
 * `-1` variable-pricing sentinel). Trust boundary is one line:
 *   Array.isArray(json?.data) ? json.data : []
 */
export declare function fetchModels(baseUrl: string): Promise<readonly ModelInfo[]>

/** 0 when the id is unknown. Callers MUST guard `> 0` before dividing. */
export declare function contextLimit(models: readonly ModelInfo[], id: string): number

/**
 * GET {baseUrl}/key — one CORS-open request that validates a pasted key at
 * paste time instead of on the first message. Advisory only: a non-200 from a
 * non-OpenRouter baseUrl means "could not validate", never "invalid key", and
 * never blocks saving.
 */
export declare function checkKey(
  baseUrl: string,
  key: string,
): Promise<
  | { ok: true; limitRemaining: number | null; isFreeTier: boolean }
  | { ok: false; message: string }
>

// ─── src/llm/auth.ts (OAuth PKCE) ───────────────────────────────────────────
/** base64url(crypto.getRandomValues(32 bytes)) — 43 chars, RFC 7636 charset. */
export declare function newVerifier(): string

/**
 * base64url(SHA-256(UTF-8 bytes of verifier)), via native btoa. No Buffer
 * polyfill — the docs' own sample says it needs a bundler, and the native path
 * was verified byte-identical today.
 */
export declare function challengeFor(verifier: string): Promise<string>

/**
 * https://openrouter.ai/auth with EXACTLY three params: callback_url,
 * code_challenge, code_challenge_method=S256. There is no state, no client_id,
 * no response_type, no scope, and the redirect param is `callback_url`, not
 * `redirect_uri`. No app pre-registration exists.
 */
export declare function authUrl(callbackUrl: string, challenge: string): string

/**
 * Stores the verifier in sessionStorage (same-origin, survives the cross-origin
 * round trip, dies with the tab) and navigates in the SAME tab via
 * window.location.assign — sessionStorage is copied-then-diverged into a tab
 * opened with window.open or target=_blank.
 * callback_url is `location.origin + location.pathname`, never a constant: the
 * same artifact deploys to a Pages subpath, a custom domain and localhost.
 */
export declare function startPkce(): Promise<void>

/**
 * Returns the minted key, or null when there is no ?code (the ordinary boot
 * case, and the deny case — no documented error contract exists, so absence of
 * ?code means do nothing; an ?error param, if one appears, is surfaced).
 * Deletes the stored verifier and strips ?code with history.replaceState
 * BEFORE awaiting the exchange, because codes are single-use and expire in 10
 * minutes. Guarded by a module-level in-flight flag so React 19 StrictMode's
 * double-invoked effect cannot burn the code.
 * Validates the 200 body at the trust boundary before returning:
 *   typeof key === 'string' && key.startsWith('sk-or-')
 * Throws with a human message on any failure.
 */
export declare function completePkce(): Promise<string | null>

/** Branches on the body text, never on a status code — see §7 R3. */
export declare function exchangeErrorMessage(bodyText: string): string

/** https://openrouter.ai/keys/<lowercase sha256 hex of the key>. Revoke deep link. */
export declare function revokeUrl(key: string): Promise<string>

/**
 * !!globalThis.crypto?.subtle. http://localhost IS a secure context but a LAN
 * IP like http://192.168.1.5:5173 is not, and crypto.subtle is undefined there.
 * Hide the PKCE button when this is false.
 */
export declare function pkceAvailable(): boolean

// ─── src/state/settings.ts AND src/state/key.ts — TWO MODULES ───────────────
// The type system CANNOT enforce design §7's SecretSettings/PortableSettings
// split: structural typing makes `{baseUrl, model, apiKey}` assignable to a
// PortableSettings parameter, and a branded ApiKey is assignable to any string
// field. The enforcement mechanism is physical separation — the key lives in
// its own module and its own localStorage record, and no type in the app holds
// both. §7 of design.md is amended to say so in Task 1.
export interface PortableSettings { baseUrl: string; model: string }
export const DEFAULT_SETTINGS: PortableSettings // { DEFAULT_BASE_URL, DEFAULT_MODEL }
/** Both reads are try/catch-wrapped: a corrupt blob or a browser blocking site
 *  data must fall back to the default, never throw during App boot. */
export declare function loadSettings(): PortableSettings
export declare function saveSettings(next: PortableSettings): void
// src/state/key.ts:
export declare function loadKey(): string   // '' when absent or unreadable
export declare function saveKey(key: string): void
```

### 3.3 Chat

```ts
// ─── src/chat/fence.ts ──────────────────────────────────────────────────────
/**
 * Extracts the OpenSCAD source from a possibly still-streaming reply.
 * Opening fence: /^```[^\n]*$/m (accepts ```openscad, ```scad and bare ```).
 * Closing fence: /^```\s*$/m. The LAST block wins.
 * `complete` is false while the closing fence has not arrived — that is the
 * streaming case, and it is the ONLY signal separating a live preview from a
 * committable document.
 * Normalises CRLF → LF here. This is the single ingest point for model text,
 * and CRLF silently destroys every Customizer annotation downstream.
 */
export declare function extractSource(text: string): { source: string | null; complete: boolean }

/** Replaces every fenced block body with a one-line placeholder. §12's mitigation. */
export declare function stubFences(text: string): string

// ─── src/chat/prompt.ts ─────────────────────────────────────────────────────
export const SYSTEM_PROMPT: string
export const COMPACT_PROMPT: string

// ─── src/chat/log.ts ────────────────────────────────────────────────────────
/**
 * `id` and `ts` are here in M2 (not deferred) because M3 persists this array
 * verbatim into §7's project file and keys it in IndexedDB; adding them later
 * would change the log shape before schemaVersion 1 ships. `turn` is what lets
 * buildWindow scope compile errors and un-stub the current turn's source.
 */
export type ChatEvent =
  | { id: string; ts: number; turn: number; kind: 'user'; text: string }
  | { id: string; ts: number; turn: number; kind: 'assistant'; text: string; stopped?: true }
  | {
      id: string; ts: number; turn: number; kind: 'compile'
      ok: boolean; ms: number; attempt: number; stderr: string
    }
  | { id: string; ts: number; turn: number; kind: 'note'; text: string; tone: 'info' | 'error' }
  | { id: string; ts: number; turn: number; kind: 'clear' }
  | { id: string; ts: number; turn: number; kind: 'summary'; text: string; coversThrough: string }

export interface WindowInput {
  /** The full log INCLUDING the in-flight turn's events so far. */
  readonly log: readonly ChatEvent[]
  /** The turn number in flight. Events with this turn are treated as live. */
  readonly turn: number
  readonly systemPrompt: string
  /** The committed document. Never a streamed partial, never a retry candidate. */
  readonly source: string
}

/**
 * The ONLY translator from log to wire. Pure. Rules, in order:
 *  1. start = index after the last `clear` event (reverse for-loop —
 *     findLastIndex does not exist under lib ES2022, verified TS2550).
 *  2. If a `summary` event exists at or after `start`, emit its text as one
 *     user message and advance start to
 *        max(start, indexOf(id === coversThrough) + 1).
 *     The clamp is what stops a summary replaying events from before a /clear.
 *  3. Walk log[start..]:
 *       user            → user message
 *       assistant       → assistant message; verbatim when e.turn === turn,
 *                         stubFences(e.text) otherwise (§12)
 *       compile, !ok    → user message of e.stderr VERBATIM, and only when
 *                         e.turn === turn. Compile events from earlier turns
 *                         are dropped entirely — stale stderr referencing
 *                         source that no longer exists actively misleads.
 *       compile, ok     → dropped
 *       note            → dropped (UI only, never sent)
 *       clear, summary  → dropped (already consumed as boundaries)
 *  4. Tail: append one user message carrying `source` verbatim in a fenced
 *     block, but ONLY when no assistant message from the current turn was
 *     emitted. On a retry the model already has the source it just wrote
 *     (§5: "do not re-attach the source"), so the source crosses the wire
 *     exactly once per request either way — and it is never mislabelled
 *     "current source" when it is actually a failed candidate.
 */
export declare function buildWindow(input: WindowInput): ChatMessage[]

// ─── src/chat/commands.ts ───────────────────────────────────────────────────
export type Command =
  | { name: 'clear' }
  | { name: 'compact' }
  | { name: 'export'; format: 'binstl' | '3mf' }
  | { name: 'model'; id: string | null }
  | { name: 'key' }
  | { name: 'unknown'; word: string }
/** null for an ordinary message. `/undo` is deliberately absent — it needs M3's
 *  version timeline, and a stub that half-works is worse than none. */
export declare function parseCommand(text: string): Command | null

// ─── src/chat/controller.ts ─────────────────────────────────────────────────
export const MAX_RETRIES = 2          // 1 initial call + 2 repairs = 3 LLM calls max
export const DRAFT_INTERVAL_MS = 100
export const COMPACT_AT = 0.6

export type TurnOutcome =
  | { status: 'committed'; source: string; result: Extract<CompileResult, { ok: true }> }
  | { status: 'answered' }                                      // prose; no fenced block
  | { status: 'failed'; source: string; result: CompileResult } // budget spent or unrepairable
  | { status: 'error'; message: string }                        // stream failed; nothing compiled
  | { status: 'stopped' }                                       // aborted or superseded

export interface TurnDeps {
  readonly stream: (
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ) => AsyncIterable<StreamEvent>
  /** MUST be a Compiler instance the preview does not share — compile() calls
   *  cancel() as its first statement (compile.ts:30), so a shared instance lets
   *  a stray preview silently settle a paid-for turn as cancelled. */
  readonly compile: (source: string) => Promise<CompileResult>
  readonly append: (event: ChatEvent) => void
  /** Streamed partial. NEVER compiled, NEVER written into `source`. */
  readonly onDraft: (source: string | null) => void
  readonly onUsage: (usage: Usage) => void
  /** Injected so the draft throttle is a Vitest assertion, not a timing hope. */
  readonly now: () => number
  readonly newId: () => string
  readonly signal: AbortSignal
}

export interface TurnInput {
  readonly userText: string
  /** Snapshot of the log BEFORE this turn. runTurn appends the user event itself. */
  readonly log: readonly ChatEvent[]
  readonly turn: number
  readonly systemPrompt: string
  /** The committed document at turn start. Read once; never re-read. */
  readonly source: string
}

/** Total and non-rejecting: every failure is a TurnOutcome, never a rejection.
 *  An unhandled rejection would break e2e/smoke.spec.ts:14's zero-pageerror
 *  assertion rather than showing a chat error. */
export declare function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnOutcome>

export interface CompactInput {
  readonly log: readonly ChatEvent[]
  readonly turn: number
  readonly systemPrompt: string
  readonly source: string
}
export type CompactOutcome =
  | { status: 'compacted' }
  | { status: 'nothing-to-compact' }
  | { status: 'error'; message: string }
  | { status: 'stopped' }

/** One LLM call, no retry loop. Refused while a turn is in flight (the caller
 *  enforces this by disabling the composer). Carries its OWN AbortSignal so a
 *  Stop actually stops billing. Never summarises the source. */
export declare function runCompact(
  input: CompactInput,
  deps: Pick<TurnDeps, 'stream' | 'append' | 'now' | 'newId' | 'signal'>,
): Promise<CompactOutcome>

// ─── src/chat/Chat.tsx ──────────────────────────────────────────────────────
export declare function Chat(props: {
  /** The committed document. Read at turn start only. */
  source: string
  /** null ends the turn's ownership of the editor. */
  onStreamSource: (partial: string | null) => void
  /** Called once per turn that produced source — success or final failure. */
  onApply: (source: string, result: CompileResult) => void
  onExport: (format: 'binstl' | '3mf') => void
  /** Drives Editor.editable and the Params panel's disabled state. */
  onBusyChange: (busy: boolean) => void
}): React.ReactElement
```

### 3.4 Customizer

```ts
// ─── src/editor/params.ts ───────────────────────────────────────────────────
export interface ParamRange { min: number; max: number; step: number }
export interface ParamOption { value: string | number; label: string }

interface ParamBase {
  name: string
  caption: string          // '' when there is none
  group: string            // 'Parameters' when there is none
  /** Byte offsets of the VALUE LITERAL only. Substitution is
   *  src.slice(0, start) + literal + src.slice(end), so the trailing annotation
   *  comment (which lives after the `;`) is untouched by construction, and a
   *  name inside a string, a comment or a module default is unreachable
   *  because the scanner never leaves top-level statement context. */
  start: number
  end: number
}

export type Param = ParamBase &
  (
    | { kind: 'number'; value: number; range: ParamRange | null }
    | { kind: 'bool'; value: boolean }
    | { kind: 'enum'; value: string | number; options: readonly ParamOption[] }
  )

/**
 * One pass. Reproduces OpenSCAD's own rules, all verified against the vendored
 * kernel's `--export-format=param` output:
 *  - Collection stops at the LINE of the first `{` outside // and slash-star
 *    comments. A `{` inside a STRING still stops it — the upstream C++ brace
 *    test is not guarded by the inString flag. We reproduce the bug on purpose;
 *    matching the kernel beats matching the wiki.
 *  - It is NOT "before the first module instantiation": `cube(1);`, `for`,
 *    `if`, `let`, `echo`, a function definition and `use <>` all fail to stop
 *    collection when no brace is present.
 *  - An assignment qualifies iff its line < the stop line.
 *  - A re-assigned name yields ONE param bound to the LAST assignment (its
 *    value, its annotation, its offsets). If that assignment is past the stop
 *    line the param disappears entirely.
 *  - min/max are widened by the current value after parsing.
 *  - `[Hidden]` (trimmed) suppresses; groups join multiple brackets with '-'.
 *  - A caption comes only from the previous line, which must begin with `//`
 *    at column 0. Indentation kills it.
 *  - `$`-prefixed names are EXCLUDED from the returned list. OpenSCAD does
 *    expose them, but $fn belongs to the drag controller, not the panel — and
 *    the drag path appends its own `-D $fn=`, where the last -D for a name
 *    wins, so a $fn slider would silently do nothing.
 *  - Vector and string-with-maxLength params are recognised and dropped in M2.
 * Assumes LF line endings. CRLF destroys every annotation (the trailing \r
 * lexes as a WORD and the parse fails), so text is normalised on ingest.
 */
export declare function scanParams(source: string): Param[]

/** Substitutes, then RE-SCANS and confirms the named param came back with the
 *  value just written. Returns `source` unchanged if it did not — the failure
 *  guarded against is silent corruption of the user's document. */
export declare function setParam(
  source: string,
  param: Param,
  value: number | boolean | string,
): string

/** OpenSCAD literal text for a typed value. Strings are quoted. */
export declare function formatLiteral(value: number | boolean | string): string

/** One `-D` entry. Validates the name against /^\$?[A-Za-z_]\w*$/ and THROWS
 *  otherwise, and builds the value with formatLiteral. Free text must never
 *  reach this: `-D 'wall=2; translate([50,0,0]) cube(1)'` was verified to
 *  inject an extra solid. */
export declare function defineFor(name: string, value: number | boolean | string): string

/** Reduced facet count during a drag. */
export const DRAG_FN = 16

// ─── src/editor/Params.tsx ──────────────────────────────────────────────────
export declare function Params(props: {
  source: string
  disabled: boolean
  /** Non-empty while dragging: the App compiles the UNTOUCHED source with these. */
  onPreview: (defines: readonly string[]) => void
  /** Pointer-up / key-up: the new full source, with defines cleared. */
  onCommit: (source: string) => void
}): React.ReactElement
```

### 3.5 App wiring (the shape Task 11 must produce)

```ts
// src/App.tsx
const DEBOUNCE_MS = 600        // existing, unchanged, for source edits
const DRAG_DEBOUNCE_MS = 30    // a 600 ms slider preview is not a preview

/** Identity of a compile. The defines half is load-bearing: without it,
 *  releasing a slider back at its original value would leave the reduced-$fn
 *  mesh on screen forever. The separator is a NUL escape ('\u0000'), which
 *  cannot appear in either half. */
const compileKey = (source: string, defines: readonly string[]): string =>
  defines.join('\u0000') + '\u0000' + source

// appliedKeyRef holds the key of the compile whose result is on screen.
// It is written ONLY by applyCompiled(key, result), which sets
// busy/mesh/ms/error together, and it is written on EVERY settle path.
//
// The debounce effect's FIRST statement — before ++runIdRef and before
// setBusy(true) — is:
//     if (compileKey(source, previewDefines) === appliedKeyRef.current) return
// Placing it anywhere later (e.g. inside the setTimeout callback) leaves the
// "compiling…" tag latched forever, which is verbatim the HUD-desync class
// commit 03d6f57 already fixed once.
//
// Editor renders `streamSource ?? source`, so `source` is ALWAYS a complete
// committed document and the existing export buttons cannot ship a half-file.
```

---

## 4. Controller state machine

### 4.1 One turn

`runTurn(input, deps)` returns exactly one `TurnOutcome` and never rejects. Locals:
`turnEvents: ChatEvent[]` (a mirror of everything it appended, so `buildWindow` can be re-derived
without a getter port), `attempt: 0..MAX_RETRIES`, `candidate: string | null`, `lastDraftAt: number`.

`emit(ev)` pushes to `turnEvents` **and** calls `deps.append(ev)`. All ids/timestamps come from
`deps.newId()` / `deps.now()`.

**ENTRY.** `emit({kind:'user', text: input.userText, turn})`. `attempt = 0`.

**PHASE 1 — STREAM.**
`messages = buildWindow({ log: [...input.log, ...turnEvents], turn, systemPrompt, source: input.source })`
— re-derived on **every** attempt, so the window is a pure function of the log and never grows by
a source copy per attempt.

Iterate `deps.stream(messages, deps.signal)` accumulating `text`:
- `delta` → append; then if `deps.now() - lastDraftAt >= DRAFT_INTERVAL_MS`, call
  `deps.onDraft(extractSource(text).source)` **only when non-null** (never blank the editor
  mid-stream) and update `lastDraftAt`.
- `usage` → record as `lastUsage`, call `deps.onUsage`, and **keep reading**. Never stop at the
  first non-null `finish_reason`: OpenRouter repeats it on the accounting frame, and `/compact`'s
  trigger depends on that frame.
- `finish` → record `finishReason`.

After the loop, one unconditional `deps.onDraft(...)` push.

**PHASE 2 — EXTRACT.**
- A thrown `AbortError` → `emit({kind:'assistant', text, stopped:true})`, return `{status:'stopped'}`.
  The log records what actually arrived; it is append-only precisely so it can.
- Any other throw (`ChatError` included) → `emit({kind:'assistant', text, stopped:true})`,
  `emit({kind:'note', tone:'error', text: message})`, return `{status:'error', message}`.
  **Nothing is compiled.**
- `emit({kind:'assistant', text})`.
- `const { source, complete } = extractSource(text)`.
- If `finishReason === 'length'` **or** `!complete` **or** `source === null` →
  `emit({kind:'note', tone:'error', …})`, return `{status:'error'}`. A truncated stream is an
  unusable half-file. The `!complete` arm is the one that catches a stream ending with
  `finish_reason: 'stop'` on an unclosed fence — a refusal that opened a code block, or a provider
  cut that still reports `stop`.
- If `source === input.source` → return `{status:'answered'}` without compiling: the model echoed
  the document.

**PHASE 3 — COMPILE / RETRY.** `candidate = source`; `result = await deps.compile(candidate)`.

Checked in this exact order; **all three unrepairable checks come before any log append**:

1. `deps.signal.aborted || result.cancelled` → return `{status:'stopped'}`. A cancelled compile is
   not a model error: no compile event is appended (`stderrRaw` is the literal string
   `Compile cancelled.`, which `buildWindow` would replay to the model as a diagnostic), and no
   attempt is spent.
2. `result.timedOut` → `emit({kind:'note', tone:'error', text:"Compile timed out — the model's
   source is too slow to render."})`, return `{status:'failed', source: candidate, result}`.
   **No retry.** `stderrRaw` is the synthetic `Compile timed out after 60s.`; three 60-second
   timeouts is three minutes of dead UI and two paid calls against a message no model can act on.
3. `result.crashed || (!result.ok && result.stderrRaw.trim() === '')` → same treatment as 2, with
   `'The kernel worker crashed.'`. `worker.onerror` sets `stderrRaw = event.message ?? ''`, which
   is frequently empty.
4. `emit({kind:'compile', ok: result.ok, ms: result.ms, attempt, stderr: stderrForModel(result.stderrRaw)})`.
5. `result.ok` → return `{status:'committed', source: candidate, result}`.
6. `attempt === MAX_RETRIES` → return `{status:'failed', source: candidate, result}`.
7. `attempt++`, go to PHASE 1.

**BUDGET.** At most 3 `stream` calls and 3 `compile` calls per turn. `/compact` adds at most one
further `stream` call, outside the turn. There is no transport-level auto-retry anywhere (no
`Retry-After` handling in M2), so the ceiling stated is the real ceiling.

**On `committed` and on `failed`,** the caller writes the source into the document and calls
`applyCompiled` with the already-known result. `failed` still commits, because the user must see
the code to fix it and the error is already on screen; CodeMirror's `history()` makes the external
full-document replace revertible with Ctrl/Cmd+Z (asserted in e2e — see §7 R7).

### 4.2 Cancellation rules

| Trigger | What happens |
|---|---|
| Stop button / Escape | `ac.abort()` **and** `turnCompiler.cancel()` — an `AbortSignal` does not reach a Worker. The fetch rejects with `AbortError`; an in-flight compile settles `{cancelled:true}`. Either path yields `{status:'stopped'}`. |
| Second send mid-turn | **Unreachable.** The composer is `disabled` while a turn is in flight and Send is replaced by Stop; `send()` also returns early when the busy ref is set, so a queued keystroke cannot slip through. No queue, no supersede rule, no product question. |
| `/clear`, `/model`, `/key`, `/compact` mid-turn | Unreachable for the same reason. `runCompact` additionally refuses if called while busy. |
| User edits source mid-turn | Unreachable: `Editor.editable={false}` and `Params.disabled` while busy, `streamSource` is what the editor renders, and `runTurn` reads `input.source` once at entry and thereafter uses its own candidate — so even a buggy caller cannot inject a foreign source into a retry window. |
| Preview compile races the turn | Structurally impossible: the turn holds its own `Compiler` instance (precedent: `App.tsx:87`'s throwaway exporter), and `source` does not change during streaming. |
| Unmount | Abort both controllers and `dispose()` both compilers; no note. |

Every exit path runs `onStreamSource(null)` from the caller's `finally`, so `streamSource` cannot
be left latched.

### 4.3 Invariants — each one a Vitest case in `controller.test.ts`

| # | Invariant |
|---|---|
| I1 | `source` changes during a turn only through the caller's `onApply`, at most once, at the end. `onDraft` never writes `source`. |
| I2 | `onDraft(null)` is called exactly once, on every exit path (the caller does it in a `finally`). |
| I3 | At most one `runTurn` in flight. |
| I4 | At most 3 `stream` calls and 3 `compile` calls per turn — no transport-level retry exists to inflate it. |
| I5 | An aborted turn compiles nothing after the abort point and returns `{status:'stopped'}` with the partial recorded as `{kind:'assistant', stopped:true}`. |
| I6 | `buildWindow` output contains the source text at most once, and at most one stderr block, belonging to the current turn. |
| I7 | A retry message equals `stderrForModel(result.stderrRaw)` byte for byte — no paraphrase, no path or line-number rewriting. |
| I8 | `cancelled`, `timedOut` and `crashed` results never append a `compile` event and never spend an attempt. |
| I9 | A truncated reply (`finish_reason: 'length'`, or an unclosed fence, or no fence) never reaches `compile`. |
| I10 | Auto-compact never fires when `contextLimit(...) === 0` (before `/models` resolves, for an unknown id, for a custom baseUrl). |

### 4.4 `/clear` and `/compact` against the log

The log is append-only, so its event ids are stable forever and a boundary can reference one.

- **`/clear`** appends `{kind:'clear'}` plus a `note`. Source, version timeline and log are
  untouched. The next window is `[system, <current source>]` plus whatever the user types next.
- **`/compact`** (`runCompact`) refuses while a turn is in flight. `coversThrough` = the id of the
  last event whose `turn <= currentTurn - 2`. If there is none it returns
  `{status:'nothing-to-compact'}` and makes no call — this is what preserves §10's "last 2 turns"
  verbatim. Otherwise: one `stream` call over
  `[...buildWindow(...), {role:'user', content: COMPACT_PROMPT}]`; on success append
  `{kind:'summary', text, coversThrough}` and a visible note. It **never** summarises the source —
  `buildWindow` re-attaches that verbatim.
- **Auto-compact** fires after a settled turn when
  `limit > 0 && lastUsage.total_tokens / limit > COMPACT_AT`, using `total_tokens` (next turn's
  prompt includes this turn's completion) and `contextLimit`. Announced with a note; guarded
  against recursion by a ref.
- **`/export`** produces **no log entry at all**, per §10. Feedback is the download plus the
  existing `exporting` button state.

---

## 5. Tasks

Each task is independently committable, leaves `pnpm test && pnpm e2e && pnpm build` green, and
follows the house commit format: `<type>(<scope>): <lowercase imperative>`, blank line, ~72-col
WHY body, blank line, `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. When
review finds a defect in this contract before implementing, amend it and commit as
`docs: plan's <X> ...` (the local convention, e.g. commit 9aef816).

---

### Task 1 — Correct `docs/design.md`

**Files:** `docs/design.md`.

**Why first:** an implementer working Tasks 5–11 must never read a falsified claim and have to
guess which of two contradicting sections won.

Six amendments:

1. **§4's file map is stale.** It lists `export/index.ts` (the repo has `src/export/download.ts`)
   and names `chat/*`, `editor/params.ts`, `viewer/capture.ts`, `viewer/inspect.ts`,
   `state/project.ts`, `state/settings.ts`, none of which exist. Replace with §2's M2 file table,
   and drop the `zustand` mandate — M2 uses plain React state.
2. **§5 vs §9 on the edit protocol.** §5 says "one tool, one string field"; §9 says a fenced code
   block. **§9 wins** — it is the later, specific, evidenced ruling, it streams straight into the
   editor, and it needs no structured-output support. Record the supersession so no reviewer
   re-litigates it. Also record that M2 has **no** vision-refine rounds (that is M4).
3. **§5's stderr ruling.** `compile.ts:7` says `stderrRaw` is "the form Milestone 2 feeds back to
   the model"; `noise.ts:8` says `stripKernelNoise` cleans stderr "for display and, in Milestone 2,
   for the model" — and it rewrites `/in.scad` to `model.scad`, which §5 forbids. Neither is
   right: the model gets `stderrForModel` (noise-filtered, capped, paths and line numbers
   untouched). Both comments are fixed in Task 2.
4. **§7's enforcement mechanism.** The `SecretSettings`/`PortableSettings` type split does not
   enforce anything: structural typing makes `{baseUrl, model, apiKey}` assignable to a
   `PortableSettings` parameter, and a branded key type is assignable to any `string` field.
   Replace with: the key lives in its own module and its own localStorage record, no type in the
   app holds both, and the project-export path never imports `key.ts`.
5. **§9, three corrections.** (a) "PKCE needs a real HTTPS callback, so paste-a-key stays
   permanently as the local-dev path" is **false** — localhost callbacks are supported on any port,
   so PKCE works against `pnpm dev`. Paste-a-key stays as a fallback for a different reason:
   offline dev, an existing key, a failed exchange, and a non-secure origin (a LAN IP) where
   `crypto.subtle` is undefined. (b) `provider: {require_parameters: true}` is obsolete — default
   routing already applies a soft provider preference for `tools`/`response_format`/structured
   outputs, and turning it on can only produce a 503 that reads to a user as a broken app.
   (c) The `eventsource-parser` sentence is dropped — see §6, and note that §9's own "keeping
   dependencies few" paragraph already argued against §9's opening sentence.
6. **§12's "stub superseded sources"** is implemented in `buildWindow`, and it applies to every
   assistant message except the current turn's.

**Test strategy:** none — a docs commit. Gate: `pnpm test && pnpm e2e` unchanged and green.

---

### Task 2 — Kernel seams: `-D` defines, compile options, unrepairable discriminators, `stderrForModel`

**Files:** `src/kernel/protocol.ts`, `src/kernel/openscad.worker.ts`, `src/kernel/compile.ts`,
`src/kernel/noise.ts`, `src/kernel/compile.test.ts`, `src/kernel/noise.test.ts`.

**Produces:** `CompileRequest.defines`; the worker's `-D` splice; `Compiler.compile(source, format,
options)`; `timedOut`/`crashed` on `CompileResult`; `stderrForModel` alongside an unchanged
`stripKernelNoise`.

**Interface contract:** exactly §3.1. Task 9 depends on the three discriminators and on
`stderrForModel`; Task 11 depends on `defines`.

Implementation notes:
- The worker builds a **fresh** args array per call and appends after `--export-format`:
  `...(defines ?? []).flatMap((d) => ['-D', d])`. Emscripten's `callMain` does
  `args.unshift(thisProgram)`, mutating the array it is given — never reuse one.
- `compile.ts:47-50`'s timeout branch gains `timedOut: true`; `compile.ts:69-77`'s `onerror`
  branch gains `crashed: true`. Both keep their existing `stderr`/`stderrRaw` text.
- `noise.ts` becomes private `dropNoise(lines)` + `capLines(lines)` and two exports.
  `stripKernelNoise` = drop + rewrite `/in.scad` + cap; `stderrForModel` = drop + cap, no rewrite.
- Fix the two contradicting comments (`compile.ts:7`, `noise.ts:8`) to name `stderrForModel`.

**Test strategy:** Vitest. Extend `noise.test.ts`: `stderrForModel` keeps `/in.scad` verbatim,
drops the localization line, caps at head-50 + tail-50 with the same elision marker. The five
existing `stripKernelNoise` tests must stay green **unedited** — that is the regression guard.
Extend `compile.test.ts`'s `FakeWorker` to capture `postMessage` and assert `defines` are
forwarded, and that a `CompileOptions` object is accepted positionally in third place, and that
the timeout path sets `timedOut`. `-D` behaviour through a real browser worker is asserted in
Task 12 — it has only ever been verified under Node.

---

### Task 3 — Editor: stop the external-write feedback loop, add `editable`

**Files:** `src/editor/Editor.tsx`.

**Why this is a correctness fix, not a prop:** `Editor.tsx:62-68`'s effect dispatches a
whole-document replace, and `Editor.tsx:45-46`'s `updateListener` fires on that dispatch with
`update.docChanged === true` and calls `onChange` — feeding the value straight back to the parent.
In M1 this path **never executes** (nothing but `source` ever sets `value`, so the
`current === value` guard always short-circuits), so it is completely unexercised. In M2 it is the
primary path, and it silently falsifies every "one compile per turn" claim. `readOnly` and
`editable` do **not** help: per `@codemirror/view`'s own docs, `editable` "doesn't affect API
calls that change the editor content", and `EditorState.readOnly` is "consulted by commands and
extensions".

The fix (this exact shape type-checks clean under the project tsconfig — verified today):

```ts
import { Annotation, Compartment, EditorState } from '@codemirror/state'

const External = Annotation.define<boolean>()
const editableConf = new Compartment()   // one per Editor instance, held in a ref

// in the updateListener:
const external = update.transactions.some((tr) => tr.annotation(External) === true)
if (update.docChanged && !external) onChangeRef.current(update.state.doc.toString())

// in the external-value effect:
view.dispatch({
  changes: { from: 0, to: current.length, insert: value },
  annotations: External.of(true),
  // Keep streamed source in view. Selection is clobbered by a whole-doc
  // replace either way; this at least keeps the tail visible.
  effects: EditorView.scrollIntoView(value.length),
})

// editable prop, in the mount extensions:
editableConf.of([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)])
// toggled by an effect: view.dispatch({ effects: editableConf.reconfigure([...]) })
```

**Interface contract:** `Editor({ value, onChange, editable })`. The only existing caller is
`App.tsx:107`.

**Test strategy:** no component test (jsdom and `@testing-library` are absent, and vitest's
`include` is `src/**/*.test.ts` — a `.tsx` test would not even be collected; design §11 says skip
component tests at MVP). Covered by Task 12's compile counter, the only assertion that would catch
a regression here. The existing three e2e tests, which drive `.cm-content` with real typing, must
stay green — that proves the annotation did not suppress genuine user edits.

---

### Task 4 — SSE reader

**Files:** `src/llm/sse.ts`, `src/llm/sse.test.ts`.

**Produces:** `sseData`. No dependency — see §6.

Shape (22 lines):

```ts
export async function* sseData(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<string, void, undefined> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += value
      const parts = buf.split(/\r\n|[\r\n]/)
      buf = parts.pop() ?? ''
      for (const line of parts) {
        if (!line.startsWith('data:')) continue
        const payload = line.charCodeAt(5) === 32 ? line.slice(6) : line.slice(5)
        if (payload === '[DONE]') return
        yield payload
      }
    }
  } finally {
    await reader.cancel()
  }
}
```

Two mandatory details, each of which ships a bug if written the idiomatic-looking way:
- Use `getReader()`, **never** `for await` over `response.body`. `ReadableStream[Symbol.asyncIterator]`
  is Chrome 124+ / Safari 27+; `getReader()` is Safari 10.1.
- The parameter annotation is `ReadableStream<Uint8Array<ArrayBuffer>>`. Bare
  `ReadableStream<Uint8Array>` fails `pipeThrough(new TextDecoderStream())` with **TS2769** —
  reproduced today with the project's own tsc, and it breaks `eventsource-parser`'s own README
  example just as badly.

A `\r\n` torn across a chunk boundary is handled by construction: the trailing `\r` splits to an
empty tail that becomes the new `buf`, and the leading `\n` in the next chunk splits to an empty
first line, which fails the `data:` filter and is skipped.

**Interface contract:** consumed only by `streamChat` (Task 5).

**Test strategy:** Vitest, node env — `TextDecoderStream`, `ReadableStream` and
`Response.body.getReader` all exist in Node 24.15.0. Feed a synthetic `ReadableStream` emitting
exactly N bytes per chunk for N in {1, 2, 3, 7, 64, 4096}; at N=1 every multi-byte character and
every `\r\n` is torn across a boundary. Assert: the payload sequence is identical at every N;
`[DONE]` terminates; `: OPENROUTER PROCESSING` never yields; `data:` with no space and with two
spaces are both handled; a truncated final line is discarded without throwing; breaking out of the
`for await` reaches the source stream's own `cancel()` callback. Import extensionless
(`from './sse'`) — the project has no `allowImportingTsExtensions`, matching
`src/kernel/off.test.ts:2`.

---

### Task 5 — OpenRouter client and model catalogue

**Files:** `src/llm/openrouter.ts`, `src/llm/openrouter.test.ts`.

**Produces:** `streamChat`, `ChatError`, `errorMessage`, `fetchModels`, `contextLimit`,
`checkKey`, `DEFAULT_BASE_URL`, `DEFAULT_MODEL`, and the `ChatMessage`/`Usage`/`StreamEvent` types.

**Depends on:** Task 4.

Implementation notes — each is a correction to what a client written from memory would do:
- Request body: `{ model, messages, stream: true }`. **No** `provider`, **no** `usage`, **no**
  `stream_options`. Headers: `Authorization`, `Content-Type`, `HTTP-Referer`
  (`location.origin + location.pathname`), `X-OpenRouter-Title`. No `credentials` option.
- `if (!response.ok)` → `throw new ChatError(errorMessage(await response.text()), response.status,
  errorType)` **before** touching `response.body`. Verified live today: a `stream:true` request
  with a bogus key returns HTTP 401 `content-type: application/json`, body
  `{"error":{"message":"User not found.","code":401}}` — not SSE.
- Read a delta as `chunk?.choices?.[0]?.delta?.content` with a falsy guard.
  `noUncheckedIndexedAccess` forces this anyway, and OpenRouter's own doc snippet writes
  `parsed.choices[0].delta.content`, which throws on a `choices: []` chunk. Do not copy that line.
- Run the loop to `[DONE]`. Capture `if (chunk.usage) lastUsage = chunk.usage` and yield a
  `usage` event.
- A top-level `chunk.error` under HTTP 200 → throw `ChatError(message, null, metadata?.error_type)`.
  `chunk.error.code` is `integer` in the OpenAPI and the string `"server_error"` in the prose
  example — type it `number | string`, display `message` only, branch on `errorType`.
- `errorMessage(text)`: try `JSON.parse`; handle `{error:{message}}`, the ZodError envelope
  (never show the raw Zod array — parse `error.message` again and take the first `.message`), and
  fall back to the raw text.
- `fetchModels`: memoised module-level promise, lazy. Parse only `id`, `name`, `context_length`,
  `pricing`. Filter `id.endsWith(':batch')` and `id.startsWith('openrouter/')` (the latter carries
  the `-1` price sentinel that corrupts any price sort). Keep `:free`. Never write validation that
  rejects `~` or `/` in an id: alias ids legitimately begin with `~`.
- `checkKey`: `GET {baseUrl}/key`; a non-200 from a non-OpenRouter host is
  `{ok:false, message:'could not validate'}`, never a hard rejection.

**Interface contract:** exactly §3.2. `streamChat`'s signature is what `TurnDeps.stream` binds to;
the type checker enforces the match at Task 11's call site.

**Test strategy:** Vitest with a stubbed `globalThis.fetch`, installed and restored with
`compile.test.ts`'s pattern (capture `hasOwnProperty`, restore-or-delete in `afterEach`). Cases:
deltas accumulate across a synthetic SSE stream; usage is captured from a frame that repeats
`finish_reason` and sits immediately before `[DONE]`; a `choices: []` chunk yields nothing and does
not throw; `!response.ok` throws before `response.body` is read (assert the body was never
touched); an in-band `error` chunk under HTTP 200 throws a `ChatError` carrying `errorType`;
`AbortError` propagates. `errorMessage` against the three real bodies pasted **verbatim** as
fixtures (re-verified today):
`{"error":{"message":"Invalid code","code":400}}`,
`{"success":false,"error":{"name":"ZodError","message":"[\n  {\n    \"expected\": \"string\", ... }]"}}`,
and the `text/plain` string `Malformed JSON in request body`.
`fetchModels` against a trimmed checked-in slice of the real payload, plus a non-array `data`
degrading to `[]`. The live wire path is Task 12's `page.route` test.

---

### Task 6 — Settings, key storage, and OAuth PKCE

**Files:** `src/state/settings.ts`, `src/state/key.ts`, `src/llm/auth.ts`, `src/llm/auth.test.ts`.

**Produces:** the two storage modules and the whole PKCE surface.

**Depends on:** Task 5 (shares the three-shape error handling and `DEFAULT_*`).

Implementation notes:
- Two localStorage records: `aimodeller.settings` and `aimodeller.key`. Both reads try/catch-wrapped
  and falling back to a default — a corrupt blob or a browser blocking site data must not throw
  during App boot, because `e2e/smoke.spec.ts:14` asserts zero pageerrors.
- Verifier: `base64url(crypto.getRandomValues(new Uint8Array(32)).buffer)` — 43 chars, inside RFC
  7636's `[A-Za-z0-9-._~]` and its 43–128 window (re-verified today).
- Challenge: `crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))` then
  `btoa(String.fromCharCode(...new Uint8Array(hash)))` with `+`→`-`, `/`→`_`, trailing `=`
  stripped. **No `Buffer` polyfill** — the docs' own sample warns it needs a bundler, and the
  native path was verified byte-identical today.
- `authUrl`: `new URL('https://openrouter.ai/auth')` + `searchParams.set` for exactly
  `callback_url`, `code_challenge`, `code_challenge_method='S256'`. No `state`, no `client_id`, no
  `response_type`, no `scope` — none exist in the protocol.
- `startPkce`: write the verifier to **sessionStorage** (it must survive our page unloading,
  OpenRouter rendering, and our page reloading fresh; in-memory dies, localStorage lives too long),
  then `window.location.assign(url)` in the **same tab** — sessionStorage is copied-then-diverged
  into a tab opened with `window.open` or `target=_blank`.
- `completePkce`: read `?code`; delete the verifier and `history.replaceState` the URL clean
  **before** awaiting; module-level in-flight flag against StrictMode's double-invoked effect;
  `await res.text()` + try/`JSON.parse`, never a bare `res.json()`; branch on `response.ok` and the
  message text, **never** on a status code (the guide documents 403/405; the live API returns 400
  for a bad code and 404 for a wrong method — re-verified today); validate
  `typeof key === 'string' && key.startsWith('sk-or-')` before returning.
- **The `sk-or-` check applies ONLY here.** The paste-a-key path accepts any non-empty trimmed
  string, or design §9's promise that `{baseUrl, apiKey, model}` makes the OpenAI/Groq/Mistral
  compat endpoints work unchanged is broken on day one.
- Do **not** touch `POST /api/v1/auth/keys/code`. It is the only place `limit`/`expires_at` appear,
  so anyone hunting for a spend cap will find it — but it returns 404 to unauthenticated callers
  and its OpenAPI documents 401 "Missing Authentication header" and 403 "Only management keys can
  perform this operation". The app **cannot** set a spend cap; say so in the UI copy.

**Interface contract:** exactly §3.2's last two blocks. Task 11 consumes all of it.

**Test strategy:** Vitest, all pure (the node env has `crypto.subtle` and `TextEncoder`):
`challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'`
— that pair is both the RFC 7636 Appendix B test vector and OpenRouter's own OpenAPI example, a
free fixture, and I re-derived it today; base64url contains no `=`, `+` or `/`; a generated
verifier is 43 chars in the unreserved set; `authUrl` carries exactly three params and no `state`;
`exchangeErrorMessage` over the three verbatim bodies. The storage modules get no unit test — they
are localStorage IO whose only branch is the try/catch fallback, and `localStorage` is `undefined`
in the node env; Task 12 covers the round trip. **The consent round trip is MANUAL-ONLY** — it
needs a human OpenRouter login and an Authorize click. Say so in the plan; do not claim CI coverage
for the single most user-visible auth path.

---

### Task 7 — System prompt and fenced-source extraction

**Files:** `src/chat/prompt.ts`, `src/chat/fence.ts`, `src/chat/fence.test.ts`.

**Produces:** `SYSTEM_PROMPT`, `COMPACT_PROMPT`, `extractSource`, `stubFences`.

`SYSTEM_PROMPT` follows design §5's stated order — role → output contract → never claim a change
without emitting source → mm and Z-up, part sits on Z=0 → parameters first, then modules, then one
top-level call → printability (0.8 mm min wall, overhangs under 45°, 0.2–0.4 mm mating clearance,
one connected manifold solid) → manifold hygiene (overlap unions; extend subtraction cutters past
both faces — coplanar faces are the #1 cause of bad renders) → `$fn = 48` for preview, 64–96 for
threads and small holes, never above 128 → OpenSCAD's declarative-variable gotchas (last assignment
wins; you cannot accumulate in a `for`) → one worked example.

Three M2-specific additions, each earning its line:
1. **Reply with the COMPLETE source in exactly ONE fenced block** (opened with `openscad`), and put
   any explanation outside it. This is the whole output contract; §9 supersedes §5's tool-call form.
2. **Put tunable parameters at the top, above the first `{`, with Customizer annotations**
   (`wall = 2; // [1:0.5:5]`), and **set `$fn` once at top level, never as a per-call argument.**
   Not cosmetic: `-D` cannot override a `$fn=` passed to a specific call (verified against the
   vendored kernel), so the moment the model writes `cylinder(h=10, r=2, $fn=64)` the reduced-$fn
   drag preview silently stops working, with no error and no way for the user to know why.
3. **State your interpretation of any ambiguous dimension before building.** §5's bake-off found
   30/30 parts compiled first try and the real failure mode was *valid code of the wrong shape*
   from an under-specified request — this is the cheapest available mitigation, and design §13
   flags it as worth testing.

`extractSource` is line-based, not a single regex, so an opening fence and a closing fence are
never confused: opening `/^```[^\n]*$/m`, closing `/^```\s*$/m`, last block wins,
`complete === false` while the closing fence has not arrived. CRLF→LF normalisation happens here
and nowhere else.

**Interface contract:** consumed by Task 9's controller and by Task 8's `buildWindow`
(`stubFences`).

**Test strategy:** Vitest. ~15 reply shapes: prose then fence; `openscad` vs `scad` vs a bare
fence; no fence at all; two fences (the last wins); a fence containing `//` comment text with
backticks; leading/trailing whitespace; CRLF throughout. Plus **the prefix sweep**, the single
highest-value test in the milestone: for a full reply of length N, `extractSource(reply.slice(0, i))`
for **every** i must never report `complete: true` with a source that differs from the final one.
That one loop covers partial fences, every fence variant and every torn boundary. `stubFences` is
idempotent and removes every block body. One assertion that `SYSTEM_PROMPT` names the fenced-block
contract and the `$fn` rule — real prompt evaluation is manual, and pretending otherwise is theatre.

---

### Task 8 — Event log, derived send-window, commands

**Files:** `src/chat/log.ts`, `src/chat/log.test.ts`, `src/chat/commands.ts`,
`src/chat/commands.test.ts`.

**Produces:** `ChatEvent`, `buildWindow`, `parseCommand`.

**Depends on:** Tasks 2 (`stderrForModel`, used by the caller not by this module), 5
(`ChatMessage`), 7 (`stubFences`).

`buildWindow` implements §3.3's four numbered rules exactly. Two implementation constraints:
- Every backwards scan is a plain reverse `for` loop. `Array.prototype.findLastIndex` **does not
  exist** under this project's `lib: ES2022` — verified today, TS2550, with the project's own tsc.
  This is exactly the invented-API class Milestone 1 shipped three of.
- The summary clamp `start = Math.max(start, clearIndex + 1)` is not optional: without it a
  `/compact` whose `coversThrough` predates a `/clear` replays history the user explicitly
  discarded.

`parseCommand` returns `{name:'unknown', word}` for an unrecognised slash word rather than sending
it to the model. `/undo` is deliberately absent (M3).

**Interface contract:** exactly §3.3's first two blocks. Task 9 is `buildWindow`'s only caller.

**Test strategy:** Vitest, entirely pure. `buildWindow`: an empty log yields `[system, source]`; a
`clear` cuts everything before it; a `summary` replays from `coversThrough + 1` and is clamped past
a preceding `clear`; the **current turn's** assistant message is verbatim while every earlier
turn's fenced block is stubbed; the tail source message is present at attempt 0 and **absent** once
a current-turn assistant message exists; compile events from earlier turns are dropped and the
current turn's failed compile appears as a user message **byte-identical** to its `stderr`; a
3-turn log with one failure per turn yields exactly one stderr message; `note` events never appear;
the source text appears at most once in the output. `parseCommand`: each command with and without
an argument, `/export` defaulting to `3mf` and accepting `stl`, an unknown slash word, and an
ordinary message that merely contains a slash.

---

### Task 9 — The deterministic controller

**Files:** `src/chat/controller.ts`, `src/chat/controller.test.ts`.

**Produces:** `runTurn`, `runCompact`, `MAX_RETRIES`, `DRAFT_INTERVAL_MS`, `COMPACT_AT`,
`TurnOutcome`, `TurnDeps`, `CompactOutcome`.

**Depends on:** Tasks 2, 5, 7, 8.

This is where the milestone's correctness lives. Implement §4.1 verbatim — the ordering of PHASE
3's checks is load-bearing, and so is the fact that a `cancelled`/`timedOut`/`crashed` result is
tested **before** the log append (otherwise the literal strings `Compile cancelled.` and
`Compile timed out after 60s.` enter the log, and `buildWindow` replays them to the model as
compile diagnostics it will try to repair).

`runTurn` is a plain async function, not a class: a store with a snapshot and an observer is M3's
problem, and a function with injected fakes is at least as testable. It has no React import, no
`fetch`, and only an `import type` from the kernel.

**Interface contract:** exactly §3.3's controller block. Task 11's `Chat.tsx` is the only caller.

**Test strategy:** Vitest with a scripted async-generator stream, a scripted compiler, and an
injected clock — no network, no kernel, no jsdom. One case per invariant in §4.3, plus:
success on attempt 0; fail → retry → success, with the retry's window carrying the verbatim stderr
and **no** re-attached source; three failures then `{status:'failed'}` with exactly 3 stream and 3
compile calls; a prose-only reply returns `{status:'answered'}` and compiles nothing; a reply
echoing the input source returns `answered` without compiling; `finish_reason: 'length'` never
reaches compile; an unclosed fence with `finish_reason: 'stop'` never reaches compile; a
`ChatError` mid-stream returns `{status:'error'}` and appends the partial as `stopped:true`;
`AbortError` returns `{status:'stopped'}`; a `{ok:false, cancelled:true}` compile returns `stopped`,
appends **no** compile event and spends **no** attempt; a `{ok:false, timedOut:true}` compile
returns `failed` immediately with attempt still 0; a `{ok:false, crashed:true}` or empty-`stderrRaw`
result does the same; N deltas inside one `DRAFT_INTERVAL_MS` window produce one `onDraft` call
plus the final unconditional one; a port throwing a synchronous `TypeError` returns
`{status:'error'}` rather than rejecting. `runCompact`: returns `nothing-to-compact` and makes zero
stream calls when fewer than 2 completed turns exist; on success appends a `summary` whose
`coversThrough` is the last event of turn `n-2`; on abort returns `stopped`.

---

### Task 10 — Customizer scanner and substitution

**Files:** `src/editor/params.ts`, `src/editor/params.test.ts`.

**Produces:** `scanParams`, `setParam`, `formatLiteral`, `defineFor`, `DRAG_FN`.

**Depends on:** nothing (fully parallel with Tasks 4–9).

Implement §3.4's documented rules. The scanner is **one pass** returning byte offsets of the value
literal, because the offsets are what make substitution safe: the annotation comment lives after
the `;` and is untouched by construction, and a name inside a string, a comment or a module default
is unreachable because the scanner never leaves top-level statement context.

Controls: number → slider (from `// [min:max]`, `// [min:step:max]`, `// [max]`, or a bare number
as the step), bool → checkbox (annotation ignored), number/string + a bracket list of 2 or more →
dropdown (bare, quoted, or `value:Label`; if the current value is not among the options it is
prepended as option 0). Vector and string-with-maxLength are recognised and dropped in M2.

**Interface contract:** `Params.tsx` and App's drag path (Task 11) are the only consumers.

**Test strategy:** Vitest, table-driven. Expected values come from the vendored kernel's own
`--export-format=param` output — OpenSCAD's own customizer parse, an exact oracle. Non-negotiable
cases, several of which falsify the folk rule:
- `a=1; module m(){}` then `b=2;` collects **nothing** (the brace is on line 1).
- `a=1;` / `cube(1);` / `b=2;` collects **both** — it is NOT "before the first module
  instantiation"; `for`, `if`, `let`, `echo`, a function definition and `use <>` also fail to stop
  collection.
- `a=1;` / `s="{"; // 5` / `b=2;` collects only `a` — a `{` inside a string still stops it.
- `a=1; // [0:10]` then `a=5; // [0:99]` → one param, value 5, min 0 max 99 (last assignment wins,
  carrying its own annotation).
- `a=1; // [0:10]` / `module m(){}` / `a=5;` → **no** param (the winning assignment is past the
  cut-off).
- `a=99; // [0:10]` → min 0, max 99 (the value widens the range).
- `/* [Hidden] */` and `/* [ Hidden ] */` both suppress; `/* [Lid] [Inner] */` → group `Lid-Inner`;
  a same-line header does not apply to that line's assignment; a multi-line `/* [Box]` + `*/` is
  ignored.
- An indented `  // caption` is not a caption; `x = 9; // [0:10]` above `a=1;` is not a caption
  for `a`.
- `a=1; b=2; // [0:10]` → neither gets the range (annotation scanning aborts at the second `;`).
- `// [0:10] description` and `// [0:10];` both degrade to a plain number with no range.
- CRLF input destroys every annotation — assert it, and assert the app normalises on ingest.
- `$fn = 32; // [16,32,64,128]` is scanned by OpenSCAD but **excluded** from our list.
- `setParam` preserves the trailing annotation comment byte-for-byte, and returns the input
  **unchanged** when the re-scan does not confirm the write.
- `defineFor('wall', 2.5) === 'wall=2.5'`; `defineFor('a; cube(1)', 1)` **throws**.

The `--export-format=param` fixtures generator is deliberately **not** built in M2: the ~18
expected values are already known and the kernel is vendored and pinned. Record it in the plan as
the named upgrade to run on the first kernel bump, so the oracle is not forgotten.

---

### Task 11 — Chat pane, params strip, and App wiring

**Files:** `src/chat/Chat.tsx`, `src/editor/Params.tsx`, `src/App.tsx`, `src/index.css`.

**Depends on:** Tasks 3, 5, 6, 9, 10.

This is where the tested pure core meets React. The App changes, precisely:

- Third grid column: `.app { grid-template-columns: minmax(320px, 40%) 1fr minmax(320px, 28%) }`
  plus one more `<section className="pane">`. `.pane + .pane` supplies the divider and
  `.pane { min-width: 0 }` already prevents grid blowout — both already in `index.css:6-7`.
- New state: `streamSource: string | null`, `previewDefines: readonly string[]`,
  `chatBusy: boolean`, and `appliedKeyRef`.
- `Editor value={streamSource ?? source} editable={!chatBusy} onChange={setSource}`.
- One `applyCompiled(key, result)` writing `appliedKeyRef.current`, `busy`, `mesh`, `ms` and
  `error` together, called from both the debounce effect and the turn commit.
- The debounce effect's **first** statement is the key guard (see §3.5); its delay is
  `previewDefines.length > 0 ? DRAG_DEBOUNCE_MS : DEBOUNCE_MS`. The existing `runIdRef` supersede
  guard and the `cancelled` early-return are unchanged.
- A **second** `Compiler` for the turn, passed to `Chat` — never the preview's, because
  `compile()` calls `cancel()` as its first statement (`compile.ts:30`) and a stray preview would
  silently settle a paid-for turn as cancelled.
- A **fourth** error channel `chatError`, deliberately **not** folded into `shownError`. Writing a
  chat failure into `error` would mark the whole HUD stale and disable both export buttons for a
  network problem that says nothing about the geometry — exactly the misattribution commits
  fbb9687 / fe079e1 exist to prevent.

`Chat.tsx` owns `log`, `turn`, the busy ref, the `AbortController` ref, the key/settings/models
state, and the command dispatch. Stop calls `ac.abort()` **and** `turnCompiler.cancel()`. On every
exit path it calls `onStreamSource(null)` in a `finally`; on `committed` and `failed` it calls
`onApply(source, result)` **first**, so the document and the mesh land together. Stop's documented
behaviour is: **the partial is discarded and the pre-turn document returns** — because
`value={streamSource ?? source}` plus `onStreamSource(null)` is what the wiring actually does, and
shipping a sentence promising an editable draft while the code restores the original is worse than
the honest rule. While streaming has produced no content yet (the default model has mandatory
reasoning), the transcript shows a "thinking…" state so the UI is never silently frozen.

`Params.tsx`: `onPreview([defineFor(name, v), defineFor('$fn', DRAG_FN)])` while dragging;
`onCommit(setParam(...))` plus `onPreview([])` on pointer-up/key-up. The `$fn` override is skipped
when the dragged parameter is itself a `$` variable (they are excluded from the panel anyway, so
this is a one-line assertion rather than a branch). `disabled={chatBusy}`.

CSS: own class names — `.chat`, `.chat-log`, `.msg`, `.chat-note`, `.chat-form`, `.chat-error`,
`.params`, `.param`. **Never** reuse `.error` or `.tag`, and never render the text `mm` inside a
`.tag`: duplicating either class breaks all three existing e2e tests with a Playwright strict-mode
violation (`locator('.error') resolved to 2 elements`), affecting `toBeVisible`, `toBeHidden` and
`locator('.tag', {hasText:'mm'})` alike.

**Test strategy:** no component tests (see Task 3). The gate for this task is that the existing
three e2e tests still pass — which specifically catches a class collision and any boot-time throw
when no key is configured (`smoke.spec.ts:14` asserts `expect(errors).toEqual([])`). Full coverage
lands in Task 12.

---

### Task 12 — CSP, e2e suite, README, CI gate

**Files:** `vite.config.ts`, `index.html` (a placeholder comment only), `e2e/chat.spec.ts`,
`README.md`.

**Depends on:** everything.

**CSP.** Injected **build-only**, from a ~12-line plugin — `HtmlTagDescriptor` and
`injectTo: 'head-prepend'` are both present in the installed Vite 8.2.2 (verified):

```ts
{
  name: 'csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{
    tag: 'meta',
    attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
    injectTo: 'head-prepend',
  }],
}
```

A static meta tag in `index.html` would apply in `pnpm dev` too, where `@vitejs/plugin-react`
injects an inline react-refresh preamble (verified: `preambleCode` appears 5 times in the installed
plugin's dist) and the HMR client opens a websocket — the dev server would serve a blank page, and
`pnpm e2e`, which runs against `pnpm build && pnpm preview`, would never catch it.

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'self' https://openrouter.ai;
worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; form-action 'none'
```

`'wasm-unsafe-eval'` is **mandatory** — without it Chromium refuses `WebAssembly.compile` with
"unsafe-eval is not an allowed source of script" and the kernel dies on first compile. Full
`'unsafe-eval'` is **not** needed: the vendored glue has zero `eval(` and zero `new Function`.
`style-src 'unsafe-inline'` is required because CodeMirror injects its stylesheet at runtime.

**`e2e/chat.spec.ts`** — one spec file, matching the repo's existing one-file convention. Setup:
`page.addInitScript` seeds `aimodeller.key` in localStorage (verified working);
`page.route('https://openrouter.ai/api/v1/chat/completions', route => route.fulfill({status:200,
contentType:'text/event-stream', body: <SSE string>}))` intercepts the cross-origin POST (verified
working), and `route.request().postDataJSON()` exposes the body for assertions. `route.fulfill`
delivers its body as **one chunk** — reach for an `addInitScript` fetch patch only if a test needs
genuinely progressive streaming.

Tests:
1. **A stubbed turn commits and compiles exactly once.** The streamed source reaches the editor,
   the editor is not editable during the turn and is editable after, the HUD reports the new
   model's dimensions — and, critically, a `data-compiles` attribute incremented on every settled
   compile reads exactly `1` across the turn. This is the only assertion that catches either the
   Editor feedback loop (Task 3) or an `appliedKeyRef` regression, both of which are otherwise
   silent.
2. **Retry loop.** A route counter returns a broken source, then a good one. Assert exactly two
   requests, that the second request body contains the verbatim stderr, that it does **not**
   contain a second copy of the source, and that the transcript shows the raw stderr.
3. **Stop mid-stream** restores the pre-turn document and leaves the editor editable.
4. **Undo after a committed turn.** `ControlOrMeta+z` in the editor restores the previous source —
   this is the assertion that validates §7 R7's decision to commit on final failure.
5. **`/clear`** empties the send-window without changing the source.
6. **A 401** (stub a JSON error body) surfaces the key prompt and does **not** mark the HUD stale
   or disable the export buttons.
7. **Slider drag.** During the drag the triangle count drops **while the pointer is still down**
   and the editor text does **not** change; on release the source shows the new literal with its
   annotation comment intact and the triangle count recovers. This is also the only proof that
   `-D` works through a browser worker rather than only under Node.
8. **PKCE, both halves that can run without an account.** `startPkce` navigates to an
   `openrouter.ai/auth` URL carrying all three params and no `state` (assert, then abort via route
   interception). A synthetic `?code=xxx` with a seeded sessionStorage verifier hits the real
   exchange endpoint, gets a 400, shows the error, and leaves the URL clean. `?code=xxx` with no
   verifier errors **without** firing a request.
9. **CSP.** The built page carries the meta, the kernel still compiles under it, and no
   `securitypolicyviolation` event fires. If `worker-src` or `style-src` turns out to break the
   `?url` wasm fetch or CodeMirror, narrow the policy and record what was dropped and why — but
   **the task is not droppable**: §9 calls this the only cheap structural defense for the key, and
   M2 is when the key first exists.

Reuse the house timeouts (90_000 for the first compile, 60_000 for a recompile, suite 120_000) and
keep the `page.on('pageerror')` zero-uncaught-errors assertion green.

**README:** one paragraph — the key is stored in this browser's `localStorage` under
`aimodeller.key`, it never goes anywhere but the model host, and it is revocable at
`https://openrouter.ai/settings/keys` (link the stable path, not its redirect target
`/workspaces/default/keys`), with a per-key deep link shown in the settings panel. The app
**cannot** set a spend cap on it — that is a manual step in OpenRouter's settings. Plus one honest
sentence near Stop: aborting stops billing on OpenAI, Anthropic, DeepSeek and xAI, but not on
Google, Groq or Mistral.

---

## 6. The dependency decision

**Hand-roll the SSE reader. Do not add `eventsource-parser`.**

**The deciding reason, in one sentence:** the only genuinely hard trap — multi-byte UTF-8 torn
across chunk boundaries — is solved by the native `TextDecoderStream` that *both* options must
call anyway, because `eventsource-parser` consumes **strings**, not bytes; that leaves the library
selling ~8 lines of line-splitting, in the one module that handles the user's API key, where
design §9's own key-handling paragraph already argues for "keeping dependencies few".

Supporting facts, so no reviewer re-opens this on the wrong grounds:
- **Do not argue bundle size.** `eventsource-parser@4.1.0` is 1,740 B gzip with zero dependencies.
  That argument is false and a reviewer will catch it.
- The 20-line hand-rolled version was measured byte-identical to the library across 9
  OpenRouter-shaped fixtures × 4 chunk sizes, with exactly two divergences, both from being
  line-oriented rather than event-oriented: a multi-line `data:` field, and events with no
  blank-line separator (where the library correctly yields nothing and we leniently yield the
  payloads).
- Only the multi-line `data:` gap is a real spec shortfall, and it is unreachable here: a single
  JSON object cannot contain a raw newline because `JSON.stringify` escapes them, so a server would
  have to deliberately pretty-print across lines.
- **Named upgrade path, taken only if a non-OpenRouter `baseUrl` is ever observed emitting a
  multi-line `data:` field:** a 25-line event-oriented variant that buffers `data:` lines and
  dispatches on the blank line, proven byte-identical to the library on all 9 fixtures × 4 chunk
  sizes. Do **not** ship it pre-emptively — that is the speculative-abstraction trap.
- Native `EventSource` is disqualified, not merely inconvenient: it issues a GET and its only
  constructor option is `withCredentials` — no method, no body, no `Authorization` header.
- There is no native line-splitting stream on the web platform (no `TextLineStream` in
  browser-compat-data), so the ~8 lines of buffer-and-split are irreducible either way.

**No other new dependency.** Not `zustand` (design §4's mandate — plain React state is enough for
M2 and a store is M3's problem), not `idb-keyval` (M3), not `jsdom` / `@testing-library` (design
§11 says skip component tests at MVP, and vitest's `include` is `src/**/*.test.ts` so a `.tsx` test
would not even be collected), not a tokenizer (usage counts come from the API, exact, from the
model's native tokenizer).

---

## 7. Open risks and the decision taken

| # | Risk | Decision |
|---|---|---|
| R1 | **The Editor feedback loop.** `Editor.tsx:62-68` dispatches and `Editor.tsx:45-46` calls `onChange` on that dispatch. Unexercised in M1, primary path in M2. Falsifies every "one compile per turn" claim. | **Fixed structurally** in Task 3 with an `Annotation` on external transactions plus a `some(tr => tr.annotation(External))` guard in the updateListener — the exact shape was type-checked clean today. Backed by Task 12 test 1's compile counter, the only test that would catch a regression. |
| R2 | **`stderrRaw` is synthetic on three of five settle paths** (`Compile timed out after 60s.`, `Compile cancelled.`, and `event.message ?? ''`, frequently empty). Feeding any of them to the model burns the repair budget against a fabrication. | **Fixed** with `cancelled`/`timedOut`/`crashed` discriminators (Task 2) and PHASE 3's ordering (§4.1): all three are tested **before** the log append, none spends an attempt, and a timeout or crash is surfaced immediately. |
| R3 | **The documented error codes are wrong.** The guide says 403 for a bad code and 405 for a wrong method; the live API returns **400** and **404** (re-verified today). | Branch on `response.ok` and the message text, **never** on an exact status code. Stated in Task 6, asserted in `auth.test.ts`. |
| R4 | **Three structurally incompatible error bodies**, one of them `text/plain`, so an unguarded `response.json()` throws. | Always `await res.text()` + try/`JSON.parse`. All three pasted verbatim as test fixtures (re-verified today). |
| R5 | **The full PKCE happy path cannot run in CI** — it needs a human OpenRouter login and an Authorize click. | Marked **MANUAL-ONLY** in the plan. Both halves either side of the consent screen are covered in Task 12 test 8. Do not claim CI coverage. |
| R6 | **The deny/cancel redirect contract is undocumented.** No `?error=access_denied` appears in the guide or the OpenAPI. | Defensive: no `?code` means do nothing; if an `?error` param does appear, surface it. |
| R7 | **After 2 failed repairs the controller commits the model's still-broken source** over the user's document. Recovery leans on CodeMirror's `history()` making the external full-document replace revertible with Ctrl/Cmd+Z — standard behaviour, but not verified in a browser. | Commit anyway (the user must see the code to fix it, and the error is already on screen), **and add Task 12 test 4** asserting undo restores the previous source. If that assertion fails, flip the decision to "do not commit on final failure" and amend this contract under the `docs: plan's <X>` convention. |
| R8 | **`chunk.error.code` type discrepancy**: `integer` in the OpenAPI, the string `"server_error"` in the prose example. | Type it `number \| string`, display `message` only, branch on `error.metadata.error_type`. Not resolvable without provoking a live mid-stream failure. |
| R9 | **No live authenticated stream was ever observed** (no API key in this environment). Chunk *schemas* come from the published OpenAPI; the chunk *sequence* — that `: OPENROUTER PROCESSING` frames appear, that the usage frame lands immediately before `[DONE]`, that `finish_reason` is duplicated on it — is documented, not measured. | The client survives any of the three being wrong: comments can never reach `JSON.parse`, the loop runs to `[DONE]` regardless, and a missing usage frame only disables auto-compact (already guarded by `limit > 0`). Task 12's `page.route` stub exercises the shape we believe. |
| R10 | **`-D` was verified under Node, not in a browser Worker.** The binaries are identical; the code path is not. | Task 12 test 7 is the assertion that closes it. If it fails, the drag preview degrades to "recompile the substituted source at reduced `$fn`" — one line, same UX, slower. |
| R11 | **The default model `google/gemini-3.7-flash` has mandatory reasoning** with no `'none'` effort, so real cost exceeds the sticker input price and the first visible token may lag. | Keep it (coding index 76.1, 1M context, $0.75/$3.75 per M, and it already accepts images so M4 needs no default swap). Reasoning deltas are **ignored**, not modelled — a `reasoning` StreamEvent variant on an UNVERIFIED field name buys a dimmed status line and nothing else. The lag is covered by a "thinking…" state while streaming has produced no content. The id is one named constant. |
| R12 | **`worker-src` and `style-src` under a real CSP are unverified** — only `script-src`'s `'wasm-unsafe-eval'` requirement was reproduced in Chromium. | Task 12 test 9 gates it. Narrow the policy and record what was dropped if it breaks; the task is **not** droppable. |
| R13 | **The chat log dies on reload.** | Deliberate. Persistence is M3's IndexedDB store; six lines of localStorage now creates a migration surface M3 would immediately unwind. `id`/`ts`/`turn` are on `ChatEvent` from day one so the log's shape does not change when M3 persists it. |
| R14 | **Customizer coverage is number/bool/enum only.** `size = [10,20];` and `s = "abc"; //8` show no control. | Accepted. Enum stays in: the scanner already parses the bracket list, and the system prompt asks the model to emit annotated parameters — a silently missing control on a parameter we asked for is worse than ten lines of `<select>`. Vector and text are M3. |
| R15 | **The editor is read-only for the whole turn** — potentially 30+ s with a slow model and a 13 s compile. | Accepted, and it is the deliberate price of making "user edits mid-turn" unreachable instead of a merge UI. The doc stays selectable and copyable, Stop is always live, and M3 can relax it to a dirty-flag + Apply flow once the version timeline makes clobbering recoverable — relaxing is removing a prop. |
| R16 | **Auto-compact at 60% spends the user's money on a call they did not ask for.** | Design §10's decision. It is announced in the transcript, and it is hard-guarded against a zero divisor (`limit > 0`) — without that guard the ratio is `Infinity` and it would fire after **every** turn until `/models` resolves, and forever for any unknown id or custom baseUrl. |
| R17 | **`streamSource` writes a whole-document CodeMirror transaction up to 10×/s**, clobbering selection each time. | Accepted at `DRAFT_INTERVAL_MS = 100` with one unconditional final push, plus `scrollIntoView` so the tail stays visible. A real incremental-insert path is not worth it while the editor is read-only anyway. |
| R18 | **A slider release recompiles at the 600 ms source debounce**, not instantly. | Accepted: the reduced-`$fn` preview is already on screen, so the wait is not blank. The drag itself uses `DRAG_DEBOUNCE_MS = 30`; a 600 ms slider preview is not a preview. |
| R19 | **Two live `Compiler` instances during a turn** means two kernel heaps can coexist (the wasm module itself is browser-cached after the first fetch). | Accepted. The UI prevents the overlap in practice; the second instance exists purely so a stray preview cannot silently kill a paid-for turn — a failure with no user-visible message. |
| R20 | **The catalogue moves.** 396 models, and every id here is correct as of 2026-08-30; the endpoint is served `max-age=300`. | `DEFAULT_MODEL` is one named constant. Never write validation that rejects `~` or `/` in a model id — alias ids legitimately begin with `~` and every id contains a `/`. |
| R21 | **`:batch` variants are filtered by id suffix, and nothing in the API says they cannot stream.** | The filter is a safe heuristic either way (they are async duplicates at ~50% price with `temperature` dropped). Do not write a plan sentence asserting the API tells you this. |

---

## 8. Verification transcript (2026-08-30)

Re-executed today against this repo and the live API, so nothing above rests on a proposal's
description of it:

```
$ npx tsc --noEmit -p tsconfig.json          # probe: findLastIndex
src/__tc.ts(3,20): error TS2550: Property 'findLastIndex' does not exist on type 'number[]'.
                   Try changing the 'lib' compiler option to 'es2023' or later.

$ npx tsc --noEmit -p tsconfig.json          # probe: pipeThrough annotations
src/__tc2.ts(2,34): error TS2769: No overload matches this call.
  ... Type 'BufferSource' is not assignable to type 'Uint8Array<ArrayBufferLike>'
# ReadableStream<Uint8Array<ArrayBuffer>> compiles clean, and Response.body assigns to it clean.

$ npx tsc --noEmit -p tsconfig.json          # probe: Annotation + Compartment + updateListener
(no output — the Task 3 fix type-checks clean)

$ grep -n "class Annotation\|declare class Compartment" node_modules/@codemirror/state/dist/index.d.ts
759:declare class Annotation<T> {          732:declare class Compartment {
$ grep -n "static editable" node_modules/@codemirror/view/dist/index.d.ts
1284:    static editable: Facet<boolean, boolean>;
$ grep -n "injectTo" node_modules/vite/dist/node/index.d.ts
2808:  injectTo?: "head" | "body" | "head-prepend" | "body-prepend";
$ grep -c preambleCode node_modules/@vitejs/plugin-react/dist/index.js
5      # confirms the dev-only inline script that a static CSP meta would block

$ curl -s -o /dev/null -w '%{http_code} %{size_download}' https://openrouter.ai/api/v1/models
200 655442   # 396 models; gemini-3.7-flash ctx 1048576, pricing "0.00000075" / "0.00000375"

$ curl -sX POST .../api/v1/auth/keys -d '{"code":"deadbeef-not-real",...}'
400 {"error":{"message":"Invalid code","code":400}}
$ curl -sX POST .../api/v1/auth/keys -d 'notjson'
400 Malformed JSON in request body                      # text/plain
$ curl -sX POST .../api/v1/auth/keys -d '{}'
400 {"success":false,"error":{"name":"ZodError","message":"[\n  {...}]"}}

$ curl -sX POST .../chat/completions -H 'Authorization: Bearer sk-or-v1-bogus' \
       -d '{"model":"x","messages":[...],"stream":true}' -D -
HTTP/2 401 · content-type: application/json · access-control-allow-origin: *
{"error":{"message":"User not found.","code":401}}      # a stream:true failure is JSON, not SSE

$ node -e '<base64url(SHA-256(verifier))>'
challenge E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM true    # RFC 7636 Appendix B
verifier len 43 true                                          # RFC 7636 charset
```

Existing-code signatures in §3.1 were copied from `src/kernel/compile.ts:8-10,25-29,47-50,69-77`,
`src/kernel/protocol.ts:1-10`, `src/kernel/noise.ts:13`, `src/editor/Editor.tsx:13-19,45-46,62-68`,
`src/App.tsx:26,41-75,84-99,102,112-118` and `src/index.css:5-7`.
