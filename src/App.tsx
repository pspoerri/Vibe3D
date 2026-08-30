import { useEffect, useMemo, useRef, useState } from 'react'
import { Compiler } from './kernel/compile'
import { parseOff, type Mesh } from './kernel/off'
import { meshStats } from './kernel/stats'
import { Editor } from './editor/Editor'
import { Viewport } from './viewer/Viewport'

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
      const result = await compiler.compile(source, 'off')
      if (runIdRef.current !== runId) return // superseded
      // A cancelled compile is not a failure the user should see.
      if (!result.ok && result.cancelled) return
      setBusy(false)
      setMs(result.ms)
      if (result.ok) {
        try {
          setMesh(parseOff(new TextDecoder().decode(result.data)))
          setError(null)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } else {
        setError(result.stderr)
      }
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [source, compiler])

  const stats = mesh ? meshStats(mesh) : null

  return (
    <div className="app">
      <section className="pane">
        <Editor value={source} onChange={setSource} />
      </section>
      <section className="pane view">
        <Viewport mesh={mesh} />
        <div className="hud">
          {busy && <span className="tag busy">compiling…</span>}
          {!busy && ms !== null && <span className="tag">{ms} ms</span>}
          {stats && (
            <>
              <span className="tag">
                {stats.size.map((n) => n.toFixed(1)).join(' × ')} mm
              </span>
              <span className="tag">{stats.triangles.toLocaleString()} tris</span>
              <span className="tag">
                {stats.volume === null
                  ? 'not watertight'
                  : `${(stats.volume / 1000).toFixed(2)} cm³`}
              </span>
            </>
          )}
        </div>
        {error && <pre className="error">{error}</pre>}
      </section>
    </div>
  )
}
