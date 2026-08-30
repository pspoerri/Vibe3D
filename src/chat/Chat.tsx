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
import { stubFences } from './fence'
import type { ChatEvent } from './log'
import { SYSTEM_PROMPT } from './prompt'

const REVOKE_HOME = 'https://openrouter.ai/settings/keys'

export function Chat({
  source,
  onStreamSource,
  onApply,
  onExport,
  onBusyChange,
}: {
  source: string
  onStreamSource: (partial: string | null) => void
  onApply: (next: string, result: CompileResult) => void
  onExport: (format: 'binstl' | '3mf') => void
  onBusyChange: (busy: boolean) => void
}) {
  const [log, setLog] = useState<ChatEvent[]>([])
  const [turn, setTurn] = useState(1)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [settings, setSettings] = useState(loadSettings)
  const [apiKey, setApiKey] = useState(loadKey)
  const [models, setModels] = useState<readonly ModelInfo[]>([])
  const [showSettings, setShowSettings] = useState(() => loadKey() === '')
  const [revoke, setRevoke] = useState(REVOKE_HOME)

  // Refs, not state, wherever a value is read inside an async turn: the turn
  // closes over its render's values, and a stale log would re-send history.
  const busyRef = useRef(false)
  const logRef = useRef(log)
  logRef.current = log
  const usageRef = useRef<Usage | null>(null)
  const compactedRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

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
  }, [log, thinking])

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
    if (!showSettings) return
    fetchModels(settings.baseUrl)
      .then(setModels)
      .catch(() => setModels([]))
  }, [showSettings, settings.baseUrl])

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
      { log: logRef.current, turn, systemPrompt: SYSTEM_PROMPT, source },
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
    const controller = new AbortController()
    abortRef.current = controller
    busyRef.current = true
    setBusy(true)
    setThinking(true)
    onBusyChange(true)

    try {
      const outcome = await runTurn(
        { userText: text, log: logRef.current, turn, systemPrompt: SYSTEM_PROMPT, source },
        {
          stream: (messages, signal) =>
            streamChat(messages, signal, {
              baseUrl: settings.baseUrl,
              apiKey,
              model: settings.model,
            }),
          compile: (candidate) => compiler.compile(candidate),
          append,
          onDraft: (partial) => {
            if (partial !== null) setThinking(false)
            onStreamSource(partial)
          },
          onUsage: (usage) => {
            usageRef.current = usage
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
        {thinking && <div className="chat-note">thinking…</div>}
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
        <textarea
          rows={2}
          value={input}
          disabled={busy}
          placeholder="a 40 mm knob with a 6 mm D-shaft…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>

      <div className="chat-settings">
        <div className="row">
          <button type="button" onClick={() => setShowSettings((open) => !open)}>
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
          <span className="chat-hint">{settings.model}</span>
        </div>

        {showSettings && (
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
              The key is stored in this browser only, under <code>aimodeller.key</code>. Revoke it
              at <a href={revoke} target="_blank" rel="noreferrer">openrouter.ai</a>. This app
              cannot set a spend cap — that is a manual step in your OpenRouter settings.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function ChatEventView({ event }: { event: ChatEvent }) {
  switch (event.kind) {
    case 'user':
      return <div className="msg msg-user">{event.text}</div>
    case 'assistant':
      return (
        <div className="msg msg-assistant">
          {/* The source itself is in the editor; repeating it here just pushes
              the prose that explains it off screen. */}
          {stubFences(event.text)}
          {event.stopped && <span className="chat-note"> (stopped)</span>}
        </div>
      )
    case 'compile':
      // Raw stderr, exactly what the model was handed — if the loop is
      // repairing against a bad diagnostic, the user should be able to see it.
      return event.ok ? (
        <div className="chat-note">compiled in {event.ms} ms</div>
      ) : (
        <pre className="chat-stderr">{event.stderr}</pre>
      )
    case 'note':
      return <div className={event.tone === 'error' ? 'chat-note bad' : 'chat-note'}>{event.text}</div>
    case 'clear':
      return <div className="chat-note">— cleared —</div>
    case 'summary':
      return <div className="chat-note">— compacted —</div>
  }
}
