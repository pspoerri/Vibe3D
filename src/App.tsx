import { useEffect, useMemo, useRef, useState } from 'react'
import { Chat } from './chat/Chat'
import { COMMANDS } from './chat/commands'
import { constructionSource } from './chat/parts'
import { Help } from './help/Help'
import { Compiler, type CompileResult } from './kernel/compile'
import { kernelWarnings } from './kernel/noise'
import { parseOff, type Mesh } from './kernel/off'
import { meshStats } from './kernel/stats'
import { ComponentsPanel } from './editor/ComponentsPanel'
import { Editor, errorLineOf } from './editor/Editor'
import { ParamsPanel } from './editor/ParamsPanel'
import { Viewport } from './viewer/Viewport'
import { selectPart, type Selection } from './viewer/select'
import { downloadBlob, EXTENSION, MIME, type DownloadFormat } from './export/download'
import { ExportDialog, HistoryPanel, versionTitle, VersionDiff } from './dialogs'
import { StartWindow, type EditTab, type Opening } from './Start'
import { fitsBed } from './state/printers'
import { takePrompt } from './llm/auth'
import { fileName, Menu } from './ui'
import { encodeObj } from './export/obj'
import { encodeStl } from './export/stl'
import { paint3mf } from './export/threemf'
import { part3mf, partMesh } from './export/part'
import { renderThumb } from './viewer/capture'
import { boxOf } from './viewer/inspect'
import { decodeShare, encodeShare } from './state/share'
import {
  formatLength, formatVolume, lengthLabel, loadUnits, saveUnits, volumeLabel, type Units,
} from './state/units'
import {
  addComponent, commitEdit, commitTurn, currentDoc, deleteDoc, headVersion, nameFromFirstPrompt,
  nameFromFirstTurn, newDoc, removeComponent,
  renameDoc, restoreVersion, reviveSession, saveVersion, selectDoc, setCache, setChat, setThumb, undoVersion,
  suggestName, updateSource, UNTITLED, type Component, type Session,
} from './state/documents'
import { exportProject, importProject } from './state/project'
import { loadAll, persistRequested, saveSession } from './state/store'
import { loadSettings } from './state/settings'
import { exampleFromHash, STARTER } from './examples'


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

/** The edit pane stays as the user left it: open or not, and on which tab. */
const PANE_KEY = 'vibe3d.editPane'
const TAB_KEY = 'vibe3d.editTab'
const storedPane = (): boolean | null => {
  const v = localStorage.getItem(PANE_KEY)
  return v === null ? null : v === 'open'
}
/** Mobile: one pane at a time, full height. */
type MobileTab = 'model' | 'chat' | 'edit'
/** A compile time as the status pill reads it. */
const took = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)

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
  /** What the kernel warned about on the last successful compile: an unknown variable, a non-manifold hint. */
  const [warnings, setWarnings] = useState<string | null>(null)
  /** The build volume from the settings, mirrored here for the plate outline. */
  const [bed, setBed] = useState<readonly [number, number, number]>(() => loadSettings().bed)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const [streamSource, setStreamSource] = useState<string | null>(null)
  const [previewDefines, setPreviewDefines] = useState<readonly string[]>(NO_DEFINES)
  const [chatBusy, setChatBusy] = useState(false)
  const [compiles, setCompiles] = useState(0)
  const [fitToken, setFitToken] = useState(0)
  /** In transit from the viewport's Draw mode to the chat's tray. */
  const [markup, setMarkup] = useState<string | null>(null)
  const [units, setUnitsState] = useState(loadUnits)
  const setUnits = (next: Units) => {
    setUnitsState(next)
    saveUnits(next)
  }
  // The launcher is the entry point: nothing is open until a document is picked.
  const [open, setOpen] = useState(false)
  // Unset is a first visit: the pane starts closed for someone who has no
  // documents yet, and open for everyone who had it before it was remembered.
  const [editOpen, setEditOpen] = useState(() => storedPane() ?? false)
  const [editTab, setEditTab] = useState<EditTab>(() => (localStorage.getItem(TAB_KEY) === 'code' ? 'code' : 'params'))
  const showEditor = (tab: EditTab) => {
    setEditTab(tab)
    setEditOpen(true)
    localStorage.setItem(TAB_KEY, tab)
    localStorage.setItem(PANE_KEY, 'open')
  }
  const [tab, setTab] = useState<MobileTab>('model')
  const codeRef = useRef<HTMLElement>(null)
  const [help, setHelp] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  /** The History row to open with: a chat card's Changes names its version. */
  const [historyFocus, setHistoryFocus] = useState<string | null>(null)
  /** The version whose full diff is up, if any. */
  const [diffOf, setDiffOf] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  /** A start-window prompt in transit to the new document's chat, which sends it on mount. */
  const [prompt, setPrompt] = useState<{ text: string; images: readonly string[] } | null>(null)
  /** What the chat is connected to, for the start window's top bar; null for nothing yet. */
  const [connected, setConnected] = useState<string | null>(null)
  /** Bumped to make the chat open its connect dialog. */
  const [connectToken, setConnectToken] = useState(0)
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
      if (storedPane() === null) {
        // Decided once: written, or the second visit would read a session and flip it open.
        const first = raw === null || raw === undefined
        setEditOpen(!first)
        localStorage.setItem(PANE_KEY, first ? 'closed' : 'open')
      }
      let revived = reviveSession(raw, lastSource ?? STARTER, crypto.randomUUID(), Date.now())
      // A share link or an `#example=` link: its source becomes a document of
      // its own, opened at once.
      const linked = (await decodeShare(location.hash)) ?? exampleFromHash(location.hash)
      if (linked !== null) {
        const id = crypto.randomUUID()
        const name = suggestName(linked, revived.docs.map((d) => d.name))
        revived = { docs: [...revived.docs, newDoc(name, linked, id, Date.now())], currentId: id }
        history.replaceState(null, '', location.pathname + location.search)
        setOpen(true)
      }
      // A reload or a bookmark: `#<id>` lands on that document, not the start window.
      const wanted = location.hash.slice(1)
      if (revived.docs.some((d) => d.id === wanted)) {
        revived = selectDoc(revived, wanted)
        setOpen(true)
        // Back from sign-in with a message that was waiting: the chat sends it once the key is in.
        const stashed = takePrompt()
        if (stashed) setPrompt({ text: stashed, images: [] })
      }
      if (!live) return
      setSession(revived)
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

  const docName = open && session ? currentDoc(session).name : null
  useEffect(() => {
    document.title = docName ? `${docName} · Vibe3D` : 'Vibe3D'
  }, [docName])

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

  /** A small render of the mesh for the start window, filed under the document it came from. */
  const thumbnail = (mesh: Mesh, docId: string | null): void => {
    if (!docId || mesh.triangleCount === 0) return
    void renderThumb(mesh, boxOf(meshStats(mesh))).then((blob) => {
      if (blob) setSession((s) => (s ? setThumb(s, docId, blob) : s))
    })
  }

  /** A compile's bytes, filed under the document, so reopening it shows the mesh without the kernel. */
  const cacheMesh = (key: string, off: Uint8Array, docId: string | null): void => {
    if (docId) setSession((s) => (s ? setCache(s, docId, { key, off }) : s))
  }

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
        setWarnings(kernelWarnings(result.stderrRaw).replaceAll('/in.scad', 'model.scad') || null)
        setExportError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } else {
      setError(result.stderr)
    }
    setCompiles((n) => n + 1)
  }

  const currentId = session?.currentId ?? null
  // The open document is the URL hash, `#<id>`, none at the start window: a
  // history entry per move, so Back and Forward walk between them.
  useEffect(() => {
    if (!currentId) return
    const want = open ? `#${currentId}` : ''
    if (location.hash !== want) history.pushState(null, '', location.pathname + location.search + want)
  }, [open, currentId])
  useEffect(() => {
    const sync = () => {
      const s = sessionRef.current
      if (!s) return
      const id = location.hash.slice(1)
      const known = s.docs.some((d) => d.id === id)
      // A deleted document's entry: made the start window, not a trap for Back.
      if (id && !known) history.replaceState(null, '', location.pathname + location.search)
      if (known && s.currentId !== id) setSession(selectDoc(s, id))
      setOpen(known)
      setFitToken((n) => n + 1)
    }
    window.addEventListener('popstate', sync)
    return () => window.removeEventListener('popstate', sync)
  }, [])

  // Depends on `ready` and the document id, not `session`: a chat event or a
  // version commit changes the session without changing the source, and must
  // not restart a compile that is already in flight.
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

    // The document's last compile, while the source and components are still
    // what made it: on screen at once, and the kernel never starts for it.
    // Read through the ref so a cache write does not re-run this effect.
    const cache = sessionRef.current?.docs.find((d) => d.id === currentId)?.cache
    if (cache && cache.key === key) {
      try {
        setMesh(parseOff(new TextDecoder().decode(cache.off)))
        appliedKeyRef.current = key
        setBusy(false)
        setError(null)
        setWarnings(null)
        setBefore(cache.off)
        return
      } catch {
        // A cache that no longer parses is compiled over.
      }
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
          cacheMesh(key, result.data, currentId)
          try {
            thumbnail(parseOff(new TextDecoder().decode(result.data)), currentId)
          } catch {
            // An unreadable OFF is already the HUD's error.
          }
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
  const exportAs = async (format: DownloadFormat, part: number | null): Promise<boolean> => {
    setExporting(format)
    setExportError(null)
    const name = fileName(session ? currentDoc(session).name : UNTITLED) + (part ? ` part ${part}` : '')
    const exporter = new Compiler()
    try {
      // STL and OBJ are written here from the OFF, so colour comes along —
      // per facet in the STL, as an MTL beside the OBJ. The kernel's own
      // writers of both have none. 3MF comes from the kernel with its
      // materials, and gets the slicers' per-triangle painting added.
      const result = await exporter.compile(source, format === '3mf' ? format : 'off', { files })
      if (result.ok) {
        const filename = `${name}.${EXTENSION[format]}`
        if (format === '3mf') downloadBlob(paint3mf(part ? part3mf(result.data, part) : result.data), filename, MIME[format])
        else {
          const whole = parseOff(new TextDecoder().decode(result.data))
          const mesh = part ? partMesh(whole, part) : whole
          if (format === 'binstl') downloadBlob(encodeStl(mesh), filename, MIME[format])
          else {
            const { obj, mtl } = encodeObj(mesh, name)
            downloadBlob(obj, filename, MIME[format])
            if (mtl) downloadBlob(mtl, `${name}.mtl`, 'model/mtl')
          }
        }
        return true
      }
      setExportError(result.stderr)
      return false
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
  const doc = session && open ? currentDoc(session) : null
  const canExport = !!mesh && !error
  const toggleEditor = (next: boolean) => {
    setEditOpen(next)
    localStorage.setItem(PANE_KEY, next ? 'open' : 'closed')
  }
  const status = busy
    ? { tone: 'busy', text: 'Compiling…' }
    : turnMesh
      ? { tone: 'busy', text: 'Candidate · not saved yet' }
      : error
        ? { tone: 'bad', text: "Didn't compile" }
        : ms !== null
          ? { tone: 'ok', text: `Up to date · ${took(ms)}` }
          : null

  return (
    <div className="app" data-compiles={compiles} data-working={working} data-tab={tab} data-start={!open}>
      <div className="working" aria-hidden={!working} />

      <TopBar
        session={session}
        atStart={!open}
        connected={connected}
        canExport={canExport}
        onConnect={() => setConnectToken((n) => n + 1)}
        onChange={(next) => {
          setSession(next)
          setFitToken((n) => n + 1)
          // At the start window only New and Import are enabled, and both mean
          // "open this". Delete goes back to the start window right after.
          setOpen(true)
        }}
        onStart={() => setOpen(false)}
        onHelp={() => setHelp((h) => !h)}
        onHistory={() => {
          setHistoryFocus(null)
          setHistoryOpen(true)
        }}
        onExport={() => setExportOpen(true)}
      />

      {session && help && <Help onClose={() => setHelp(false)} />}
      <HistoryPanel
        open={historyOpen}
        doc={doc}
        focus={historyFocus}
        busy={chatBusy}
        onClose={() => setHistoryOpen(false)}
        onSave={() => setSession((s) => (s ? saveVersion(s, Date.now()) : s))}
        onRestore={(id) => {
          setSession((s) => (s ? restoreVersion(s, id, Date.now()) : s))
          setFitToken((n) => n + 1)
        }}
        onFullDiff={setDiffOf}
      />
      <VersionDiff doc={doc} versionId={diffOf} onClose={() => setDiffOf(null)} />
      <ExportDialog
        open={exportOpen && doc !== null}
        doc={doc}
        parts={stats?.parts ?? 1}
        size={canExport && stats ? stats.size : null}
        part={selected ? { n: selected.part, size: selected.max.map((hi, i) => hi - selected.min[i]!) } : null}
        bed={bed}
        exporting={exporting !== null}
        error={exportError}
        onClose={() => setExportOpen(false)}
        onExport={exportAs}
      />

      {session && !open && (
        <StartWindow
          session={session}
          durable={durable}
          units={units}
          onUnits={setUnits}
          onOpen={(id) => {
            // Functional, because the examples create the document and open it
            // in the same click: the render's `session` does not have it yet,
            // and selectDoc on that would drop it.
            setSession((s) => (s ? selectDoc(s, id) : s))
            setFitToken((n) => n + 1)
            setOpen(true)
          }}
          onChange={setSession}
          onCreate={(id, how: Opening) => {
            setSession((s) => (s ? selectDoc(s, id) : s))
            setFitToken((n) => n + 1)
            setOpen(true)
            if ('prompt' in how) {
              setPrompt(how.prompt)
              setTab('chat')
            } else {
              showEditor(how.edit)
              setTab(how.edit === 'code' ? 'edit' : 'model')
            }
          }}
        />
      )}

      <div className="panes">
        <section ref={codeRef} className={editOpen ? 'pane side edit' : 'pane side edit collapsed'}>
          <div className="editor-pane">
            <div className="edit-head">
              <div className="seg wide" role="tablist" aria-label="Edit">
                {(['params', 'code'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={editTab === t}
                    onClick={() => showEditor(t)}
                  >
                    {t === 'params' ? 'Parameters' : 'Code'}
                  </button>
                ))}
              </div>
              <button type="button" className="edit-hide" aria-label="Hide the editor" title="Hide the editor" onClick={() => toggleEditor(false)}>
                ‹
              </button>
            </div>
            <div className="edit-params" hidden={editTab !== 'params'}>
              <ParamsPanel source={source} disabled={chatBusy} onPreview={setPreviewDefines} onCommit={setSource} />
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
            <div className="editor-host" hidden={editTab !== 'code'}>
              {/* Remounts on a document switch, like the chat pane: a fresh
                  CodeMirror state, so undo cannot replay the switch and put the
                  previous document's source — or the boot-time starter — into
                  this one. A turn's whole-document replace stays undoable. */}
              <Editor
                key={session?.currentId ?? 'boot'}
                value={streamSource ?? source}
                onChange={setSource}
                editable={!chatBusy}
                errorLine={streamSource === null ? errorLineOf(error) : null}
              />
            </div>
          </div>
        </section>

        <section className="pane view">
          {editOpen ? (
            <div
              className="splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the editor"
              tabIndex={0}
              onPointerDown={(e) => {
                e.preventDefault() // no text selection under the drag
                e.currentTarget.setPointerCapture(e.pointerId)
              }}
              onPointerMove={(e) => {
                const pane = codeRef.current
                if (pane && e.currentTarget.hasPointerCapture(e.pointerId))
                  pane.style.width = `${e.clientX - pane.getBoundingClientRect().left}px`
              }}
              onKeyDown={(e) => {
                const step = e.key === 'ArrowLeft' ? -24 : e.key === 'ArrowRight' ? 24 : 0
                const pane = codeRef.current
                if (pane && step) pane.style.width = `${pane.offsetWidth + step}px`
              }}
            />
          ) : (
            <button type="button" className="code-toggle" aria-label="Show the editor" title="Parameters and code" onClick={() => toggleEditor(true)}>
              ›
            </button>
          )}
          <Viewport
            mesh={shown}
            ghost={ghost}
            plate={bed}
            fitToken={fitToken}
            highlight={selected?.triangles ?? null}
            onPick={(triangle) => setSelected(triangle !== null && shown ? selectPart(shown, triangle) : null)}
            onMarkup={(url) => {
              setMarkup(url)
              setTab('chat')
            }}
          />
          <div className="hud">
            {status && (
              <span className={`tag status ${status.tone}`}>
                {status.tone === 'busy' && <span className="spinner" aria-hidden="true" />}
                {status.text}
              </span>
            )}
            {stats && (
              // Display only: the model, the source and the exported file stay metric.
              <span className={error ? 'stats stale' : 'stats'} title={`${stats.triangles.toLocaleString()} triangles`}>
                <span className="tag">
                  {stats.size.map((n) => formatLength(n, units)).join(' × ')} {lengthLabel(units)}
                </span>
                {stats.parts > 1 && <span className="tag">{stats.parts} parts</span>}
                <span className="tag">
                  {stats.volume === null ? 'not watertight' : `${formatVolume(stats.volume, units)} ${volumeLabel(units)}`}
                </span>
                {fitsBed(stats.size, bed) ? (
                  <span className="tag ok">Fits your printer</span>
                ) : (
                  <span className="tag bad">Bigger than your printer</span>
                )}
              </span>
            )}
          </div>
          {selected && (
            <span className="selected-pill">
              Part {selected.part} selected
            </span>
          )}
          <div className="seg units" role="group" aria-label="Display units" title="Display units. The model itself is always millimetres.">
            {(['mm', 'in'] as const).map((u) => (
              <button key={u} type="button" aria-pressed={units === u} onClick={() => setUnits(u)}>
                {u}
              </button>
            ))}
          </div>
          {shownError && <pre className="error">{shownError}</pre>}
          {!shownError && warnings && <pre className="warnings">{warnings}</pre>}
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
            onUnits={setUnits}
            initialLog={session ? currentDoc(session).chat : []}
            onLogChange={(log) => setSession((s) => (s ? setChat(s, log) : s))}
            onPrompt={(text) => setSession((s) => (s ? nameFromFirstPrompt(s, text) : s))}
            autoPrompt={open ? prompt : null}
            onAutoPrompt={() => setPrompt(null)}
            connectToken={connectToken}
            onConnected={setConnected}
            onStreamSource={setStreamSource}
            onApply={(next, result, label) => {
              // A preview compile still in flight would land on top of this and
              // put a stale mesh under the new source.
              compiler.cancel()
              const commit = (s: Session) => nameFromFirstTurn(commitTurn(s, next, label, result.ok, Date.now()), next)
              setSession((s) => (s ? commit(s) : s))
              // With the components: the turn compiled with the files, and the
              // preview effect's key carries them too.
              const key = compileKey(next, NO_DEFINES, components)
              applyCompiled(key, result)
              if (result.ok) {
                setBefore(result.data)
                cacheMesh(key, result.data, currentId)
                try {
                  thumbnail(parseOff(new TextDecoder().decode(result.data)), currentId)
                } catch {
                  // As above.
                }
              }
              setFitToken((n) => n + 1)
              // The version this became, for the chat's result card: the same
              // pure commit on the latest session, read without waiting for it.
              const s = sessionRef.current
              return s ? headVersion(currentDoc(commit(s))).id : null
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
            onShowVersion={(id) => {
              setHistoryFocus(id)
              setHistoryOpen(true)
            }}
            onExport={(format) => void exportAs(format, selected?.part ?? null)}
            onBusyChange={setChatBusy}
            onBed={setBed}
          />
        </section>
      </div>

      {open && (
        <nav className="tabbar" aria-label="Show">
          {(['model', 'chat', 'edit'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => {
                setTab(t)
                // The view changes size with the tab: frame the part for the new one.
                setFitToken((n) => n + 1)
                if (t === 'edit') showEditor(editTab)
              }}
            >
              {t === 'model' ? 'Model' : t === 'chat' ? 'Chat' : 'Edit'}
              {t === 'chat' && chatBusy && <span className="tab-dot" aria-label="working" />}
            </button>
          ))}
        </nav>
      )}
    </div>
  )
}

/**
 * The bar over everything. At the start window: the brand, Import project,
 * Help and whether a model is connected. In a document: its name — the menu of
 * everything done to documents — the History pill, Share, Help and Export.
 */
function TopBar({
  session,
  atStart,
  connected,
  canExport,
  onConnect,
  onChange,
  onStart,
  onHelp,
  onHistory,
  onExport,
}: {
  session: Session | null
  /** The start window is up: no document is on screen, so no document controls. */
  atStart: boolean
  connected: string | null
  canExport: boolean
  onConnect: () => void
  onChange: (next: Session) => void
  onStart: () => void
  onHelp: () => void
  onHistory: () => void
  onExport: () => void
}) {
  const doc = !atStart && session ? currentDoc(session) : null
  const fileRef = useRef<HTMLInputElement>(null)
  const [shared, setShared] = useState(false)
  const head = doc ? headVersion(doc) : null

  const importInput = (
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
            const imported = importProject(text, crypto.randomUUID(), Date.now(), session.docs.map((d) => d.name))
            onChange({ docs: [...session.docs, imported], currentId: imported.id })
          } catch (error) {
            window.alert(error instanceof Error ? error.message : String(error))
          }
        })
      }}
    />
  )

  if (!doc || !session || !head) {
    return (
      <header className="topbar">
        <img className="logo" src="favicon.svg" alt="" />
        <span className="brand-name">Vibe3D</span>
        <div className="topbar-end">
          <button type="button" className="ghost" disabled={!session} onClick={() => fileRef.current?.click()}>
            Import project
          </button>
          <HelpButton onHelp={onHelp} />
          {connected ? (
            <span className="pill ok">
              <span className="dot" aria-hidden="true" />
              {connected}
            </span>
          ) : (
            <button type="button" className="pill" onClick={onConnect}>
              Connect a model
            </button>
          )}
        </div>
        {importInput}
      </header>
    )
  }

  const share = () => {
    void encodeShare(doc.source)
      .then((hash) => navigator.clipboard.writeText(`${location.origin}${location.pathname}#${hash}`))
      .then(() => {
        setShared(true)
        setTimeout(() => setShared(false), 1500)
      })
      .catch(() => window.alert('Could not reach the clipboard.'))
  }

  return (
    <header className="topbar">
      <button type="button" className="logo" aria-label="Vibe3D" title="All documents" onClick={onStart}>
        <img src="favicon.svg" alt="" />
      </button>
      <button type="button" className="back" aria-label="All documents" onClick={onStart}>
        ‹
      </button>
      <span className="slash" aria-hidden="true">/</span>
      <div className="doc-title">
        <Menu className="doc-menu" title="Document" label={<><span className="doc-name">{doc.name}</span><span className="caret-down" aria-hidden="true">▾</span></>}>
          {(close) => (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  const id = crypto.randomUUID()
                  onChange({ docs: [...session.docs, newDoc(UNTITLED, '', id, Date.now())], currentId: id })
                }}
              >
                New document
              </button>
              <button type="button" role="menuitem" onClick={() => (close(), onStart())}>
                All documents
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  close()
                  // ponytail: the platform's own dialog. A rename popover is UI to
                  // maintain for something done once per document.
                  const name = window.prompt('Name this document', doc.name)
                  if (name !== null) onChange(renameDoc(session, doc.id, name))
                }}
              >
                Rename…
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => {
                  close()
                  if (!window.confirm(`Delete "${doc.name}"? This cannot be undone.`)) return
                  onChange(deleteDoc(session, doc.id, crypto.randomUUID(), Date.now()))
                  // What was open is gone; whichever neighbour became current was not
                  // chosen by the user, so the start window is where to pick next.
                  onStart()
                }}
              >
                Delete…
              </button>
              <hr />
              <button type="button" role="menuitem" onClick={() => (close(), fileRef.current?.click())}>
                Import project…
              </button>
              <button
                type="button"
                role="menuitem"
                title="One .json with the source, every version and the conversation — never the key"
                onClick={() => {
                  close()
                  downloadBlob(new TextEncoder().encode(exportProject(doc)), `${fileName(doc.name)}.json`, 'application/json')
                }}
              >
                Export project
              </button>
              {/* A phone's top bar has no room for these two: they live here instead. */}
              <hr className="mobile-only" />
              <button type="button" role="menuitem" className="mobile-only" onClick={() => (close(), share())}>
                Copy share link
              </button>
              <button type="button" role="menuitem" className="mobile-only" onClick={() => (close(), onHelp())}>
                Help
              </button>
            </>
          )}
        </Menu>
        <button type="button" className="history-pill" title="Every turn, save and edit is a version" onClick={onHistory}>
          <span className="mono">v{head.id}</span>
          <span className="history-pill-label">{versionTitle(head)}</span>
          <span className="history-pill-more">· History</span>
        </button>
      </div>
      <div className="topbar-end">
        <button
          type="button"
          className="ghost share"
          title="Copy a link that opens this source as a new document — the source only, no conversation"
          onClick={share}
        >
          {shared ? 'Link copied' : 'Share'}
        </button>
        <HelpButton onHelp={onHelp} />
        <button type="button" className="btn primary" disabled={!canExport} onClick={onExport}>
          Export
        </button>
      </div>
      {importInput}
    </header>
  )
}

/** Hover (or focus) lists the commands; a click opens the manual. Pure CSS. */
function HelpButton({ onHelp }: { onHelp: () => void }) {
  return (
    <span className="menu-help">
      <button type="button" className="ghost" onClick={onHelp} title="Open the manual">
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
          Enter sends, Shift+Enter breaks a line. Click a part in the viewport to talk about it. Click Help for the manual.
        </span>
      </div>
    </span>
  )
}
