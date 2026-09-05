import { useEffect, useMemo, useRef, useState } from 'react'
import { Compiler, type CompileResult } from '../kernel/compile'
import { completePkce, pkceAvailable, revokeUrl, startPkce } from '../llm/auth'
import { toDataUrl } from '../llm/images'
import {
  contextLimit, DEFAULT_BASE_URL, fetchModels, latestModels, streamChat, type ModelInfo, type Usage,
} from '../llm/openrouter'
import { loadKey, saveKey } from '../state/key'
import {
  loadSettings, parseBed, saveSettings, THINKING, thinkingOf, withThinking, type PortableSettings, type Thinking,
} from '../state/settings'
import type { DownloadFormat } from '../export/download'
import type { Component } from '../state/documents'
import { parseOff, type Mesh } from '../kernel/off'
import { meshStats } from '../kernel/stats'
import { renderView } from '../viewer/capture'
import { boxOf, formatReport, hostOf, idealView, inspect, meshChecks, type Closeup } from '../viewer/inspect'
import { referenceLine, type Selection } from '../viewer/select'
import { COMMANDS, parseCommand, type Command } from './commands'
import { COMPACT_AT, runCompact, runTurn } from './controller'
import { addUsage, formatTokens, formatUsd, ZERO_SPEND, type Spend } from './cost'
import { parseMarkdown, type Inline } from './markdown'
import { nextTurn, type ChatEvent } from './log'
import { partCount } from './parts'
import { systemPromptFor, verifyMessage } from './prompt'
import { renderSkill } from './skills'
import { usesText } from '../kernel/fonts'

const REVOKE_HOME = 'https://openrouter.ai/settings/keys'
/** A plain cap, chosen over reasoning about 413 payload_too_large: OpenRouter
 *  documents no inline size limit and providers enforce their own. */
const MAX_IMAGES = 4
/** A picked or pasted image, or the viewport with the user's strokes — which the message names. */
interface Attachment {
  url: string
  markup?: true
}

export function Chat({
  source,
  files,
  components,
  selection,
  onClearSelection,
  before,
  units,
  initialLog,
  onLogChange,
  onStreamSource,
  onApply,
  onUndo,
  onExport,
  onBusyChange,
  onPrompt,
  markup,
  onClearMarkup,
  construction,
  onCandidate,
  onBed,
}: {
  source: string
  /** The document's mesh files, for the kernel FS of every compile this pane runs. */
  files: Readonly<Record<string, Uint8Array>>
  /** The same files, as the model is told about them. */
  components: readonly Component[]
  /** The part the user clicked, if any: the next message is about it. */
  selection: Selection | null
  onClearSelection: () => void
  /** A viewport screenshot with the user's strokes on it: attached to the next message. */
  markup: string | null
  onClearMarkup: () => void
  /** Construction geometry on screen, for the looks the model asks for. */
  construction: Mesh | null
  /** The turn's latest candidate that compiled, for the viewport while the turn runs; null when it ends. */
  onCandidate: (mesh: Mesh | null) => void
  /** OFF of the mesh on screen — what a turn's inspection compares against. null when nothing has compiled. */
  before: Uint8Array | null
  /** Display units. The source stays metric; this is how to READ the user. */
  units: 'mm' | 'in'
  /** The transcript this document had when it was opened. Read once. */
  initialLog: readonly ChatEvent[]
  /** Every change to the log, images included — the receiver strips them. */
  onLogChange: (log: readonly ChatEvent[]) => void
  onStreamSource: (partial: string | null) => void
  /** `label` is the user's words, for the version this turn becomes. */
  onApply: (next: string, result: CompileResult, label: string) => void
  /** Steps the document back one version; the note to show, or null when there is nothing to undo. */
  onUndo: () => string | null
  onExport: (format: DownloadFormat) => void
  onBusyChange: (busy: boolean) => void
  /** The user's words for the part. The document takes its name from the first. */
  onPrompt: (text: string) => void
  /** The build volume changed in the settings: the viewport draws its plate from it. */
  onBed?: (bed: readonly [number, number, number]) => void
}) {
  const [log, setLog] = useState<ChatEvent[]>(() => [...initialLog])
  const [turn, setTurn] = useState(() => nextTurn(initialLog))
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<readonly Attachment[]>([])
  /** What the turn is doing right now — "look 2 · compiling" — while it runs. */
  const [phase, setPhase] = useState('')
  /** The status line toggles this: the model's output so far, raw, code and reasoning included. */
  const [showRaw, setShowRaw] = useState(false)
  const [copied, setCopied] = useState(false)
  // Slots claimed by a normalisation still in flight. Reserved synchronously,
  // in the event handler, so a second pick cannot claim the same room — and so
  // sending cannot outrun a decode and push the image onto the NEXT turn.
  const [pending, setPending] = useState(0)
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  // The reply as it arrives. Held here rather than in the log because the log
  // is append-only and this is superseded the moment the turn settles.
  const [liveText, setLiveText] = useState('')
  const [liveReasoning, setLiveReasoning] = useState('')
  const [chatError, setChatError] = useState<string | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [apiKey, setApiKey] = useState(loadKey)
  const [models, setModels] = useState<readonly ModelInfo[]>([])
  const [showSettings, setShowSettings] = useState(() => loadKey() === '')
  const [revoke, setRevoke] = useState(REVOKE_HOME)
  const [spend, setSpend] = useState<Spend>(ZERO_SPEND)
  /** The session's spend when the running turn began, so the status line can say what this turn has cost. */
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const [bedText, setBedText] = useState(() => loadSettings().bed.join(' × '))
  // A custom base URL may be a keyless local server (Ollama, LM Studio), so an
  // empty key only blocks prompting against OpenRouter itself.
  const canPrompt = apiKey !== '' || settings.baseUrl !== DEFAULT_BASE_URL

  // Refs, not state, wherever a value is read inside an async turn: the turn
  // closes over its render's values, and a stale log would re-send history.
  const busyRef = useRef(false)
  const logRef = useRef(log)
  logRef.current = log
  const usageRef = useRef<Usage | null>(null)
  const compactedRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const logBoxRef = useRef<HTMLDivElement>(null)
  // Follows the newest message only while the reader is at the bottom: someone
  // scrolling up to re-read an earlier turn must not be dragged back by every
  // streamed token. Re-armed by their own scroll back down.
  const stickRef = useRef(true)
  // The reasoning box scrolls on its own, and follows the newest thought by the same rule.
  const reasoningRef = useRef<HTMLDivElement>(null)
  const reasoningStickRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // The document owns the transcript (design.md §7); this pane owns the live
  // copy. Reported through a ref so the effect does not re-fire on every
  // parent render, and never for the array it was seeded with.
  const initialLogRef = useRef(log)
  const onLogChangeRef = useRef(onLogChange)
  onLogChangeRef.current = onLogChange
  useEffect(() => {
    if (log !== initialLogRef.current) onLogChangeRef.current(log)
  }, [log])

  // The turn gets its OWN compiler. compile() calls cancel() as its first
  // statement, so sharing the preview's instance would let a stray recompile
  // settle a paid-for turn as cancelled, with no user-visible message.
  const compiler = useMemo(() => new Compiler(), [])
  // A document switch remounts this pane; the turn it was running must die with
  // it, or its onApply lands in whichever document is current by then.
  useEffect(
    () => () => {
      abortRef.current?.abort()
      compiler.dispose()
    },
    [compiler],
  )

  const append = (event: ChatEvent) => setLog((current) => [...current, event])
  const note = (text: string, tone: 'info' | 'error' = 'info') =>
    append({ id: crypto.randomUUID(), ts: Date.now(), turn, kind: 'note', text, tone })

  /**
   * Normalises at attach time rather than at send time, so the cost of a
   * 12-megapixel photo is paid once, while the user is still typing, and the
   * tray doubles as the signal that it finished.
   */
  const attach = async (picked: readonly File[]) => {
    const images = picked.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    // Counting `pending` is what makes `room` — and therefore the note below —
    // true: without it two picks in a row both measure the same empty tray,
    // and the second one's overflow is dropped by the cap without a word.
    const room = MAX_IMAGES - attachments.length - pending
    if (room <= 0) {
      note(`Already at ${MAX_IMAGES} images.`, 'error')
      return
    }
    const taking = images.slice(0, room)
    // Silently dropping the overflow looks like the paste failed.
    if (images.length > room) note(`Attaching ${room} — ${MAX_IMAGES} images is the limit.`)
    setPending((count) => count + taking.length)
    try {
      // allSettled, not all: one undecodable file must not take the rest of the
      // batch down with it, which is the whole of a four-image pick.
      const settled = await Promise.allSettled(taking.map(toDataUrl))
      const urls = settled.flatMap((one) => (one.status === 'fulfilled' ? [{ url: one.value }] : []))
      if (urls.length > 0) setAttachments((current) => [...current, ...urls])
      const unreadable = taking.length - urls.length
      if (unreadable > 0) {
        note(`${unreadable} ${unreadable === 1 ? 'image' : 'images'} could not be read.`, 'error')
      }
    } finally {
      setPending((count) => count - taking.length)
    }
  }

  useEffect(() => {
    const box = logBoxRef.current
    if (box && stickRef.current) box.scrollTop = box.scrollHeight
  }, [log, thinking, liveText, liveReasoning])
  useEffect(() => {
    const box = reasoningRef.current
    if (box && reasoningStickRef.current) box.scrollTop = box.scrollHeight
  }, [liveReasoning])

  // Grow to the content, capped in CSS. Reset to auto first or scrollHeight
  // only ever reports the taller of the two and the box can never shrink back.
  useEffect(() => {
    const field = inputRef.current
    if (!field) return
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }, [input])

  // Finish an OAuth round trip, if this load is the redirect back.
  useEffect(() => {
    completePkce()
      .then((minted) => {
        if (!minted) return
        saveKey(minted)
        setApiKey(minted)
        setShowSettings(false)
      })
      .catch((error: unknown) => setChatError(error instanceof Error ? error.message : String(error)))
  }, [])

  // Lazily, and only when the panel that needs them is open — which is also
  // the only place a key can be entered, so the catalogue is loaded by the
  // time a turn could need contextLimit for auto-compact.
  useEffect(() => {
    if (!showSettings && !canPrompt) return
    fetchModels(settings.baseUrl)
      .then(setModels)
      .catch(() => setModels([]))
  }, [showSettings, canPrompt, settings.baseUrl])

  useEffect(() => {
    if (!apiKey) return setRevoke(REVOKE_HOME)
    let live = true
    revokeUrl(apiKey).then((url) => live && setRevoke(url)).catch(() => {})
    return () => {
      live = false
    }
  }, [apiKey])

  const stop = () => {
    // An AbortSignal does not reach a Worker, so the compile needs its own kill.
    abortRef.current?.abort()
    compiler.cancel()
  }

  const persistSettings = (next: PortableSettings) => {
    setSettings(next)
    saveSettings(next)
    if (next.bed !== settings.bed) onBed?.(next.bed)
  }

  // A markup from the viewport joins the tray like a picked file, flagged so
  // the message can say what it is. Consumed at once: App holds it only in transit.
  useEffect(() => {
    if (!markup) return
    if (attachments.length >= MAX_IMAGES) note(`Already at ${MAX_IMAGES} images.`, 'error')
    else setAttachments((current) => [...current, { url: markup, markup: true }])
    onClearMarkup()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markup])

  /**
   * Everything a bug report needs and nothing secret: settings, source, the
   * transcript raw (replies verbatim, stderr, reports), whatever is in flight.
   * No key. No images — a data URL is a screenful of base64 nobody can read.
   */
  const debugReport = (): string => {
    const lines: string[] = [
      '# Vibe3D debug report',
      `model: ${settings.model} · thinking: ${thinkingOf(settings)} · units: ${units} · base: ${settings.baseUrl} · next turn: ${turn}`,
      ...(components.length ? [`files: ${components.map((c) => `${c.name} (${c.bytes.length} bytes)`).join(', ')}`] : []),
      ...(chatError ? [`error: ${chatError}`] : []),
      '',
      '## Source',
      '```openscad',
      source,
      '```',
      '',
      '## Transcript',
    ]
    for (const e of logRef.current) {
      const head = `[${e.turn}] ${e.kind}`
      switch (e.kind) {
        case 'user': {
          const n = e.images?.length ?? 0
          lines.push(`${head}${n ? ` (+${n} image${n > 1 ? 's' : ''})` : ''}:`, e.text, '')
          break
        }
        case 'assistant':
          lines.push(`${head}${e.stopped ? ' (stopped)' : ''}:`, e.text, '')
          break
        case 'compile':
          lines.push(`${head}: ${e.ok ? 'ok' : 'FAILED'} · ${e.ms} ms · attempt ${e.attempt}`, ...(e.stderr ? [e.stderr] : []), '')
          break
        case 'inspect':
          lines.push(`${head}${e.image ? ' (+render)' : ''}:`, e.text, '')
          break
        case 'note':
          lines.push(`${head} (${e.tone}): ${e.text}`, '')
          break
        case 'skill':
          lines.push(`${head}: ${e.name}${e.error ? ` — ${e.error}` : ''}`, '')
          break
        case 'summary':
          lines.push(`${head} (covers through ${e.coversThrough}):`, e.text, '')
          break
        case 'clear':
          lines.push(head, '')
      }
    }
    if (thinking) {
      lines.push('## In flight', `phase: ${phase}`)
      if (liveReasoning) lines.push('reasoning:', liveReasoning)
      if (liveText) lines.push('reply so far:', liveText)
    }
    return lines.join('\n')
  }

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(debugReport())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      note('Could not reach the clipboard.', 'error')
    }
  }

  const runCommand = async (command: Command) => {
    switch (command.name) {
      case 'clear':
        append({ id: crypto.randomUUID(), ts: Date.now(), turn, kind: 'clear' })
        note('Cleared. The model keeps the current source, not the conversation.')
        return
      case 'export':
        onExport(command.format)
        return
      case 'model':
        if (command.id) {
          persistSettings({ ...settings, model: command.id })
          note(`Model set to ${command.id}.`)
        } else {
          setShowSettings(true)
        }
        return
      case 'key':
        setShowSettings(true)
        return
      case 'think':
        if (command.level) {
          persistSettings(withThinking(settings, command.level))
          note(
            command.level === 'off'
              ? 'Thinking off: one call per message.'
              : `Thinking ${command.level}: the model looks, cuts and corrects until it is satisfied. Stop ends it early.`,
          )
        } else {
          setShowSettings(true)
        }
        return
      case 'unknown':
        note(`Unknown command /${command.word}. Type /help for the list.`, 'error')
        return
      case 'help':
        note(COMMANDS.map((c) => `${c.usage} — ${c.what}`).join('\n'))
        return
      case 'undo': {
        const restored = onUndo()
        note(restored ?? 'Nothing to undo.', restored ? 'info' : 'error')
        return
      }
      case 'compact':
        await compact(true, turn)
    }
  }

  /** `at` is the next turn number — passed in because send() bumps the state after it runs. */
  const compact = async (explicit: boolean, at: number) => {
    const controller = new AbortController()
    abortRef.current = controller
    const outcome = await runCompact(
      { log: logRef.current, turn: at, systemPrompt: systemPromptFor(units), source, components },
      {
        stream: (messages, signal) =>
          streamChat(messages, signal, {
            baseUrl: settings.baseUrl,
            apiKey,
            model: settings.model,
          }),
        append,
        now: () => performance.now(),
        newId: () => crypto.randomUUID(),
        signal: controller.signal,
      },
    )
    abortRef.current = null
    if (outcome.status === 'compacted') note('Compacted the conversation.')
    else if (outcome.status === 'nothing-to-compact' && explicit) note('Nothing to compact yet.')
    else if (outcome.status === 'error') note(outcome.message, 'error')
  }

  const send = async () => {
    if (busyRef.current) return
    // An image still normalising is not in the tray yet, so sending now would
    // silently move it to the next turn. The button is disabled for this too.
    if (pending > 0) return
    const text = input.trim()
    if (!text && attachments.length === 0) return

    const command = parseCommand(text)
    if (command) {
      setInput('')
      setAttachments([])
      busyRef.current = true
      setBusy(true)
      try {
        await runCommand(command)
      } finally {
        busyRef.current = false
        setBusy(false)
      }
      return
    }

    if (!canPrompt) {
      setChatError('Connect OpenRouter or add an API key below to start.')
      setShowSettings(true)
      return
    }

    setInput('')
    setAttachments([])
    setChatError(null)
    onPrompt(text)
    // The selection and the markup ride in the message itself, so the transcript
    // records what the model was told — and it is what the system prompt describes.
    const heads = [
      ...(selection ? [referenceLine(selection)] : []),
      ...(attachments.some((a) => a.markup) ? ['[Attached: the viewport with my markup in red]'] : []),
    ]
    const userText = [...heads, text].filter(Boolean).join('\n\n')
    const images = attachments.map((a) => a.url)
    const thinking = thinkingOf(settings)
    const looks = thinking !== 'off'
    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true
    setBusy(true)
    setThinking(true)
    setTurnStart(spend.usd)
    onBusyChange(true)
    // The catalogue decides whether this model gets a render and how long it
    // may answer; a first send right after boot must not outrun the fetch.
    const catalogue = models.length > 0 ? models : await fetchModels(settings.baseUrl).catch(() => [])
    if (catalogue !== models) setModels(catalogue)
    const info = catalogue.find((m) => m.id === settings.model)
    const vision = info?.vision ?? false

    // The latest inspection's changed pieces: what a {"closeup": N} request names.
    let closeups: Closeup[] = []
    try {
      const outcome = await runTurn(
        {
          userText,
          images,
          log: logRef.current,
          turn,
          systemPrompt: systemPromptFor(units, images.length > 0, looks),
          // ponytail: the mesh is decoded per window that carries a loaded
          // skill; only the parts listing reads it. Cache by bytes if it shows.
          skills: (name, src, off) => {
            const bytes = off ?? before
            let mesh = null
            try {
              mesh = bytes ? parseOff(new TextDecoder().decode(bytes)) : null
            } catch {
              mesh = null
            }
            return renderSkill(name, { source: src, mesh, looks })
          },
          source,
          components,
          looks,
        },
        {
          stream: (messages, signal) =>
            streamChat(messages, signal, {
              baseUrl: settings.baseUrl,
              apiKey,
              model: settings.model,
              ...(looks ? { reasoning: thinking as Exclude<Thinking, 'off'> } : {}),
              ...(info?.maxOutput ? { maxTokens: info.maxOutput } : {}),
            }),
          compile: async (candidate) => {
            const result = await compiler.compile(candidate, 'off', { files })
            // Shown at once, so the user orbits what the model is looking at
            // instead of waiting for the commit to see any of it.
            if (result.ok && !controller.signal.aborted) {
              try {
                onCandidate(parseOff(new TextDecoder().decode(result.data)))
              } catch {
                // An unreadable OFF is the turn's problem to report, not the preview's.
              }
            }
            return result
          },
          inspect: async (candidate, off, prior) => {
            const insp = await inspect({
              before: prior ?? before,
              after: off,
              vision,
              signal: controller.signal,
            })
            closeups = insp.closeups
            return {
              text: verifyMessage(
                formatReport(insp.report),
                meshChecks(insp.report, partCount(candidate), usesText(candidate), settings.bed),
                insp.legend,
                looks,
                closeups.length,
              ),
              ...(insp.image ? { image: insp.image } : {}),
            }
          },
          // The latest mesh of the turn, else the one on screen. The vision
          // flag gates this like the composite: a render nobody can read is a
          // failed turn after a compile the user waited for.
          render: async (request, off) => {
            if (!vision) return null
            if (request.closeup !== null) return closeups[request.closeup - 1]?.render() ?? null
            const bytes = off ?? before
            if (!bytes) return null
            const mesh = parseOff(new TextDecoder().decode(bytes))
            const stats = meshStats(mesh)
            const model = boxOf(stats)
            // An auto view looks from the side of its part the box sits on.
            const target = request.box ?? model
            const from =
              request.view === 'auto'
                ? idealView(target, hostOf(target, stats.shells.map(boxOf), model)).direction
                : null
            return renderView(mesh, request, model, construction, from)
          },
          onPhase: setPhase,
          append,
          onDraft: onStreamSource,
          onText: setLiveText,
          onReasoning: setLiveReasoning,
          onUsage: (usage) => {
            usageRef.current = usage
            setSpend((current) => addUsage(current, usage, info?.pricing))
          },
          now: () => performance.now(),
          newId: () => crypto.randomUUID(),
          signal: controller.signal,
        },
      )

      // Bumped before the outcome is handled, so nothing between here and the
      // next message can skip it: a throw out of onApply would leave the next
      // user event carrying this same turn number, and buildWindow would then
      // read BOTH as live — re-sending this turn's images and its verbatim
      // assistant source on a turn that does not own them.
      const finished = turn
      setTurn(finished + 1)

      // Commit on final failure too: the user has to see the code to fix it,
      // and CodeMirror's history makes the whole-document replace undoable.
      if (outcome.status === 'committed' || outcome.status === 'failed') {
        onApply(outcome.source, outcome.result, text)
      } else if (outcome.status === 'error') {
        setChatError(outcome.message)
      }

      const limit = contextLimit(catalogue, settings.model)
      const used = usageRef.current?.total_tokens ?? 0
      // limit === 0 means the catalogue has not resolved or the id is unknown;
      // without this guard the ratio is Infinity and compaction fires forever.
      if (limit > 0 && used / limit > COMPACT_AT && compactedRef.current !== finished) {
        compactedRef.current = finished
        note('Context is filling up — compacting.')
        await compact(false, finished + 1)
      }
    } finally {
      onStreamSource(null)
      onCandidate(null)
      setThinking(false)
      setTurnStart(null)
      setPhase('')
      setLiveText('')
      setLiveReasoning('')
      busyRef.current = false
      setBusy(false)
      onBusyChange(false)
      abortRef.current = null
    }
  }

  return (
    <div className="chat">
      <div
        className="chat-log"
        ref={logBoxRef}
        onScroll={(e) => {
          const box = e.currentTarget
          stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40
        }}
      >
        {log.length === 0 && (
          <p className="chat-empty">
            Describe the part you want. The model rewrites the source, or edits a section of it;
            it gets two attempts to fix a compile error before it hands the failure to you. Click
            a part in the viewport to talk about that one.
          </p>
        )}
        {log.map((event) => (
          <ChatEventView key={event.id} event={event} />
        ))}
        {thinking && (liveText || liveReasoning) && !showRaw && (
          <div className="msg msg-assistant">
            {/* Reasoning only until real content starts: it is the answer to
                "why is nothing happening", not part of the reply. */}
            {/* Rendered, not raw: a thinking model titles its steps in bold. */}
            {!liveText && (
              <div
                className="chat-reasoning"
                ref={reasoningRef}
                onScroll={(e) => {
                  const box = e.currentTarget
                  reasoningStickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
                }}
              >
                <Markdown text={liveReasoning} />
              </div>
            )}
            <Markdown text={liveText} caret />
          </div>
        )}
        {thinking && showRaw && (
          // Verbatim: the rendering above collapses code to a chip and drops
          // the reasoning once content starts; this is what actually arrived.
          <pre className="chat-raw" id="chat-raw">
            {liveReasoning && `# reasoning\n${liveReasoning}\n\n`}
            {liveText || '(nothing from the model yet)'}
          </pre>
        )}
        {thinking && (
          // The turn's current phase, so a long chain of looks reads as
          // progress rather than as a hang. Stop is the only brake. A click
          // opens the raw output.
          <button
            type="button"
            className="chat-note chat-phase"
            aria-live="polite"
            aria-expanded={showRaw}
            aria-controls="chat-raw"
            title={showRaw ? "Hide the model's output" : "Show the model's output so far"}
            onClick={() => setShowRaw((open) => !open)}
          >
            <span className="spinner" aria-hidden="true" />
            {phase || 'thinking'}
            {turnStart !== null && spend.usd !== null && spend.usd > turnStart && (
              <span className="chat-turn-cost"> · {formatUsd(spend.usd - turnStart)}</span>
            )}
          </button>
        )}
      </div>

      {chatError && <div className="chat-error">{chatError}</div>}

      {!canPrompt && (
        <div className="chat-nokey">
          No API access yet — connect OpenRouter or paste an API key in{' '}
          <button type="button" onClick={() => setShowSettings(true)}>
            settings
          </button>{' '}
          to start prompting.
        </div>
      )}


      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        {selection && (
          <div className="chat-selection">
            <span className="chip">
              <b>part {selection.part} of {selection.of}</b>
              {selection.max.map((hi, i) => Math.round((hi - selection.min[i]!) * 10) / 10).join(' × ')} mm
            </span>
            <button type="button" className="chat-note" onClick={onClearSelection} aria-label="Clear selection">
              clear
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chat-tray">
            {attachments.map((a, i) => (
              <button
                key={i}
                type="button"
                className={a.markup ? 'chat-thumb markup' : 'chat-thumb'}
                title={a.markup ? 'Viewport markup — remove' : 'Remove'}
                aria-label="Remove image"
                disabled={busy}
                onClick={() => setAttachments((current) => current.filter((_, j) => j !== i))}
              >
                <img src={a.url} alt="" />
              </button>
            ))}
          </div>
        )}
        <div className="chat-input">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            disabled={busy}
            placeholder="Describe the part, or a change to it…"
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) =>
                f.type.startsWith('image/'),
              )
              // Conditional: an unconditional preventDefault breaks text paste.
              if (files.length === 0) return
              e.preventDefault()
              void attach(files)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <label className="chat-attach" title="Attach images">
            <span aria-hidden="true">▣</span>
            {/* The label's only content is a decorative glyph, so aria-label is
                what gives the control a name; the input stays focusable in CSS
                rather than display:none, or Tab skips it entirely. */}
            <input
              type="file"
              aria-label="Attach images"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              disabled={busy}
              onChange={(e) => {
                void attach([...(e.target.files ?? [])])
                // So the same file can be picked twice in a row.
                e.target.value = ''
              }}
            />
          </label>
          {busy ? (
            <button type="button" className="chat-send stop" onClick={stop} aria-label="Stop">
              ■
            </button>
          ) : (
            <button
              type="submit"
              className="chat-send"
              disabled={(!input.trim() && attachments.length === 0) || pending > 0}
              aria-label="Send"
            >
              ↑
            </button>
          )}
        </div>
      </form>

      <div className="chat-meter">
        <button type="button" onClick={() => setShowSettings((open) => !open)}>
          {settings.model}
          {thinkingOf(settings) !== 'off' && ` · ${thinkingOf(settings)}`}
        </button>
        <span className="sep">·</span>
        <span title="Prompt + completion tokens this session">
          {formatTokens(spend.prompt + spend.completion)} tok
        </span>
        <span className="sep">·</span>
        {/* Blank rather than a partial figure: usd goes null for the whole
            session the moment one turn goes unpriced, and a number that has
            silently stopped counting is worse than none. */}
        <span title="Spent this session, at the model's list price">
          {spend.usd === null ? 'cost unknown' : formatUsd(spend.usd)}
        </span>
        <span className="sep">·</span>
        <button
          type="button"
          title="Copy a debug report: settings, source and the whole transcript, raw. No key, no images."
          onClick={() => void copyReport()}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>

      {showSettings && (
        <div className="chat-settings">
          <>
            {pkceAvailable() && (
              <div className="row">
                <button type="button" onClick={() => void startPkce()}>
                  Connect OpenRouter
                </button>
                <span className="chat-hint">mints a revocable key for this app</span>
              </div>
            )}
            <label>
              API key
              <input
                type="password"
                value={apiKey}
                placeholder="sk-or-…"
                onChange={(e) => {
                  const next = e.target.value.trim()
                  setApiKey(next)
                  saveKey(next)
                }}
              />
            </label>
            <label>
              Model
              {models.length > 0 ? (
                <select
                  value={settings.model}
                  onChange={(e) => persistSettings({ ...settings, model: e.target.value })}
                >
                  <optgroup label="Latest">
                    {latestModels(models).map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                        {model.vision ? ' · vision' : ''}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="All models">
                    {models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                        {model.vision ? ' · vision' : ''}
                      </option>
                    ))}
                  </optgroup>
                </select>
              ) : (
                <input
                  value={settings.model}
                  onChange={(e) => persistSettings({ ...settings, model: e.target.value })}
                />
              )}
            </label>
            <label>
              Base URL
              <input
                value={settings.baseUrl}
                onChange={(e) => persistSettings({ ...settings, baseUrl: e.target.value })}
              />
            </label>
            <label>
              Thinking
              <select
                value={thinkingOf(settings)}
                onChange={(e) => persistSettings(withThinking(settings, e.target.value as Thinking))}
              >
                {THINKING.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Bed
              <input
                value={bedText}
                placeholder="256 × 256 × 256"
                title="The printer's build volume in mm: the plate outline, and a check the part fits"
                onChange={(e) => {
                  setBedText(e.target.value)
                  const bed = parseBed(e.target.value)
                  if (bed) persistSettings({ ...settings, bed })
                }}
              />
            </label>
            <p className="chat-hint">
              Thinking <b>off</b> is one model call per message. Any other level is the model's
              reasoning effort, and lets it look at what it built, ask for views and cuts, and
              correct itself until it is satisfied. Remembered per model. The line under the transcript says what it
              is doing; <b>Stop</b> ends it and keeps the last version that compiled.
            </p>
            <p className="chat-hint">
              The key is stored in this browser only, under <code>vibe3d.key</code>. Revoke it
              at <a href={revoke} target="_blank" rel="noreferrer">openrouter.ai</a>. This app
              cannot set a spend cap — that is a manual step in your OpenRouter settings.
            </p>
          </>
        </div>
      )}
    </div>
  )
}

function Spans({ spans }: { spans: readonly Inline[] }) {
  return (
    <>
      {spans.map((span, i) => {
        if (span.code) return <code key={i}>{span.text}</code>
        if (span.strong) return <strong key={i}>{span.text}</strong>
        if (span.em) return <em key={i}>{span.text}</em>
        return <span key={i}>{span.text}</span>
      })}
    </>
  )
}

/**
 * A reply, rendered. The code block collapses to a chip carrying only its size:
 * the source is one pane to the left, and repeating forty lines here pushes the
 * sentence explaining them off screen.
 */
function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <>
      {blocks.map((block, i) => {
        // The caret belongs on the last block only, and never on a chip.
        const tail = caret && i === blocks.length - 1 && block.kind !== 'code'
        switch (block.kind) {
          case 'heading':
            return (
              <h4 key={i}>
                <Spans spans={block.spans} />
                {tail && <span className="caret" />}
              </h4>
            )
          case 'paragraph':
            return (
              <p key={i}>
                <Spans spans={block.spans} />
                {tail && <span className="caret" />}
              </p>
            )
          case 'list': {
            const items = block.items.map((item, j) => (
              <li key={j}>
                <Spans spans={item} />
              </li>
            ))
            return block.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>
          }
          case 'code':
            return (
              <span key={i} className="chip">
                <b>{block.lang || 'openscad'}</b>
                {block.lines} ln
              </span>
            )
        }
      })}
    </>
  )
}

function ChatEventView({ event }: { event: ChatEvent }) {
  switch (event.kind) {
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
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          <Markdown text={event.text} />
          {event.stopped && <span className="chat-note">stopped</span>}
        </div>
      )
    case 'compile':
      // Raw stderr, exactly what the model was handed — if the loop is
      // repairing against a bad diagnostic, the user should be able to see it.
      return event.ok ? (
        <span className="chip ok">compiled · {event.ms} ms</span>
      ) : (
        <pre className="chat-stderr">{event.stderr}</pre>
      )
    case 'inspect':
      return (
        <div className="chat-inspect">
          {event.image && <img src={event.image} alt="Before in green, after in magenta" />}
          <details>
            <summary className="chip">inspected</summary>
            <pre>{event.text}</pre>
          </details>
        </div>
      )
    case 'note':
      return <div className={event.tone === 'error' ? 'chat-note bad' : 'chat-note'}>{event.text}</div>
    case 'skill':
      return event.error ? (
        <div className="chat-note bad">{event.error}</div>
      ) : (
        <span className="chip">skill · {event.name}</span>
      )
    case 'clear':
      return <div className="chat-rule">cleared</div>
    case 'summary':
      return <div className="chat-rule">compacted</div>
  }
}
