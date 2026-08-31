import { sseData } from './sse'

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
/** One named constant: the catalogue moves and this is the only line to change. */
export const DEFAULT_MODEL = 'google/gemini-3.7-flash'

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

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  /**
   * Chain-of-thought, where the model emits it. Shown live and then dropped:
   * it is never appended to the log and so never crosses the wire again.
   */
  | { type: 'reasoning'; text: string }
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

export type Effort = 'low' | 'medium' | 'high'

export interface ChatOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  /**
   * OpenRouter's unified reasoning knob, `reasoning: { effort }`. Absent keeps
   * the body byte-identical to a plain request; a model without reasoning
   * ignores it (the docs say so; nothing here requires the parameter).
   */
  readonly reasoning?: Effort
}

/** JSON.parse that answers null instead of throwing. Every body here is untrusted. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * One streamed chunk. Every field is optional because this is network JSON that
 * nothing validates. `error.code` is `integer` in the OpenAPI and the string
 * `"server_error"` in the prose example, which is why nothing displays it — the
 * branchable vocabulary is `metadata.error_type`.
 */
interface ChatChunk {
  choices?: {
    delta?: {
      content?: string
      /** Non-streaming shape, but some providers put it on the delta too. */
      reasoning?: string
      reasoning_details?: { text?: string }[]
    }
    finish_reason?: string | null
  }[]
  usage?: Usage
  error?: { message?: string; code?: number | string; metadata?: { error_type?: string } }
}

/**
 * One `data:` payload → the events it carries.
 *
 * `choices?.[0]` is guarded because the API really sends `choices: []` frames,
 * and OpenRouter's own doc snippet (`parsed.choices[0].delta.content`) throws on
 * them.
 */
function readChunk(payload: string): StreamEvent[] {
  // The one untrusted body that used to bypass parseJson: a non-JSON data:
  // frame escaped as a bare SyntaxError rather than a ChatError.
  const chunk = parseJson(payload) as ChatChunk | null
  if (!chunk) return []
  if (chunk.error) {
    throw new ChatError(
      chunk.error.message ?? 'The model host reported an error.',
      null,
      chunk.error.metadata?.error_type ?? null,
    )
  }

  const events: StreamEvent[] = []
  const choice = chunk.choices?.[0]
  if (choice?.delta?.content) events.push({ type: 'delta', text: choice.delta.content })
  // Streaming carries reasoning as `reasoning_details[]`; the bare `reasoning`
  // string is the non-streaming shape, but several providers send it on the
  // delta anyway. Read both — an absent field just yields nothing.
  const reasoning = [
    typeof choice?.delta?.reasoning === 'string' ? choice.delta.reasoning : '',
    ...(choice?.delta?.reasoning_details ?? []).map((part) =>
      typeof part?.text === 'string' ? part.text : '',
    ),
  ].join('')
  if (reasoning) events.push({ type: 'reasoning', text: reasoning })
  if (chunk.usage) events.push({ type: 'usage', usage: chunk.usage })
  if (choice?.finish_reason) events.push({ type: 'finish', reason: choice.finish_reason })
  return events
}

/**
 * POST {baseUrl}/chat/completions.
 *
 * The body is `{ model, messages, stream: true }` plus `reasoning` when the user
 * asked for thinking, and nothing else. No
 * `provider: {require_parameters}` — it filters on request-body parameters we
 * do not send and can only produce a 503. No `usage: {include:true}` and no
 * `stream_options` — both are documented no-ops, and usage arrives on the
 * accounting frame regardless. No `credentials` — the wildcard ACAO carries no
 * allow-credentials header, so `'include'` would fail CORS.
 *
 * Runs to `[DONE]` rather than stopping at the first non-null finish_reason:
 * that accounting frame repeats finish_reason, and /compact's trigger needs the
 * usage it carries.
 *
 * An AbortError is left to propagate — the caller is the one that aborted.
 */
export async function* streamChat(
  messages: readonly ChatMessage[],
  signal: AbortSignal,
  options: ChatOptions,
): AsyncGenerator<StreamEvent, void, undefined> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': location.origin + location.pathname,
      'X-OpenRouter-Title': 'Vibe3D',
    },
    body: JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      ...(options.reasoning ? { reasoning: { effort: options.reasoning } } : {}),
    }),
  })

  // Checked before response.body is touched: a stream:true request that fails
  // before the stream opens answers with application/json, not SSE, so handing
  // the body to the SSE reader would throw away the only message there is.
  if (!response.ok) {
    const body = await response.text()
    throw new ChatError(errorMessage(body), response.status, errorTypeOf(body))
  }
  if (!response.body) {
    throw new ChatError('The model host sent no response body.', response.status, null)
  }

  for await (const payload of sseData(response.body)) yield* readChunk(payload)
}

/**
 * Normalises the three structurally incompatible error bodies this API emits.
 * Always call it on `await res.text()`, never on a bare `res.json()`: one of the
 * three is `text/plain` and would throw.
 */
export function errorMessage(bodyText: string): string {
  const fallback = bodyText.trim() || 'The request failed with no message.'
  const body = parseJson(bodyText) as { error?: { name?: string; message?: string } } | null
  const message = body?.error?.message
  if (typeof message !== 'string') return fallback
  if (body?.error?.name !== 'ZodError') return message

  // The ZodError envelope hides a JSON array of issues inside `message`. The raw
  // array is unreadable to a user; the first issue's own message is the line.
  const first = (parseJson(message) as { message?: string }[] | null)?.[0]
  return first?.message ?? 'The request was rejected as invalid.'
}

function errorTypeOf(bodyText: string): string | null {
  const body = parseJson(bodyText) as { error?: { metadata?: { error_type?: string } } } | null
  return body?.error?.metadata?.error_type ?? null
}

export interface ModelInfo {
  id: string
  name: string
  /**
   * The TOP-LEVEL field, not top_provider.context_length: that one is null on a
   * handful of models and lower than the truth on dozens more.
   */
  context_length: number
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

/**
 * Keyed by baseUrl, lazily. No cache layer beyond this: the endpoint is served
 * `max-age=300, stale-while-revalidate=3600` and gzips to ~71 KB, so the
 * browser's own HTTP cache is the cache.
 */
const catalogue = new Map<string, Promise<readonly ModelInfo[]>>()

export function fetchModels(baseUrl: string): Promise<readonly ModelInfo[]> {
  let pending = catalogue.get(baseUrl)
  if (!pending) {
    // A failure is not memoised: one blip would otherwise leave the model list
    // empty until the page is reloaded.
    pending = loadModels(baseUrl).catch(() => {
      catalogue.delete(baseUrl)
      return []
    })
    catalogue.set(baseUrl, pending)
  }
  return pending
}

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

/** 0 when the id is unknown. Callers MUST guard `> 0` before dividing. */
export function contextLimit(models: readonly ModelInfo[], id: string): number {
  return models.find((model) => model.id === id)?.context_length ?? 0
}
