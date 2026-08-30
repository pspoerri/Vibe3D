import { useEffect, useMemo, useRef, useState } from 'react'
import { Compiler } from './kernel/compile'
import { parseOff, type Mesh } from './kernel/off'
import { meshStats } from './kernel/stats'
import { Editor } from './editor/Editor'
import { Viewport } from './viewer/Viewport'
import { downloadBlob, MIME } from './export/download'

const STARTER = `// A mounting plate. Drag the numbers, or edit freely.
$fn = 64;

plate_x = 60;
plate_y = 40;
plate_z = 3;
hole_d  = 5;
inset   = 6;

difference() {
  cube([plate_x, plate_y, plate_z]);
  for (x = [inset, plate_x - inset], y = [inset, plate_y - inset])
    translate([x, y, -1])
      cylinder(h = plate_z + 2, d = hole_d);
}
`

const DEBOUNCE_MS = 600

export function App() {
  const [source, setSource] = useState(STARTER)
  const [mesh, setMesh] = useState<Mesh | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)

  const compiler = useMemo(() => new Compiler(), [])
  useEffect(() => () => compiler.dispose(), [compiler])

  // Guards against an earlier compile resolving after a later one.
  const runIdRef = useRef(0)

  useEffect(() => {
    const runId = ++runIdRef.current
    setBusy(true)
    const timer = setTimeout(async () => {
      let result
      try {
        result = await compiler.compile(source, 'off')
      } catch (e) {
        if (runIdRef.current !== runId) return // superseded
        setBusy(false)
        setError(e instanceof Error ? e.message : String(e))
        return
      }
      if (runIdRef.current !== runId) return // superseded
      // A cancelled compile is not a failure the user should see.
      if (!result.ok && result.cancelled) return
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
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [source, compiler])

  const stats = useMemo(() => (mesh ? meshStats(mesh) : null), [mesh])

  const [exporting, setExporting] = useState<null | 'binstl' | '3mf'>(null)
  const [exportError, setExportError] = useState<string | null>(null)

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

  // The preview's error marks the HUD stale; an export's error must not.
  const shownError = error ?? exportError

  return (
    <div className="app">
      <section className="pane">
        <Editor value={source} onChange={setSource} />
      </section>
      <section className="pane view">
        <Viewport mesh={mesh} />
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
              <span className="tag">
                {stats.size.map((n) => n.toFixed(1)).join(' × ')} mm
              </span>
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
    </div>
  )
}
