import { useEffect, useMemo, useRef, useState } from 'react'
import { Chat } from './chat/Chat'
import { Compiler, type CompileResult } from './kernel/compile'
import { parseOff, type Mesh } from './kernel/off'
import { meshStats } from './kernel/stats'
import { Editor } from './editor/Editor'
import { ParamsPanel } from './editor/ParamsPanel'
import { Viewport } from './viewer/Viewport'
import { downloadBlob, MIME } from './export/download'
import {
  formatLength, formatVolume, lengthLabel, loadUnits, saveUnits, volumeLabel,
} from './state/units'
import {
  currentDoc, deleteDoc, forkDoc, nameFromFirstPrompt, newDoc, renameDoc, reviveSession,
  selectDoc, updateSource, versionNumbers, type Session,
} from './state/documents'
import { loadAll, persistRequested, saveSession } from './state/store'

const STARTER = `// A mounting plate. Drag the numbers, or edit freely.
$fn = 64;

plate_x = 60;  // [20:120]
plate_y = 40;  // [20:120]
plate_z = 3;   // [1:0.5:10]
hole_d  = 5;   // [2:0.5:12]
inset   = 6;   // [3:20]

difference() {
  cube([plate_x, plate_y, plate_z]);
  for (x = [inset, plate_x - inset], y = [inset, plate_y - inset])
    translate([x, y, -1])
      cylinder(h = plate_z + 2, d = hole_d);
}
`

const DEBOUNCE_MS = 600
/** A 600 ms slider preview is not a preview. */
const DRAG_DEBOUNCE_MS = 30
/** Module-level so its identity is stable across renders. */
const NO_DEFINES: readonly string[] = []

/**
 * Identity of a compile. The defines half is load-bearing: without it,
 * releasing a slider back at its original value would leave the reduced-$fn
 * mesh on screen forever. The separator is a form feed, which cannot appear in
 * a define and would be whitespace in source anyway.
 */
const compileKey = (source: string, defines: readonly string[]): string =>
  defines.join('\f') + '\f' + source

/** Long enough to coalesce a burst of typing, short enough to survive a crash. */
const SAVE_DEBOUNCE_MS = 400

export function App() {
  // null until IndexedDB answers. Nothing compiles before then, so the starter
  // is never compiled and thrown away one frame later.
  const [session, setSession] = useState<Session | null>(null)
  const source = session ? currentDoc(session).source : STARTER
  const setSource = (next: string) =>
    setSession((s) => (s ? updateSource(s, next, Date.now()) : s))
  const [mesh, setMesh] = useState<Mesh | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const [streamSource, setStreamSource] = useState<string | null>(null)
  const [previewDefines, setPreviewDefines] = useState<readonly string[]>(NO_DEFINES)
  const [chatBusy, setChatBusy] = useState(false)
  const [compiles, setCompiles] = useState(0)
  const [fitToken, setFitToken] = useState(0)
  const [units, setUnits] = useState(loadUnits)

  const compiler = useMemo(() => new Compiler(), [])
  useEffect(() => () => compiler.dispose(), [compiler])

  useEffect(() => {
    let live = true
    void (async () => {
      const { session: raw, lastSource } = await loadAll()
      if (!live) return
      // lastSource is the fallback, not the starter: if the session structure is
      // unreadable the user still gets the code they were last working on.
      setSession(reviveSession(raw, lastSource ?? STARTER, crypto.randomUUID(), Date.now()))
      // design.md §7: WebKit drops script-writable storage after 7 days without
      // interaction, and this is silently denied when heuristics are unmet.
      void persistRequested()
    })()
    return () => {
      live = false
    }
  }, [])

  // The debounce is what makes typing cheap; it is also a window in which the
  // last edit exists only in memory. A tab that goes away never runs its
  // pending timeout, so the hidden/unload path writes immediately instead.
  const sessionRef = useRef<Session | null>(null)
  sessionRef.current = session
  useEffect(() => {
    const flush = () => {
      const current = sessionRef.current
      if (!current) return
      void saveSession(current, currentDoc(current).source)
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [])

  useEffect(() => {
    if (!session) return
    const timer = setTimeout(() => {
      void saveSession(session, currentDoc(session).source)
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [session])

  // Guards against an earlier compile resolving after a later one.
  const runIdRef = useRef(0)
  // The key of the compile whose result is currently on screen.
  const appliedKeyRef = useRef<string | null>(null)

  const [exporting, setExporting] = useState<null | 'binstl' | '3mf'>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  /** The single place busy, mesh, ms and error move together. */
  const applyCompiled = (key: string, result: CompileResult) => {
    appliedKeyRef.current = key
    setBusy(false)
    if (result.ok) {
      try {
        setMesh(parseOff(new TextDecoder().decode(result.data)))
        // ms updates only once the mesh has actually been replaced, so every
        // HUD figure describes the same mesh.
        setMs(result.ms)
        setError(null)
        setExportError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } else {
      setError(result.stderr)
    }
    setCompiles((n) => n + 1)
  }

  useEffect(() => {
    if (!session) return
    const key = compileKey(source, previewDefines)
    // FIRST statement, before the run id and before setBusy: a turn commits its
    // source together with the result it already paid for, and recompiling it
    // here would double every turn. Moving this inside the timeout instead
    // would latch the "compiling..." tag forever.
    if (key === appliedKeyRef.current) return

    const runId = ++runIdRef.current
    setBusy(true)
    const timer = setTimeout(
      async () => {
        let result
        try {
          result = await compiler.compile(source, 'off', { defines: previewDefines })
        } catch (e) {
          if (runIdRef.current !== runId) return // superseded
          setBusy(false)
          setError(e instanceof Error ? e.message : String(e))
          return
        }
        if (runIdRef.current !== runId) return // superseded
        // A cancelled compile is not a failure the user should see.
        if (!result.ok && result.cancelled) return
        applyCompiled(key, result)
      },
      previewDefines.length > 0 ? DRAG_DEBOUNCE_MS : DEBOUNCE_MS,
    )

    return () => clearTimeout(timer)
  }, [source, previewDefines, compiler, session])

  const stats = useMemo(() => (mesh ? meshStats(mesh) : null), [mesh])

  // Export runs its own compile so the exported bytes always match the current
  // source, and never reuses the viewport's OFF.
  const exportAs = async (format: 'binstl' | '3mf') => {
    setExporting(format)
    setExportError(null)
    const exporter = new Compiler()
    try {
      const result = await exporter.compile(source, format)
      if (result.ok) {
        downloadBlob(result.data, format === '3mf' ? 'model.3mf' : 'model.stl', MIME[format])
      } else {
        setExportError(result.stderr)
      }
    } finally {
      exporter.dispose()
      setExporting(null)
    }
  }

  // The preview's error marks the HUD stale; an export's error must not. A chat
  // failure reaches neither - it says nothing about the geometry.
  const shownError = error ?? exportError
  // One place that answers "is anything happening", whichever pane started it.
  const working = busy || chatBusy || exporting !== null

  return (
    <div className="app" data-compiles={compiles} data-working={working}>
      <div className="working" aria-hidden={!working} />
      <section className="pane">
        <div className="editor-pane">
          {session && (
            <DocBar
              session={session}
              onChange={(next) => {
                setSession(next)
                setFitToken((n) => n + 1)
              }}
            />
          )}
          <div className="editor-host">
            <Editor value={streamSource ?? source} onChange={setSource} editable={!chatBusy} />
          </div>
          <ParamsPanel
            source={source}
            disabled={chatBusy}
            onPreview={setPreviewDefines}
            onCommit={setSource}
          />
        </div>
      </section>

      <section className="pane view">
        <Viewport mesh={mesh} fitToken={fitToken} />
        <div className="actions">
          <button onClick={() => exportAs('3mf')} disabled={!mesh || !!error || exporting !== null}>
            {exporting === '3mf' ? 'Exporting…' : 'Export 3MF'}
          </button>
          <button
            onClick={() => exportAs('binstl')}
            disabled={!mesh || !!error || exporting !== null}
          >
            {exporting === 'binstl' ? 'Exporting…' : 'Export STL'}
          </button>
        </div>
        <div className="hud">
          {/* Display only: the model, the source and the exported file stay
              metric whatever this says. Deliberately not a .tag — a second
              element whose text contains "mm" resolves the e2e locators to two. */}
          <button
            type="button"
            className="unit-toggle"
            title="Switch display units. The model itself is always millimetres."
            onClick={() => {
              const next = units === 'mm' ? 'in' : 'mm'
              setUnits(next)
              saveUnits(next)
            }}
          >
            {units === 'mm' ? 'metric' : 'imperial'}
          </button>
          {busy && <span className="tag busy">compiling…</span>}
          {!busy && ms !== null && <span className="tag">{ms} ms</span>}
          {stats && (
            <span className={error ? 'stats stale' : 'stats'}>
              <span className="tag">
                {stats.size.map((n) => formatLength(n, units)).join(' × ')} {lengthLabel(units)}
              </span>
              <span className="tag">{stats.triangles.toLocaleString()} tris</span>
              <span className="tag">
                {stats.volume === null
                  ? 'not watertight'
                  : `${formatVolume(stats.volume, units)} ${volumeLabel(units)}`}
              </span>
            </span>
          )}
        </div>
        {shownError && <pre className="error">{shownError}</pre>}
      </section>

      <section className="pane">
        <Chat
          // Remounts on a document switch: the conversation was about the part
          // that just left the screen.
          key={session?.currentId ?? 'boot'}
          source={source}
          units={units}
          onPrompt={(text) =>
            setSession((s) => (s ? nameFromFirstPrompt(s, text) : s))
          }
          onStreamSource={setStreamSource}
          onApply={(next, result) => {
            setSource(next)
            applyCompiled(compileKey(next, NO_DEFINES), result)
            setFitToken((n) => n + 1)
          }}
          onExport={exportAs}
          onBusyChange={setChatBusy}
        />
      </section>
    </div>
  )
}

/**
 * Documents, and versions of them. A version IS a document that records its
 * parent (design.md §7), so switching to an older one opens its source — which
 * is the whole recovery guarantee, and why there is no separate timeline.
 */
function DocBar({
  session,
  onChange,
}: {
  session: Session
  onChange: (next: Session) => void
}) {
  const doc = currentDoc(session)
  const now = () => Date.now()
  // Once for the list, not once per row: per-row numbering is what made this
  // O(n^3) and 130 ms at 200 versions.
  const versions = versionNumbers(session)

  return (
    <div className="docbar">
      <select
        aria-label="Document"
        value={session.currentId}
        onChange={(e) => onChange(selectDoc(session, e.target.value))}
      >
        {session.docs.map((d) => {
          const version = versions.get(d.id)
          return (
            <option key={d.id} value={d.id}>
              {d.name}
              {version === undefined ? '' : ` · v${version}`}
            </option>
          )
        })}
      </select>
      <button
        type="button"
        title="Start a new, empty document"
        onClick={() =>
          onChange({
            docs: [...session.docs, newDoc('Untitled', '', crypto.randomUUID(), now())],
            currentId: session.docs[session.docs.length - 1]?.id ?? session.currentId,
          })
        }
      >
        New
      </button>
      <button
        type="button"
        title="Copy this document as a new version, leaving this one untouched"
        onClick={() => onChange(forkDoc(session, doc.id, crypto.randomUUID(), now()))}
      >
        Version
      </button>
      <button
        type="button"
        title="Rename this document"
        onClick={() => {
          // ponytail: the platform's own dialog. A rename popover is UI to
          // maintain for something done once per document.
          const name = window.prompt('Name this document', doc.name)
          if (name !== null) onChange(renameDoc(session, doc.id, name))
        }}
      >
        Rename
      </button>
      <button
        type="button"
        title="Delete this document"
        onClick={() => {
          if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return
          onChange(deleteDoc(session, doc.id, crypto.randomUUID(), now()))
        }}
      >
        Delete
      </button>
    </div>
  )
}
