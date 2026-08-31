import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  ChatError,
  contextLimit,
  errorMessage,
  fetchModels,
  streamChat,
  type ChatMessage,
  type ChatOptions,
  type ModelInfo,
  type StreamEvent,
} from './openrouter'

// Install the stubs only for this file's tests and restore whatever (if
// anything) was there before, so they cannot leak into other test files.
// `location` has no own property in vitest's node environment at all.
const globals = globalThis as { fetch?: unknown; location?: unknown }
const hadOwnFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch')
const originalFetch = globals.fetch
const hadOwnLocation = Object.prototype.hasOwnProperty.call(globalThis, 'location')
const originalLocation = globals.location

let calls: { url: string; init: RequestInit | undefined }[] = []

function stubFetch(handler: (url: string, init: RequestInit | undefined) => unknown): void {
  globals.fetch = async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return handler(String(input), init)
  }
}

beforeEach(() => {
  calls = []
  globals.location = { origin: 'https://app.example', pathname: '/modeller/' }
})

afterEach(() => {
  if (hadOwnFetch) globals.fetch = originalFetch
  else delete globals.fetch
  if (hadOwnLocation) globals.location = originalLocation
  else delete globals.location
})

const OPTIONS: ChatOptions = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-v1-test',
  model: 'google/gemini-3.7-flash',
}

const MESSAGES: readonly ChatMessage[] = [
  { role: 'system', content: 'You write OpenSCAD.' },
  { role: 'user', content: 'a cube' },
]

/**
 * Real chunk shapes. The fourth frame carries `choices: []`, which the API's
 * own documented snippet (`parsed.choices[0].delta.content`) throws on, and the
 * last frame is the accounting one: it REPEATS finish_reason and carries usage,
 * so a reader that stopped at the first non-null finish_reason never sees it.
 */
const STREAM = [
  ': OPENROUTER PROCESSING',
  '',
  'data: {"id":"gen-1","provider":"Google","model":"google/gemini-3.7-flash","object":"chat.completion.chunk","created":1756512000,"choices":[{"index":0,"delta":{"role":"assistant","content":"cube("},"finish_reason":null,"native_finish_reason":null,"logprobs":null}]}',
  '',
  'data: {"id":"gen-1","object":"chat.completion.chunk","created":1756512000,"choices":[{"index":0,"delta":{"content":"10);"},"finish_reason":null}]}',
  '',
  'data: {"id":"gen-1","object":"chat.completion.chunk","created":1756512000,"choices":[]}',
  '',
  'data: {"id":"gen-1","object":"chat.completion.chunk","created":1756512000,"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop","native_finish_reason":"STOP"}]}',
  '',
  'data: {"id":"gen-1","object":"chat.completion.chunk","created":1756512000,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":412,"completion_tokens":37,"total_tokens":449}}',
  '',
  'data: [DONE]',
  '',
].join('\n')

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

const signal = (): AbortSignal => new AbortController().signal

test('yields deltas in order, skips a choices-less frame, and reads on to the usage frame', async () => {
  stubFetch(() => new Response(STREAM, { status: 200 }))

  expect(await drain(streamChat(MESSAGES, signal(), OPTIONS))).toEqual([
    { type: 'delta', text: 'cube(' },
    { type: 'delta', text: '10);' },
    { type: 'finish', reason: 'stop' },
    { type: 'usage', usage: { prompt_tokens: 412, completion_tokens: 37, total_tokens: 449 } },
    { type: 'finish', reason: 'stop' },
  ])
})

test('sends exactly the documented request', async () => {
  stubFetch(() => new Response(STREAM, { status: 200 }))
  await drain(streamChat(MESSAGES, signal(), OPTIONS))

  const init = calls[0]?.init
  expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect(init?.method).toBe('POST')
  expect(JSON.parse(String(init?.body))).toEqual({
    model: 'google/gemini-3.7-flash',
    messages: MESSAGES,
    stream: true,
  })
  expect(init?.headers).toEqual({
    Authorization: 'Bearer sk-or-v1-test',
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://app.example/modeller/',
    'X-OpenRouter-Title': 'Vibe3D',
  })
  // The wildcard ACAO carries no allow-credentials, so 'include' would fail CORS.
  expect(init).not.toHaveProperty('credentials')
})

test('throws a ChatError for a pre-stream failure without touching the body', async () => {
  let bodyReads = 0
  stubFetch(() => ({
    ok: false,
    status: 401,
    get body() {
      bodyReads++
      return null
    },
    text: async () => '{"error":{"message":"User not found.","code":401}}',
  }))

  const error = await drain(streamChat(MESSAGES, signal(), OPTIONS)).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ChatError)
  expect((error as ChatError).message).toBe('User not found.')
  expect((error as ChatError).status).toBe(401)
  expect((error as ChatError).errorType).toBe(null)
  expect(bodyReads).toBe(0)
})

test('throws a ChatError carrying error_type for an in-band error under HTTP 200', async () => {
  stubFetch(
    () =>
      new Response(
        'data: {"id":"gen-2","object":"chat.completion.chunk","created":1756512000,"choices":[{"index":0,"delta":{"content":"cube("},"finish_reason":null}]}\n\n' +
          'data: {"error":{"code":"server_error","message":"Provider returned error","metadata":{"provider_name":"Google","error_type":"provider_error"}}}\n\n',
        { status: 200 },
      ),
  )

  const seen: StreamEvent[] = []
  let error: unknown = null
  try {
    for await (const event of streamChat(MESSAGES, signal(), OPTIONS)) seen.push(event)
  } catch (thrown) {
    error = thrown
  }

  expect(seen).toEqual([{ type: 'delta', text: 'cube(' }])
  expect(error).toBeInstanceOf(ChatError)
  expect((error as ChatError).message).toBe('Provider returned error')
  expect((error as ChatError).status).toBe(null)
  expect((error as ChatError).errorType).toBe('provider_error')
})

test('lets an AbortError propagate instead of wrapping it', async () => {
  stubFetch(() => {
    throw new DOMException('The user aborted a request.', 'AbortError')
  })

  const controller = new AbortController()
  controller.abort()
  const error = await drain(streamChat(MESSAGES, controller.signal, OPTIONS)).catch(
    (e: unknown) => e,
  )
  expect(error).not.toBeInstanceOf(ChatError)
  expect((error as DOMException).name).toBe('AbortError')
})

// The three bodies below are the ones this API really emits, pasted verbatim.
test('reads the message out of the plain error envelope', () => {
  expect(errorMessage('{"error":{"message":"Invalid code","code":400}}')).toBe('Invalid code')
})

test('unwraps the ZodError envelope instead of showing the raw issue array', () => {
  const body =
    '{"success":false,"error":{"name":"ZodError","message":"[\\n  {\\n    \\"expected\\": \\"string\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"code\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected string, received undefined\\"\\n  }\\n]"}}'
  expect(errorMessage(body)).toBe('Invalid input: expected string, received undefined')
})

test('falls back to the raw text for a text/plain body', () => {
  expect(errorMessage('Malformed JSON in request body')).toBe('Malformed JSON in request body')
})

test('never returns an empty message for an empty body', () => {
  expect(errorMessage('')).not.toBe('')
})

/** A trimmed slice of the real /models payload, extra fields and all. */
const CATALOGUE = {
  data: [
    {
      id: 'google/gemini-3.7-flash',
      canonical_slug: 'google/gemini-3.7-flash',
      name: 'Google: Gemini 3.7 Flash',
      created: 1756000000,
      context_length: 1048576,
      architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'] },
      pricing: { prompt: '0.00000075', completion: '0.00000375', image: '0' },
      top_provider: { context_length: null },
    },
    {
      id: '~anthropic/claude-sonnet-5',
      name: 'Anthropic: Claude Sonnet 5 (alias)',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015' },
    },
    {
      id: 'meta-llama/llama-4-scout:free',
      name: 'Meta: Llama 4 Scout (free)',
      context_length: 131072,
      pricing: { prompt: '0', completion: '0' },
    },
    {
      id: 'google/gemini-3.7-flash:batch',
      name: 'Google: Gemini 3.7 Flash (batch)',
      context_length: 1048576,
      pricing: { prompt: '0.000000375', completion: '0.000001875' },
    },
    {
      id: 'openrouter/auto',
      name: 'Auto Router',
      context_length: 2000000,
      pricing: { prompt: '-1', completion: '-1' },
    },
  ],
}

test('keeps aliases and :free, drops :batch and openrouter/*, and memoises', async () => {
  stubFetch(() => new Response(JSON.stringify(CATALOGUE), { status: 200 }))

  const models = await fetchModels('https://catalogue.example/v1')
  expect(calls[0]?.url).toBe('https://catalogue.example/v1/models')
  expect(models.map((model) => model.id)).toEqual([
    'google/gemini-3.7-flash',
    '~anthropic/claude-sonnet-5',
    'meta-llama/llama-4-scout:free',
  ])
  // Only the declared fields survive the parse; pricing passes through whole.
  expect(Object.keys(models[0] ?? {})).toEqual([
    'id',
    'name',
    'context_length',
    'pricing',
    'vision',
  ])
  expect(models[0]?.context_length).toBe(1048576)
  expect(models[0]?.pricing.prompt).toBe('0.00000075')

  await fetchModels('https://catalogue.example/v1')
  expect(calls).toHaveLength(1)
})

test('vision is flagged from input_modalities, and absent means unknown not no', async () => {
  stubFetch(() => new Response(JSON.stringify(CATALOGUE), { status: 200 }))
  const models = await fetchModels('https://vision.example/v1')

  expect(models[0]?.vision).toBe(true)
  // The alias entry declares no architecture at all. That is "we cannot tell",
  // and it must never hide or disable the model — support is per-provider while
  // OpenRouter load-balances providers, so the flag is a hint either way.
  expect(models[1]?.vision).toBe(false)
})

test('degrades to an empty catalogue when data is not an array', async () => {
  stubFetch(() => new Response('{"data":null}', { status: 200 }))
  expect(await fetchModels('https://not-a-catalogue.example/v1')).toEqual([])
})

test('does not memoise a failed catalogue load', async () => {
  let attempt = 0
  stubFetch(() => {
    if (attempt++ === 0) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(CATALOGUE), { status: 200 })
  })

  expect(await fetchModels('https://flaky.example/v1')).toEqual([])
  expect((await fetchModels('https://flaky.example/v1')).length).toBe(3)
})

test('contextLimit answers 0 for an unknown id', () => {
  const models: readonly ModelInfo[] = [
    {
      id: 'a/b',
      name: 'B',
      context_length: 8192,
      pricing: { prompt: '0', completion: '0' },
      vision: false,
    },
  ]
  expect(contextLimit(models, 'a/b')).toBe(8192)
  expect(contextLimit(models, 'nope/nope')).toBe(0)
})

test('a chunk carrying the same thought as `reasoning` and as `reasoning_details` yields it once', async () => {
  const stream = [
    'data: {"choices":[{"index":0,"delta":{"reasoning":"**Sizing**","reasoning_details":[{"type":"reasoning.text","text":"**Sizing**"}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"reasoning":" the plate"},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"…"}]},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n')
  stubFetch(() => new Response(stream, { status: 200 }))

  expect(await drain(streamChat(MESSAGES, signal(), OPTIONS))).toEqual([
    { type: 'reasoning', text: '**Sizing**' },
    { type: 'reasoning', text: ' the plate' },
    { type: 'delta', text: 'ok' },
    { type: 'finish', reason: 'stop' },
  ])
})
