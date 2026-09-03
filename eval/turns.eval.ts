/**
 * The harness against a real model: ten printable parts, one turn each,
 * through runTurn with the Node kernel for compiles, diffs and measurements.
 * No render (no WebGL here), so the model gets the numbers and the checks —
 * the half of the round every model gets. Results go to eval/results/.
 *
 *   OPENROUTER_API_KEY=sk-or-… pnpm eval
 *   EVAL_MODEL=anthropic/claude-sonnet-5 EVAL_THINKING=off EVAL_ONLY=knob pnpm eval
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, describe, test } from 'vitest'
import { runTurn } from '../src/chat/controller'
import { addUsage, ZERO_SPEND, type Spend } from '../src/chat/cost'
import type { ChatEvent } from '../src/chat/log'
import { partCount } from '../src/chat/parts'
import { systemPromptFor, verifyMessage } from '../src/chat/prompt'
import { renderSkill } from '../src/chat/skills'
import { usesText } from '../src/kernel/fonts'
import { parseOff } from '../src/kernel/off'
import { meshStats } from '../src/kernel/stats'
import { DEFAULT_MODEL, fetchModels, streamChat, type ModelInfo } from '../src/llm/openrouter'
import { DEFAULT_BED, type Thinking } from '../src/state/settings'
import { formatReport, inspect, meshChecks } from '../src/viewer/inspect'
import { compileResult } from './kernel'

const KEY = process.env.OPENROUTER_API_KEY ?? ''
const MODEL = process.env.EVAL_MODEL ?? DEFAULT_MODEL
const THINKING = (process.env.EVAL_THINKING ?? 'high') as Thinking
const ONLY = process.env.EVAL_ONLY ?? ''
const BASE = 'https://openrouter.ai/api/v1'

/** design.md §5's bake-off, as a user would type it. */
const PROMPTS: { name: string; prompt: string }[] = [
  { name: 'plate', prompt: 'A 60 x 40 x 3 mm mounting plate with four M4 clearance holes 5 mm in from each corner and 2 mm corner radii.' },
  { name: 'hex bolt', prompt: 'An M8 hex bolt, 30 mm long under the head, with a 13 mm across-flats head 5 mm tall. Plain shank is fine, no thread.' },
  { name: 'knob', prompt: 'A fluted knob 30 mm across and 15 mm tall with 12 flutes, a 6 mm D-shaft hole 10 mm deep, printed flat on its top face.' },
  { name: 'box', prompt: 'A stackable open box, 80 x 60 mm outside, 40 mm tall, 2 mm walls, with a 3 mm stacking lip on top so another box nests on it.' },
  { name: 'flange', prompt: 'A pipe flange for a 25 mm pipe: 70 mm outside diameter, 8 mm thick, a 25.4 mm bore, six 6 mm bolt holes on a 55 mm circle.' },
  { name: 'phone stand', prompt: 'A phone stand that holds a 75 x 150 mm phone at 65 degrees, with a 12 mm deep lip at the bottom and a cable slot in the lip.' },
  { name: 'honeycomb', prompt: 'A 100 x 100 x 4 mm honeycomb panel with 10 mm hexagonal openings and 2 mm walls, inside a 5 mm solid border.' },
  { name: 'pipe tee', prompt: 'A pipe tee for 20 mm outside diameter pipes: three 20 mm bores, 40 mm long each arm, 3 mm walls, printed lying on the run.' },
  { name: 'cable clip', prompt: 'A cable clip for a 6 mm cable that screws to a wall with one M3 countersunk screw, 1.6 mm thick where it flexes.' },
  { name: 'vase', prompt: 'A twisted vase 120 mm tall, 60 mm wide at the base, 80 mm at the top, a 20-lobe wavy outline twisted 90 degrees, 1.2 mm walls, closed bottom.' },
]

interface Result {
  name: string
  status: string
  calls: number
  looks: number
  repairs: number
  seconds: number
  tokens: { prompt: number; completion: number }
  usd: number | null
  compile_ms: number | null
  bbox_mm: number[] | null
  volume_mm3: number | null
  parts: number | null
  checks_no: number
  source: string | null
  transcript: ChatEvent[]
}

const results: Result[] = []

async function oneTurn(name: string, prompt: string, models: readonly ModelInfo[]): Promise<Result> {
  const info = models.find((m) => m.id === MODEL)
  const looks = THINKING !== 'off'
  const log: ChatEvent[] = []
  let calls = 0
  let spend: Spend = ZERO_SPEND
  const started = performance.now()
  const controller = new AbortController()
  const outcome = await runTurn(
    {
      userText: prompt,
      log: [],
      turn: 1,
      systemPrompt: systemPromptFor('mm', false, looks),
      source: '',
      looks,
      skills: (skill, source, off) =>
        renderSkill(skill, { source, mesh: off ? parseOff(new TextDecoder().decode(off)) : null, looks }),
    },
    {
      stream: (messages, signal) => {
        calls++
        return streamChat(messages, signal, {
          baseUrl: BASE,
          apiKey: KEY,
          model: MODEL,
          ...(looks ? { reasoning: THINKING as Exclude<Thinking, 'off'> } : {}),
          ...(info?.maxOutput ? { maxTokens: info.maxOutput } : {}),
        })
      },
      compile: (source) => compileResult(source),
      inspect: async (candidate, off, prior) => {
        const insp = await inspect({ before: prior, after: off, vision: false, signal: controller.signal, compile: compileResult })
        return {
          text: verifyMessage(
            formatReport(insp.report),
            meshChecks(insp.report, partCount(candidate), usesText(candidate), DEFAULT_BED),
            null,
            looks,
            0,
          ),
        }
      },
      append: (event) => log.push(event),
      onDraft: () => {},
      onText: () => {},
      onReasoning: () => {},
      onUsage: (usage) => {
        spend = addUsage(spend, usage, info?.pricing)
      },
      now: () => performance.now(),
      newId: () => crypto.randomUUID(),
      signal: controller.signal,
    },
  )
  const seconds = Math.round((performance.now() - started) / 100) / 10
  const committed = outcome.status === 'committed' ? outcome : null
  const stats = committed ? meshStats(parseOff(new TextDecoder().decode(committed.result.data))) : null
  const lastInspect = [...log].reverse().find((e) => e.kind === 'inspect')
  return {
    name,
    status: outcome.status,
    calls,
    looks: log.filter((e) => e.kind === 'inspect').length,
    repairs: log.filter((e) => e.kind === 'compile' && !e.ok).length,
    seconds,
    tokens: { prompt: spend.prompt, completion: spend.completion },
    usd: spend.usd,
    compile_ms: committed?.result.ms ?? null,
    bbox_mm: stats ? stats.size.map((n) => Math.round(n * 10) / 10) : null,
    volume_mm3: stats?.volume === null || stats === null ? null : Math.round(stats.volume),
    parts: stats?.parts ?? null,
    checks_no: lastInspect && lastInspect.kind === 'inspect' ? (lastInspect.text.match(/: NO\b/g) ?? []).length : 0,
    source: committed?.source ?? ('source' in outcome ? outcome.source : null),
    transcript: log,
  }
}

const cell = (v: unknown): string => (v === null || v === undefined ? '–' : Array.isArray(v) ? v.join('×') : String(v))
const table = (rows: readonly Result[]): string => {
  const head = ['part', 'status', 'calls', 'looks', 'repairs', 's', 'tokens', 'usd', 'compile ms', 'bbox mm', 'mm³', 'parts', 'NO']
  const line = (r: Result) => [
    r.name, r.status, r.calls, r.looks, r.repairs, r.seconds,
    `${r.tokens.prompt}+${r.tokens.completion}`, r.usd === null ? '–' : r.usd.toFixed(4),
    r.compile_ms, r.bbox_mm, r.volume_mm3, r.parts, r.checks_no,
  ].map(cell)
  return [head, head.map(() => '---'), ...rows.map(line)].map((cells) => `| ${cells.join(' | ')} |`).join('\n')
}

describe.skipIf(!KEY)(`${MODEL} · thinking ${THINKING}`, () => {
  let models: readonly ModelInfo[] = []
  const chosen = PROMPTS.filter((p) => p.name.includes(ONLY))

  test.each(chosen)('$name', async ({ name, prompt }) => {
    if (models.length === 0) models = await fetchModels(BASE)
    results.push(await oneTurn(name, prompt, models))
  })

  afterAll(() => {
    if (results.length === 0) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    mkdirSync('eval/results', { recursive: true })
    const summary = `# ${MODEL} · thinking ${THINKING} · ${stamp}\n\n${table(results)}\n`
    writeFileSync(`eval/results/${stamp}.json`, JSON.stringify({ model: MODEL, thinking: THINKING, results }, null, 2))
    writeFileSync(`eval/results/${stamp}.md`, summary)
    writeFileSync('eval/results/latest.md', summary)
    process.stdout.write(`\n${summary}\nfull transcripts: eval/results/${stamp}.json\n`)
  })
})
