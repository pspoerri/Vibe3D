import { useEffect, useMemo, useRef, useState } from 'react'
import { Chat } from './chat/Chat'
import { Compiler, type CompileResult } from './kernel/compile'
import { parseOff, type Mesh } from './kernel/off'
import { meshStats } from './kernel/stats'
import { Editor } from './editor/Editor'
import { ParamsPanel } from './editor/ParamsPanel'
import { Viewport } from './viewer/Viewport'
import { downloadBlob, MIME } from './export/download'

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

export function App() {
  const [source, setSource] = useState(STARTER)
  const [mesh, setMesh] = useState<Mesh | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const [streamSource, setStreamSource] = useState<string | null>(null)
  const [previewDefines, setPreviewDefines] = useState<readonly string[]>(NO_DEFINES)
  const [chatBusy, setChatBusy] = useState(false)
  const [compiles, setCompiles] = useState(0)
  const [fitToken, setFitToken] = useState(0)

  const compiler = useMemo(() => new Compiler(), [])
  useEffect(() => () => compiler.dispose(), [compiler])

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
  }, [source, previewDefines, compiler])

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

  return (
    <div className="app" data-compiles={compiles}>
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
          {busy && <span className="tag busy">compiling…</span>}
          {!busy && ms !== null && <span className="tag">{ms} ms</span>}
          {stats && (
            <span className={error ? 'stats stale' : 'stats'}>
              <span className="tag">{stats.size.map((n) => n.toFixed(1)).join(' × ')} mm</span>
              <span className="tag">{stats.triangles.toLocaleString()} tris</span>
              <span className="tag">
                {stats.volume === null
                  ? 'not watertight'
                  : `${(stats.volume / 1000).toFixed(2)} cm³`}
              </span>
            </span>
          )}
        </div>
        {shownError && <pre className="error">{shownError}</pre>}
      </section>

      <section className="pane">
        <Chat
          source={source}
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
