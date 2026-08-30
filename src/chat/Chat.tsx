import { useEffect, useMemo, useRef, useState } from 'react'
import { Compiler, type CompileResult } from '../kernel/compile'
import { completePkce, pkceAvailable, revokeUrl, startPkce } from '../llm/auth'
import {
  contextLimit, fetchModels, streamChat, type ModelInfo, type Usage,
} from '../llm/openrouter'
import { loadKey, saveKey } from '../state/key'
import { loadSettings, saveSettings } from '../state/settings'
import { parseCommand, type Command } from './commands'
import { COMPACT_AT, runCompact, runTurn } from './controller'
import { addUsage, formatTokens, formatUsd, ZERO_SPEND, type Spend } from './cost'
import { parseMarkdown, type Inline } from './markdown'
import type { ChatEvent } from './log'
import { systemPromptFor } from './prompt'

const REVOKE_HOME = 'https://openrouter.ai/settings/keys'

export function Chat({
  source,
  units,
  onStreamSource,
  onApply,
  onExport,
  onBusyChange,
  onPrompt,
}: {
  source: string
  /** Display units. The source stays metric; this is how to READ the user. */
  units: 'mm' | 'in'
  onStreamSource: (partial: string | null) => void
  onApply: (next: string, result: CompileResult) => void
  onExport: (format: 'binstl' | '3mf') => void
  onBusyChange: (busy: boolean) => void
  /** The user's words for the part. The document takes its name from the first. */
  onPrompt: (text: string) => void
}) {
  const [log, setLog] = useState<ChatEvent[]>([])
  const [turn, setTurn] = useState(1)
  const [input, setInput] = useState('')
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

  // Refs, not state, wherever a value is read inside an async turn: the turn
  // closes over its render's values, and a stale log would re-send history.
  const busyRef = useRef(false)
  const logRef = useRef(log)
  logRef.current = log
  const usageRef = useRef<Usage | null>(null)
  const compactedRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // The turn gets its OWN compiler. compile() calls cancel() as its first
  // statement, so sharing the preview's instance would let a stray recompile
  // settle a paid-for turn as cancelled, with no user-visible message.
  const compiler = useMemo(() => new Compiler(), [])
  useEffect(() => () => compiler.dispose(), [compiler])

  const append = (event: ChatEvent) => setLog((current) => [...current, event])
  const note = (text: string, tone: 'info' | 'error' = 'info') =>
    append({ id: crypto.randomUUID(), ts: Date.now(), turn, kind: 'note', text, tone })

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' })
  }, [log, thinking, liveText, liveReasoning])

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
    if (!showSettings && !apiKey) return
    fetchModels(settings.baseUrl)
      .then(setModels)
      .catch(() => setModels([]))
  }, [showSettings, apiKey, settings.baseUrl])

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

  const persistSettings = (next: { baseUrl: string; model: string }) => {
    setSettings(next)
    saveSettings(next)
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
      case 'unknown':
        note(`Unknown command /${command.word}.`, 'error')
        return
      case 'compact':
        await compact(true)
    }
  }

  const compact = async (explicit: boolean) => {
    const controller = new AbortController()
    abortRef.current = controller
    const outcome = await runCompact(
      { log: logRef.current, turn, systemPrompt: systemPromptFor(units), source },
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
    const text = input.trim()
    if (!text) return

    const command = parseCommand(text)
    if (command) {
      setInput('')
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

    if (!apiKey) {
      setChatError('Add an OpenRouter key below to start.')
      setShowSettings(true)
      return
    }

    setInput('')
    setChatError(null)
    onPrompt(text)
    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true
    setBusy(true)
    setThinking(true)
    onBusyChange(true)

    try {
      const outcome = await runTurn(
        { userText: text, log: logRef.current, turn, systemPrompt: systemPromptFor(units), source },
        {
          stream: (messages, signal) =>
            streamChat(messages, signal, {
              baseUrl: settings.baseUrl,
              apiKey,
              model: settings.model,
            }),
          compile: (candidate) => compiler.compile(candidate),
          append,
          onDraft: onStreamSource,
          onText: setLiveText,
          onReasoning: setLiveReasoning,
          onUsage: (usage) => {
            usageRef.current = usage
            setSpend((current) =>
              addUsage(current, usage, models.find((m) => m.id === settings.model)?.pricing),
            )
          },
          now: () => performance.now(),
          newId: () => crypto.randomUUID(),
          signal: controller.signal,
        },
      )

      // Commit on final failure too: the user has to see the code to fix it,
      // and CodeMirror's history makes the whole-document replace undoable.
      if (outcome.status === 'committed' || outcome.status === 'failed') {
        onApply(outcome.source, outcome.result)
      } else if (outcome.status === 'error') {
        setChatError(outcome.message)
      }

      const finished = turn
      setTurn(finished + 1)

      const limit = contextLimit(models, settings.model)
      const used = usageRef.current?.total_tokens ?? 0
      // limit === 0 means the catalogue has not resolved or the id is unknown;
      // without this guard the ratio is Infinity and compaction fires forever.
      if (limit > 0 && used / limit > COMPACT_AT && compactedRef.current !== finished) {
        compactedRef.current = finished
        note('Context is filling up — compacting.')
        await compact(false)
      }
    } finally {
      onStreamSource(null)
      setThinking(false)
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
      <div className="chat-log">
        {log.length === 0 && (
          <p className="chat-empty">
            Describe the part you want. The model rewrites the whole source each turn; it gets two
            attempts to fix a compile error before it hands the failure to you.
          </p>
        )}
        {log.map((event) => (
          <ChatEventView key={event.id} event={event} />
        ))}
        {thinking && (liveText || liveReasoning) ? (
          <div className="msg msg-assistant">
            {/* Reasoning only until real content starts: it is the answer to
                "why is nothing happening", not part of the reply. */}
            {!liveText && <div className="chat-reasoning">{liveReasoning}</div>}
            <Markdown text={liveText} caret />
          </div>
        ) : (
          thinking && (
            <div className="chat-note">
              thinking<span className="caret" />
            </div>
          )
        )}
        <div ref={logEndRef} />
      </div>

      {chatError && <div className="chat-error">{chatError}</div>}

      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <div className="chat-input">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            disabled={busy}
            placeholder="Describe the part, or a change to it…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {busy ? (
            <button type="button" className="chat-send stop" onClick={stop} aria-label="Stop">
              ■
            </button>
          ) : (
            <button type="submit" className="chat-send" disabled={!input.trim()} aria-label="Send">
              ↑
            </button>
          )}
        </div>
      </form>

      <div className="chat-meter">
        <button type="button" onClick={() => setShowSettings((open) => !open)}>
          {settings.model}
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
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
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
      return <div className="msg msg-user">{event.text}</div>
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
    case 'note':
      return <div className={event.tone === 'error' ? 'chat-note bad' : 'chat-note'}>{event.text}</div>
    case 'clear':
      return <div className="chat-rule">cleared</div>
    case 'summary':
      return <div className="chat-rule">compacted</div>
  }
}
