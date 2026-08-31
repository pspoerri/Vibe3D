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
  commitEdit, commitTurn, currentDoc, deleteDoc, headVersion, nameFromFirstPrompt, newDoc,
  renameDoc, restoreVersion, reviveSession, saveVersion, selectDoc, setChat, undoVersion,
  updateSource, UNTITLED, type Session,
} from './state/documents'
import { exportProject, importProject } from './state/project'
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
  const ready = session !== null
  const source = session ? currentDoc(session).source : STARTER
  const setSource = (next: string) =>
    setSession((s) => (s ? updateSource(s, next, Date.now()) : s))
  const [mesh, setMesh] = useState<Mesh | null>(null)
  // design.md §6: the "was" of a turn's inspection. Only a define-free compile
  // or a turn sets it, so a slider drag's reduced-$fn preview is never the before.
  const [before, setBefore] = useState<Uint8Array | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const [streamSource, setStreamSource] = useState<string | null>(null)
  const [previewDefines, setPreviewDefines] = useState<readonly string[]>(NO_DEFINES)
  const [chatBusy, setChatBusy] = useState(false)
  const [compiles, setCompiles] = useState(0)
  const [fitToken, setFitToken] = useState(0)
  const [units, setUnits] = useState(loadUnits)
  // The launcher is the entry point: nothing is open until a document is picked.
  const [open, setOpen] = useState(false)
  // design.md §7: what the browser actually granted, not what was asked for.
  const [durable, setDurable] = useState(true)

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
      // WebKit drops script-writable storage after 7 days without interaction,
      // and the request is silently denied when heuristics are unmet.
      const granted = await persistRequested()
      if (live) setDurable(granted)
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

  // Depends on `ready`, not `session`: a chat event or a version commit changes
  // the session without changing the source, and must not restart a compile
  // that is already in flight.
  useEffect(() => {
    if (!ready) return
    const key = compileKey(source, previewDefines)
    // FIRST statement, before the run id and before setBusy: a turn commits its
    // source together with the result it already paid for, and recompiling it
    // here would double every turn. Moving this inside the timeout instead
    // would latch the "compiling..." tag forever.
    if (key === appliedKeyRef.current) return

    // A blank document has nothing to compile, and would otherwise show the
    // kernel's "top level object is empty" as an error for having done nothing.
    if (source.trim() === '') {
      appliedKeyRef.current = key
      setBusy(false)
      setMesh(null)
      setError(null)
      setMs(null)
      return
    }

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
        // design.md §7 (c): a successful compile of manual edits is a version.
        if (result.ok && previewDefines.length === 0) {
          setBefore(result.data)
          setSession((s) => (s ? commitEdit(s, source, Date.now()) : s))
        }
      },
      previewDefines.length > 0 ? DRAG_DEBOUNCE_MS : DEBOUNCE_MS,
    )

    return () => clearTimeout(timer)
  }, [source, previewDefines, compiler, ready])

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

      <MenuBar
        session={session}
        busy={chatBusy}
        onChange={(next) => {
          setSession(next)
          setFitToken((n) => n + 1)
        }}
        onOpen={() => setOpen(false)}
      />

      {session && !open && (
        <StartWindow
          session={session}
          durable={durable}
          onOpen={(id) => {
            setSession(selectDoc(session, id))
            setFitToken((n) => n + 1)
            setOpen(true)
          }}
          onChange={setSession}
        />
      )}

      <div className="panes">
      <section className="pane">
        <div className="editor-pane">
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
          // that just left the screen, and the new one brings its own.
          key={session?.currentId ?? 'boot'}
          source={source}
          before={before}
          units={units}
          initialLog={session ? currentDoc(session).chat : []}
          onLogChange={(log) => setSession((s) => (s ? setChat(s, log) : s))}
          onPrompt={(text) =>
            setSession((s) => (s ? nameFromFirstPrompt(s, text) : s))
          }
          onStreamSource={setStreamSource}
          onApply={(next, result, label) => {
            // A preview compile still in flight would land on top of this and
            // put a stale mesh under the new source.
            compiler.cancel()
            setSession((s) => (s ? commitTurn(s, next, label, result.ok, Date.now()) : s))
            applyCompiled(compileKey(next, NO_DEFINES), result)
            if (result.ok) setBefore(result.data)
            setFitToken((n) => n + 1)
          }}
          onUndo={() => {
            const s = sessionRef.current
            if (!s) return null
            const next = undoVersion(s, Date.now())
            if (next === s) return null
            setSession(next)
            setFitToken((n) => n + 1)
            return `Restored v${headVersion(currentDoc(next)).id}.`
          }}
          onExport={exportAs}
          onBusyChange={setChatBusy}
        />
      </section>
      </div>
    </div>
  )
}

/** "5 minutes ago" from a timestamp, via the platform's own formatter. */
const STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60_000, 'minute'],
  [3_600_000, 'hour'],
  [86_400_000, 'day'],
]
const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
function whenEdited(ts: number): string {
  const ago = Date.now() - ts
  if (ago < 60_000) return 'just now'
  for (const [size, unit] of STEPS) {
    if (ago < size * 60 || unit === 'day') return RELATIVE.format(-Math.floor(ago / size), unit)
  }
  return RELATIVE.format(-Math.floor(ago / 86_400_000), 'day')
}

/** A document name as a file name. */
const fileName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, '_')

/**
 * New / Open / versions / Rename / Delete / project file, and the name of what
 * is open. Open returns to the start window, which is the document list — one
 * screen rather than a picker plus a launcher that would both list the same rows.
 */
function MenuBar({
  session,
  busy,
  onChange,
  onOpen,
}: {
  session: Session | null
  /** A turn owns the document: nothing here may move its head under it. */
  busy: boolean
  onChange: (next: Session) => void
  onOpen: () => void
}) {
  const doc = session ? currentDoc(session) : null
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="menubar">
      <span className="brand">Vibe3D</span>
      <button
        type="button"
        disabled={!session}
        onClick={() => {
          if (!session) return
          const id = crypto.randomUUID()
          onChange({
            docs: [...session.docs, newDoc(UNTITLED, '', id, Date.now())],
            currentId: id,
          })
        }}
      >
        New
      </button>
      <button type="button" onClick={onOpen} disabled={!session}>
        Open
      </button>
      <button
        type="button"
        title="Keep what is in the editor as a version of its own"
        disabled={!session || !doc || busy}
        onClick={() => session && onChange(saveVersion(session, Date.now()))}
      >
        Save version
      </button>
      {session && doc && (
        <select
          className="menubar-versions"
          aria-label="Version"
          title="Every LLM turn, save and edit is a version. Pick one to go back to it."
          value={doc.head}
          disabled={busy}
          onChange={(e) => onChange(restoreVersion(session, e.target.value, Date.now()))}
        >
          {doc.versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.id} · {v.label}
              {v.compileOk ? '' : ' ✗'}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        disabled={!session || !doc}
        onClick={() => {
          if (!session || !doc) return
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
        disabled={!session || !doc}
        onClick={() => {
          if (!session || !doc) return
          if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return
          onChange(deleteDoc(session, doc.id, crypto.randomUUID(), Date.now()))
        }}
      >
        Delete
      </button>
      <button
        type="button"
        title="One .json with the source, every version and the conversation — never the key"
        disabled={!doc}
        onClick={() =>
          doc &&
          downloadBlob(
            new TextEncoder().encode(exportProject(doc)),
            `${fileName(doc.name)}.json`,
            'application/json',
          )
        }
      >
        Export project
      </button>
      <button type="button" disabled={!session} onClick={() => fileRef.current?.click()}>
        Import project
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          // So the same file can be picked twice in a row.
          e.target.value = ''
          if (!file || !session) return
          void file.text().then((text) => {
            try {
              const imported = importProject(
                text,
                crypto.randomUUID(),
                Date.now(),
                session.docs.map((d) => d.name),
              )
              onChange({ docs: [...session.docs, imported], currentId: imported.id })
            } catch (error) {
              window.alert(error instanceof Error ? error.message : String(error))
            }
          })
        }}
      />
      {doc && <span className="menubar-doc">{doc.name}</span>}
    </div>
  )
}

/**
 * The launcher. Documents, most recently edited first, because the top row is
 * almost always the thing you were in the middle of.
 */
function StartWindow({
  session,
  durable,
  onOpen,
  onChange,
}: {
  session: Session
  durable: boolean
  onOpen: (id: string) => void
  onChange: (next: Session) => void
}) {
  const rows = [...session.docs].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="start">
      <div className="start-card">
        <h1>Vibe3D</h1>
        <p className="start-tag">
          Vibe 3D Models: Bring your own tokens. Leverages your LLM along with OpenSCAD to build
          your ideas into a 3D Model.
        </p>

        <ul className="start-list">
          {rows.map((d) => (
            <li key={d.id}>
              <button type="button" className="start-open" onClick={() => onOpen(d.id)}>
                <span className="start-name">{d.name}</span>
                {d.versions.length > 1 && <span className="start-ver">v{d.versions.length}</span>}
                <span className="start-when">{whenEdited(d.updatedAt)}</span>
              </button>
              <button
                type="button"
                className="start-del"
                aria-label={`Delete ${d.name}`}
                onClick={() => {
                  if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return
                  onChange(deleteDoc(session, d.id, crypto.randomUUID(), Date.now()))
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        {!durable && (
          <p className="start-durability">
            This browser may evict local data when it needs space. Export anything you want to
            keep.
          </p>
        )}

        <button
          type="button"
          className="start-new"
          onClick={() => {
            const id = crypto.randomUUID()
            onChange({
              docs: [...session.docs, newDoc(UNTITLED, '', id, Date.now())],
              currentId: id,
            })
            onOpen(id)
          }}
        >
          New document
        </button>
      </div>
    </div>
  )
}
