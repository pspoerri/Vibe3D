import { useEffect, useMemo, useRef, useState } from 'react'
import { Chat } from './chat/Chat'
import { COMMANDS } from './chat/commands'
import { constructionSource } from './chat/parts'
import { Help } from './help/Help'
import { Compiler, type CompileResult } from './kernel/compile'
import { parseOff, type Mesh } from './kernel/off'
import { meshStats } from './kernel/stats'
import { ComponentsPanel } from './editor/ComponentsPanel'
import { Editor } from './editor/Editor'
import { ParamsPanel } from './editor/ParamsPanel'
import { Viewport } from './viewer/Viewport'
import { selectPart, type Selection } from './viewer/select'
import { downloadBlob, EXTENSION, MIME, type DownloadFormat } from './export/download'
import { encodeObj } from './export/obj'
import { encodeStl } from './export/stl'
import { paint3mf } from './export/threemf'
import {
  formatLength, formatVolume, lengthLabel, loadUnits, saveUnits, volumeLabel,
} from './state/units'
import {
  addComponent, commitEdit, commitTurn, currentDoc, deleteDoc, headVersion, nameFromFirstPrompt,
  nameFromFirstTurn, newDoc, removeComponent,
  renameDoc, restoreVersion, reviveSession, saveVersion, selectDoc, setChat, undoVersion,
  suggestName, updateSource, UNTITLED, type Component, type Session,
} from './state/documents'
import { exportProject, importProject } from './state/project'
import { loadAll, persistRequested, saveSession } from './state/store'
import { EXAMPLES, STARTER } from './examples'

/** Injected by vite.config.ts: the package.json version, and the short commit hash — empty on the release tag itself. */
declare const __APP_VERSION__: string
declare const __APP_COMMIT__: string
const REPO_URL = 'https://github.com/pspoerri/Vibe3D'


const DEBOUNCE_MS = 600
/** A 600 ms slider preview is not a preview. */
const DRAG_DEBOUNCE_MS = 30
/** Module-level so their identity is stable across renders. */
const NO_DEFINES: readonly string[] = []
const NO_COMPONENTS: readonly Component[] = []

/**
 * Identity of a compile. The defines half is load-bearing: without it,
 * releasing a slider back at its original value would leave the reduced-$fn
 * mesh on screen forever. The files half is what makes attaching a mesh the
 * source already imports recompile it. The separator is a form feed, which
 * cannot appear in a define or a file name and would be whitespace in source.
 */
const compileKey = (
  source: string,
  defines: readonly string[],
  components: readonly Component[] = NO_COMPONENTS,
): string =>
  components.map((c) => `${c.name}:${c.bytes.length}`).join('\f') + '\f' + defines.join('\f') + '\f' + source

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
  // Stable across session updates that do not touch them, so the memo holds.
  const components = session ? currentDoc(session).components : NO_COMPONENTS
  /** The kernel FS view of the components, beside /in.scad so a bare name imports. */
  const files = useMemo(
    () => Object.fromEntries(components.map((c) => [`/${c.name}`, c.bytes])),
    [components],
  )
  const [mesh, setMesh] = useState<Mesh | null>(null)
  /** Construction geometry (design.md §8): the `%` shapes, compiled on their own, drawn as a ghost. */
  const [ghost, setGhost] = useState<Mesh | null>(null)
  /** A turn's latest candidate that compiled: on screen while the turn runs, gone when it ends. */
  const [turnMesh, setTurnMesh] = useState<Mesh | null>(null)
  const shown = turnMesh ?? mesh
  // The part the user clicked. Dropped with the mesh: a recompile may have
  // changed which part is which.
  const [selected, setSelected] = useState<Selection | null>(null)
  useEffect(() => setSelected(null), [shown])
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
  /** In transit from the viewport's Draw mode to the chat's tray. */
  const [markup, setMarkup] = useState<string | null>(null)
  const [units, setUnits] = useState(loadUnits)
  // The launcher is the entry point: nothing is open until a document is picked.
  const [open, setOpen] = useState(false)
  const [help, setHelp] = useState(false)
  // design.md §7: what the browser actually granted, not what was asked for.
  const [durable, setDurable] = useState(true)

  const compiler = useMemo(() => new Compiler(), [])
  useEffect(() => () => compiler.dispose(), [compiler])
  // Its own kernel: compile() cancels whatever that instance has in flight,
  // and the ghost must never cancel the part, nor the part the ghost.
  const ghostCompiler = useMemo(() => new Compiler(), [])
  useEffect(() => () => ghostCompiler.dispose(), [ghostCompiler])

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

  const [exporting, setExporting] = useState<DownloadFormat | null>(null)
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

  // Depends on `ready` and the document id, not `session`: a chat event or a
  // version commit changes the session without changing the source, and must
  // not restart a compile that is already in flight.
  const currentId = session?.currentId ?? null
  const docRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ready) return
    // A document switch. What is on screen belongs to the document that just
    // left, and must not sit under the new one until its compile lands —
    // seconds on a cold kernel, forever when the new source does not compile.
    // The identity guard resets too, or a document switched back to before its
    // predecessor's compile landed would never compile again.
    if (docRef.current !== currentId) {
      docRef.current = currentId
      appliedKeyRef.current = null
      setMesh(null)
      setBefore(null)
      setMs(null)
      setError(null)
    }
    const key = compileKey(source, previewDefines, components)
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
          result = await compiler.compile(source, 'off', { defines: previewDefines, files })
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
  }, [source, previewDefines, components, files, compiler, ready, currentId])

  // The construction section, if any, compiled without its parts. A failure
  // just means no ghost: the part's own compile reports the error.
  const ghostSource = useMemo(() => constructionSource(source), [source])
  const ghostDocRef = useRef(currentId)
  useEffect(() => {
    if (ghostDocRef.current !== currentId) {
      ghostDocRef.current = currentId
      setGhost(null)
    }
    if (!ready || ghostSource === null) {
      setGhost(null)
      return
    }
    let live = true
    const timer = setTimeout(async () => {
      try {
        const result = await ghostCompiler.compile(ghostSource, 'off', { defines: previewDefines, files })
        if (!live) return
        setGhost(result.ok ? parseOff(new TextDecoder().decode(result.data)) : null)
      } catch {
        if (live) setGhost(null)
      }
    }, previewDefines.length > 0 ? DRAG_DEBOUNCE_MS : DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [ghostSource, previewDefines, files, ghostCompiler, ready, currentId])

  const stats = useMemo(() => (shown ? meshStats(shown) : null), [shown])

  // Export runs its own compile so the exported bytes always match the current
  // source, and never reuses the viewport's OFF. The file is named after the
  // document, like the project file.
  const exportAs = async (format: DownloadFormat) => {
    setExporting(format)
    setExportError(null)
    const name = fileName(session ? currentDoc(session).name : UNTITLED)
    const exporter = new Compiler()
    try {
      // STL and OBJ are written here from the OFF, so colour comes along —
      // per facet in the STL, as an MTL beside the OBJ. The kernel's own
      // writers of both have none. 3MF comes from the kernel with its
      // materials, and gets the slicers' per-triangle painting added.
      const result = await exporter.compile(source, format === '3mf' ? format : 'off', { files })
      if (result.ok) {
        const filename = `${name}.${EXTENSION[format]}`
        if (format === '3mf') downloadBlob(paint3mf(result.data), filename, MIME[format])
        else {
          const mesh = parseOff(new TextDecoder().decode(result.data))
          if (format === 'binstl') downloadBlob(encodeStl(mesh), filename, MIME[format])
          else {
            const { obj, mtl } = encodeObj(mesh, name)
            downloadBlob(obj, filename, MIME[format])
            if (mtl) downloadBlob(mtl, `${name}.mtl`, 'model/mtl')
          }
        }
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
        atStart={!open}
        busy={chatBusy}
        onChange={(next) => {
          setSession(next)
          setFitToken((n) => n + 1)
        }}
        onOpen={() => setOpen(false)}
        onHelp={() => setHelp((h) => !h)}
      />

      {session && help && <Help onClose={() => setHelp(false)} />}

      {session && !open && (
        <StartWindow
          session={session}
          durable={durable}
          onOpen={(id) => {
            // Functional, because "New document" and the examples create the
            // document and open it in the same click: the render's `session`
            // does not have it yet, and selectDoc on that would drop it.
            setSession((s) => (s ? selectDoc(s, id) : s))
            setFitToken((n) => n + 1)
            setOpen(true)
          }}
          onChange={setSession}
        />
      )}

      <div className="panes">
      <section className="pane side">
        <div className="editor-pane">
          <div className="editor-host">
            {/* Remounts on a document switch, like the chat pane: a fresh
                CodeMirror state, so undo cannot replay the switch and put the
                previous document's source — or the boot-time starter — into
                this one. A turn's whole-document replace stays undoable. */}
            <Editor
              key={session?.currentId ?? 'boot'}
              value={streamSource ?? source}
              onChange={setSource}
              editable={!chatBusy}
            />
          </div>
          <ParamsPanel
            source={source}
            disabled={chatBusy}
            onPreview={setPreviewDefines}
            onCommit={setSource}
          />
          {session && (
            <ComponentsPanel
              components={components}
              units={units}
              disabled={chatBusy}
              onAdd={(c) => setSession((s) => (s ? addComponent(s, c, Date.now()) : s))}
              onRemove={(name) => setSession((s) => (s ? removeComponent(s, name, Date.now()) : s))}
            />
          )}
        </div>
      </section>

      <section className="pane view">
        <Viewport
          mesh={shown}
          ghost={ghost}
          fitToken={fitToken}
          highlight={selected?.triangles ?? null}
          onPick={(triangle) => setSelected(triangle !== null && shown ? selectPart(shown, triangle) : null)}
          onMarkup={setMarkup}
        />
        <div className="actions">
          {(['3mf', 'binstl', 'obj'] as const).map((format) => (
            <button
              key={format}
              onClick={() => exportAs(format)}
              disabled={!mesh || !!error || exporting !== null}
            >
              {exporting === format ? 'Exporting…' : `Export ${EXTENSION[format].toUpperCase()}`}
            </button>
          ))}
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
          {busy && (
            <span className="tag busy">
              <span className="spinner" aria-hidden="true" />
              compiling…
            </span>
          )}
          {turnMesh && <span className="tag busy" title="The turn's latest version that compiled; not committed yet">candidate</span>}
          {!busy && ms !== null && <span className="tag">{ms} ms</span>}
          {stats && (
            <span className={error ? 'stats stale' : 'stats'}>
              <span className="tag">
                {stats.size.map((n) => formatLength(n, units)).join(' × ')} {lengthLabel(units)}
              </span>
              <span className="tag">{stats.triangles.toLocaleString()} tris</span>
              {stats.parts > 1 && <span className="tag">{stats.parts} parts</span>}
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

      <section className="pane side right">
        <Chat
          // Remounts on a document switch: the conversation was about the part
          // that just left the screen, and the new one brings its own.
          key={session?.currentId ?? 'boot'}
          source={source}
          files={files}
          components={components}
          selection={selected}
          onClearSelection={() => setSelected(null)}
          markup={markup}
          onClearMarkup={() => setMarkup(null)}
          construction={ghost}
          onCandidate={setTurnMesh}
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
            setSession((s) =>
              s ? nameFromFirstTurn(commitTurn(s, next, label, result.ok, Date.now()), next) : s,
            )
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
  atStart,
  busy,
  onChange,
  onOpen,
  onHelp,
}: {
  session: Session | null
  /** The start window is up: no document is on screen, so no document controls. */
  atStart: boolean
  /** A turn owns the document: nothing here may move its head under it. */
  busy: boolean
  onChange: (next: Session) => void
  onOpen: () => void
  onHelp: () => void
}) {
  const doc = !atStart && session ? currentDoc(session) : null
  const fileRef = useRef<HTMLInputElement>(null)

  return (
    <div className="menubar">
      <button type="button" className="brand" title="Back to the start window" onClick={onOpen} disabled={!session || atStart}>
        Vibe3D
      </button>
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
      <button type="button" onClick={onOpen} disabled={!session || atStart}>
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
          // What was open is gone; whichever neighbour became current was not
          // chosen by the user, so the start window is where to pick next.
          onOpen()
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
      {/* Hover (or focus) lists the commands; a click opens the manual. Pure
          CSS: the popover is in the DOM whenever the bar is, hidden by :hover. */}
      <span className="menu-help">
        <button type="button" onClick={onHelp} title="Open the manual">
          Help
        </button>
        <div className="help-pop" role="tooltip">
          <b>Commands</b> — type them in the chat
          <dl>
            {COMMANDS.map((c) => (
              <div key={c.usage}>
                <dt>{c.usage}</dt>
                <dd>{c.what}</dd>
              </div>
            ))}
          </dl>
          <span className="help-pop-hint">
            Enter sends, Shift+Enter breaks a line. Click a part in the viewport to talk about it.
            Click Help for the manual.
          </span>
        </div>
      </span>
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
  const create = (name: string, source: string): void => {
    const id = crypto.randomUUID()
    onChange({ docs: [...session.docs, newDoc(name, source, id, Date.now())], currentId: id })
    onOpen(id)
  }

  return (
    <div className="start">
      <div className="start-card">
        <h1>
          Vibe3D
          <img className="start-icon" src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" />
        </h1>
        <p className="start-tag">Prompt a parametrized 3D model - leveraging your own tokens.</p>

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

        <button type="button" className="start-new" onClick={() => create(UNTITLED, '')}>
          New document
        </button>
        <p className="start-examples">
          Or start from an example:
          {EXAMPLES.map((ex) => (
            <button
              type="button"
              key={ex.name}
              className="start-new"
              onClick={() =>
                create(suggestName(ex.source, session.docs.map((d) => d.name)), ex.source)
              }
            >
              {ex.name}
            </button>
          ))}
        </p>
        <p className="start-footer">
          <a
            href={__APP_COMMIT__ ? `${REPO_URL}/commit/${__APP_COMMIT__}` : `${REPO_URL}/releases/tag/v${__APP_VERSION__}`}
            target="_blank"
            rel="noreferrer"
          >
            v{__APP_VERSION__}
            {__APP_COMMIT__ && `+${__APP_COMMIT__}`}
          </a>
          {' · '}
          <a href={REPO_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </p>
      </div>
    </div>
  )
}
