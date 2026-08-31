import { useEffect, useRef, useState } from 'react'
import {
  AmbientLight, AxesHelper, Box3, BufferAttribute, BufferGeometry, DirectionalLight,
  DoubleSide, EdgesGeometry, GridHelper, Group, LineBasicMaterial, LineLoop, LineSegments,
  Color, Fog, Mesh as ThreeMesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera,
  Quaternion, Raycaster, Scene, SRGBColorSpace, Vector2, Vector3, WebGLRenderer, type Material,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Mesh } from '../kernel/off'
import { fit as fitImage } from '../llm/images'
import {
  chooseGridSpacing, fitDistance, VIEW_DIRECTIONS, viewUp, worldPerPixel, type StandardView,
} from './camera'
import { createViewCube } from './ViewCube'

/** Bambu A1 / P1S / X1C / X1E share this build volume. */
const PLATE_MM = 256
const FOV = 50
// Extent is spacing x cells. Generous, because the ground plane runs to the
// horizon and the fog is what ends it — a small patch would read as a rug.
const GRID_CELLS = 160
const GRID_MAJOR = 0xa4ab9c
const GRID_MINOR = 0xc8ccc4
const PLATE_COLOR = 0x7f8578
/** Matches DEFAULT_RGB in kernel/off.ts, so a partly coloured model keeps this for the rest. */
const MODEL_COLOR = 0xf9d72c
/** Over the selected part. Blue: distinct from the default yellow and from any color() a part wears. */
const HIGHLIGHT = 0x3b6fd6
/** A press that travels further than this is an orbit, not a click. */
const CLICK_PX = 5
/** Construction geometry: a blue no part wears, faint enough to read as "not here". */
export const GHOST = 0x4f79b8
/** Markup strokes: a red no part wears, wide enough to survive the downscale. */
const INK = '#e0242a'
const INK_PX = 3

/** Per-triangle sRGB bytes → one linear rgb per corner, which is what three reads. */
function vertexColors(rgb: Uint8Array): Float32Array {
  const out = new Float32Array(rgb.length * 3)
  const c = new Color()
  for (let t = 0; t < rgb.length / 3; t++) {
    c.setRGB(rgb[t * 3]! / 255, rgb[t * 3 + 1]! / 255, rgb[t * 3 + 2]! / 255, SRGBColorSpace)
    for (let k = 0; k < 3; k++) c.toArray(out, (t * 3 + k) * 3)
  }
  return out
}
/** Matches the .view pane behind it, so the fog fades the grid into the page. */
const BACKGROUND = 0xf6f7f4
const SNAP_MS = 260

const disposeMaterial = (material: Material | Material[]) =>
  (Array.isArray(material) ? material : [material]).forEach((m) => m.dispose())

interface ViewportApi {
  setMesh(mesh: Mesh | null): void
  setGhost(mesh: Mesh | null): void
  setHighlight(triangles: Uint32Array | null): void
  fit(): void
  setDrawing(on: boolean): void
  undoStroke(): void
  clearStrokes(): void
  /** The frame with the strokes on it, as a JPEG data URL sized for the wire. */
  capture(): string | null
}

export function Viewport({
  mesh,
  ghost = null,
  fitToken = 0,
  highlight = null,
  onPick,
  onMarkup,
}: {
  mesh: Mesh | null
  /** Construction geometry, drawn translucent: never picked, never framed, never in the stats. */
  ghost?: Mesh | null
  /** Bump to re-frame. A turn replaces the whole part, so the camera the user
   *  left pointing at the last one is almost never the right one. */
  fitToken?: number
  /** Triangles of `mesh` to draw the selection over. */
  highlight?: Uint32Array | null
  /** A click: the triangle under the pointer, or null for empty space. */
  onPick?: (triangle: number | null) => void
  /** Draw mode's ATTACH: the view with the user's strokes on it. */
  onMarkup?: (dataUrl: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cubeHostRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const apiRef = useRef<ViewportApi | null>(null)
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const [drawing, setDrawing] = useState(false)

  // Scene is built once and reused; only the model group's contents change.
  useEffect(() => {
    const host = hostRef.current
    const cubeHost = cubeHostRef.current
    const overlay = overlayRef.current
    if (!host || !cubeHost || !overlay) return

    const scene = new Scene()
    scene.background = new Color(BACKGROUND)
    // Fades the ground plane out with distance instead of letting it run to a
    // hard horizon. Re-ranged per frame so it tracks the zoom.
    const fog = new Fog(BACKGROUND, 1, 1000)
    scene.fog = fog
    // +Z up, so OpenSCAD's coordinates and the world's are the same coordinates
    // (design.md §6). Nothing downstream has to rotate to reason about the part.
    const camera = new PerspectiveCamera(FOV, 1, 0.1, 10_000)
    camera.up.set(0, 0, 1)
    camera.position.set(140, -140, 100)

    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    // Damping stays OFF. It applies only `dampingFactor` (default 0.05) of the
    // requested rotation per frame and decays the rest by 0.95 — roughly a
    // second of the model trailing the cursor, which reads as lag, not inertia.
    controls.enableDamping = false

    scene.add(new AmbientLight(0xffffff, 1.6))
    const key = new DirectionalLight(0xffffff, 2.0)
    key.position.set(1, -1.5, 2)
    scene.add(key)
    scene.add(new AxesHelper(20))

    // Build plate: the outline of the printable area, on Z=0.
    const half = PLATE_MM / 2
    const plateGeometry = new BufferGeometry().setFromPoints([
      new Vector3(-half, -half, 0), new Vector3(half, -half, 0),
      new Vector3(half, half, 0), new Vector3(-half, half, 0),
    ])
    const plateMaterial = new LineBasicMaterial({ color: PLATE_COLOR })
    scene.add(new LineLoop(plateGeometry, plateMaterial))

    const modelGroup = new Group()
    scene.add(modelGroup)
    const ghostGroup = new Group()
    scene.add(ghostGroup)
    const clearGroup = (group: Group): void => {
      for (const child of [...group.children]) {
        group.remove(child)
        if (child instanceof ThreeMesh || child instanceof LineSegments) {
          child.geometry.dispose()
          disposeMaterial(child.material)
        }
      }
    }
    const modelBox = new Box3()
    let fitted = false
    let modelMesh: ThreeMesh | null = null
    let highlightMesh: ThreeMesh | null = null

    // Grid spacing follows the zoom, so it never collapses into a grey wash
    // when you pull back nor vanishes when you dive into a 0.4 mm feature.
    let grid: GridHelper | null = null
    let gridSpacing = 0
    const updateGrid = () => {
      const distance = camera.position.distanceTo(controls.target)
      const visibleWidth = worldPerPixel(FOV, distance, host.clientHeight) * host.clientWidth
      const spacing = chooseGridSpacing(visibleWidth)
      if (spacing === gridSpacing) return
      gridSpacing = spacing
      if (grid) {
        scene.remove(grid)
        grid.geometry.dispose()
        disposeMaterial(grid.material)
      }
      // GridHelper lies in the XZ plane; rotate it onto XY for a Z-up world.
      grid = new GridHelper(spacing * GRID_CELLS, GRID_CELLS, GRID_MAJOR, GRID_MINOR)
      grid.rotation.x = -Math.PI / 2
      scene.add(grid)
    }

    let frame = 0
    const draw = () => {
      frame = 0
      updateGrid()
      const distance = camera.position.distanceTo(controls.target)
      fog.near = distance * 1.5
      fog.far = distance * 6
      renderer.render(scene, camera)
      cube.update(camera.position.clone().sub(controls.target), camera.up)
    }
    // Coalesces a burst of control events into exactly one render per frame.
    const invalidate = () => {
      if (!frame) frame = requestAnimationFrame(draw)
    }

    let snap: {
      fromOffset: Vector3; rotation: Quaternion; fromUp: Vector3; toUp: Vector3; start: number
    } | null = null
    let snapFrame = 0

    const stepSnap = (now: number) => {
      if (!snap) return
      const t = Math.min(1, (now - snap.start) / SNAP_MS)
      const eased = t * t * (3 - 2 * t)
      const rotated = snap.fromOffset.clone().applyQuaternion(
        new Quaternion().slerp(snap.rotation, eased),
      )
      camera.position.copy(controls.target).add(rotated)
      camera.up.copy(snap.fromUp).lerp(snap.toUp, eased).normalize()
      camera.lookAt(controls.target)
      controls.update()
      draw()
      if (t < 1) {
        snapFrame = requestAnimationFrame(stepSnap)
      } else {
        snap = null
        snapFrame = 0
      }
    }

    /** Swing to a standard view, keeping the current distance (so zoom survives). */
    const setView = (view: StandardView) => {
      const fromOffset = camera.position.clone().sub(controls.target)
      if (fromOffset.lengthSq() < 1e-9) fromOffset.set(1, -1, 1)
      const to = new Vector3(...VIEW_DIRECTIONS[view]).normalize()
      snap = {
        fromOffset,
        // setFromUnitVectors picks a sane axis for the antiparallel case, which
        // a plain lerp of the two offsets would collapse through the target.
        rotation: new Quaternion().setFromUnitVectors(fromOffset.clone().normalize(), to),
        fromUp: camera.up.clone(),
        toUp: new Vector3(...viewUp(view)).normalize(),
        start: performance.now(),
      }
      cancelAnimationFrame(snapFrame)
      snapFrame = requestAnimationFrame(stepSnap)
    }

    const fit = () => {
      if (modelBox.isEmpty()) return
      const size = modelBox.getSize(new Vector3())
      const center = modelBox.getCenter(new Vector3())
      const direction = camera.position.clone().sub(controls.target)
      if (direction.lengthSq() < 1e-9) direction.set(1, -1, 1)
      direction.normalize()
      controls.target.copy(center)
      camera.position
        .copy(center)
        .addScaledVector(direction, fitDistance([size.x, size.y, size.z], FOV, camera.aspect))
      controls.update()
      invalidate()
    }

    const cube = createViewCube(cubeHost, setView)
    controls.addEventListener('change', invalidate)

    // A click picks a part; a drag is the orbit's. Told apart by travel, not
    // timing, because OrbitControls already owns pointerdown on this canvas.
    const raycaster = new Raycaster()
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
    }
    const onUp = (e: PointerEvent) => {
      const pressed = down
      down = null
      if (!pressed || Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > CLICK_PX) return
      const rect = renderer.domElement.getBoundingClientRect()
      raycaster.setFromCamera(
        new Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      )
      const hit = modelMesh ? raycaster.intersectObject(modelMesh, false)[0] : undefined
      onPickRef.current?.(hit?.faceIndex ?? null)
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)

    // Draw mode: freehand strokes on a 2D canvas over the frame, in CSS px so a
    // resize redraws them in place. The overlay only takes pointer events while
    // the mode is on (CSS), and the orbit is off for the same span.
    const strokes: { x: number; y: number }[][] = []
    const ink = overlay.getContext('2d')
    const redraw = () => {
      if (!ink) return
      const scale = overlay.width / Math.max(1, host.clientWidth)
      ink.clearRect(0, 0, overlay.width, overlay.height)
      ink.lineWidth = INK_PX * scale
      ink.strokeStyle = INK
      ink.lineJoin = 'round'
      ink.lineCap = 'round'
      for (const stroke of strokes) {
        ink.beginPath()
        stroke.forEach((p, i) => (i ? ink.lineTo(p.x * scale, p.y * scale) : ink.moveTo(p.x * scale, p.y * scale)))
        ink.stroke()
      }
    }
    const at = (e: PointerEvent) => {
      const rect = overlay.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const onInkDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      overlay.setPointerCapture(e.pointerId)
      strokes.push([at(e)])
      redraw()
    }
    const onInkMove = (e: PointerEvent) => {
      if (!overlay.hasPointerCapture(e.pointerId)) return
      strokes[strokes.length - 1]?.push(at(e))
      redraw()
    }
    const onInkUp = (e: PointerEvent) => {
      if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId)
    }
    overlay.addEventListener('pointerdown', onInkDown)
    overlay.addEventListener('pointermove', onInkMove)
    overlay.addEventListener('pointerup', onInkUp)
    overlay.addEventListener('pointercancel', onInkUp)

    const clearHighlight = () => {
      if (!highlightMesh) return
      modelGroup.remove(highlightMesh)
      // Shares the model's position attribute; disposing drops that GL buffer
      // too, and three re-uploads it on the next frame. Cheaper than a copy.
      highlightMesh.geometry.dispose()
      disposeMaterial(highlightMesh.material)
      highlightMesh = null
    }

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      overlay.width = renderer.domElement.width
      overlay.height = renderer.domElement.height
      redraw()
      draw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    apiRef.current = {
      fit,
      setGhost(next) {
        clearGroup(ghostGroup)
        if (next && next.triangleCount > 0) {
          const geometry = new BufferGeometry()
          geometry.setAttribute('position', new BufferAttribute(next.positions, 3))
          geometry.setIndex(new BufferAttribute(next.indices, 1))
          ghostGroup.add(
            new ThreeMesh(
              geometry,
              new MeshBasicMaterial({
                color: GHOST, transparent: true, opacity: 0.16, depthWrite: false, side: DoubleSide,
              }),
            ),
            new LineSegments(
              new EdgesGeometry(geometry, 30),
              new LineBasicMaterial({ color: GHOST, transparent: true, opacity: 0.7 }),
            ),
          )
        }
        invalidate()
      },
      setDrawing(on) {
        controls.enabled = !on
      },
      undoStroke() {
        strokes.pop()
        redraw()
      },
      clearStrokes() {
        strokes.length = 0
        redraw()
      },
      capture() {
        // Rendered and read in one task: the WebGL buffer is still intact until
        // the browser composites, so no preserveDrawingBuffer is needed.
        draw()
        const frame = renderer.domElement
        const out = document.createElement('canvas')
        const [w, h] = fitImage(frame.width, frame.height)
        out.width = w
        out.height = h
        const ctx = out.getContext('2d')
        if (!ctx) return null
        ctx.drawImage(frame, 0, 0, w, h)
        ctx.drawImage(overlay, 0, 0, w, h)
        return out.toDataURL('image/jpeg', 0.85)
      },
      setHighlight(triangles) {
        clearHighlight()
        const base = modelMesh?.geometry
        if (!triangles || !base) return invalidate()
        // faceIndex t is triangle t in both layouts: the index buffer of the
        // indexed geometry, or corners 3t..3t+2 of the de-indexed one.
        const index = base.getIndex()
        const corners = new Uint32Array(triangles.length * 3)
        for (let i = 0; i < triangles.length; i++) {
          const t = triangles[i]!
          for (let k = 0; k < 3; k++) corners[i * 3 + k] = index ? index.getX(t * 3 + k) : t * 3 + k
        }
        const geometry = new BufferGeometry()
        geometry.setAttribute('position', base.getAttribute('position'))
        geometry.setIndex(new BufferAttribute(corners, 1))
        highlightMesh = new ThreeMesh(
          geometry,
          new MeshBasicMaterial({
            color: HIGHLIGHT, transparent: true, opacity: 0.55, side: DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
          }),
        )
        modelGroup.add(highlightMesh)
        invalidate()
      },
      setMesh(next) {
        highlightMesh = null
        modelMesh = null
        clearGroup(modelGroup)
        modelBox.makeEmpty()

        if (next && next.triangleCount > 0) {
          const indexed = new BufferGeometry()
          indexed.setAttribute('position', new BufferAttribute(next.positions, 3))
          indexed.setIndex(new BufferAttribute(next.indices, 1))
          indexed.computeVertexNormals()
          // A per-face colour needs a vertex per corner. De-indexing after the
          // normals exist keeps the smooth shading of the indexed mesh.
          const geometry = next.colors ? indexed.toNonIndexed() : indexed
          if (next.colors) {
            indexed.dispose()
            geometry.setAttribute('color', new BufferAttribute(vertexColors(next.colors), 3))
          }
          geometry.computeBoundingBox()
          if (geometry.boundingBox) modelBox.copy(geometry.boundingBox)

          modelMesh = new ThreeMesh(
            geometry,
            // DoubleSide so an inverted winding never renders as an invisible hole.
            new MeshStandardMaterial({
              color: next.colors ? 0xffffff : MODEL_COLOR,
              vertexColors: next.colors !== undefined,
              roughness: 0.55, metalness: 0, side: DoubleSide,
            }),
          )
          modelGroup.add(modelMesh)
          // Crease outline aids reading the shape; threshold keeps it sparse.
          modelGroup.add(
            new LineSegments(
              new EdgesGeometry(geometry, 30),
              new LineBasicMaterial({ color: 0x3b3b3b }),
            ),
          )
        }

        // Frame the first model that compiles; after that the camera is the
        // user's, and re-framing under them on every recompile would fight them.
        if (!fitted && !modelBox.isEmpty()) {
          fitted = true
          fit()
        }
        invalidate()
      },
    }

    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(snapFrame)
      apiRef.current = null
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      overlay.removeEventListener('pointerdown', onInkDown)
      overlay.removeEventListener('pointermove', onInkMove)
      overlay.removeEventListener('pointerup', onInkUp)
      overlay.removeEventListener('pointercancel', onInkUp)
      controls.removeEventListener('change', invalidate)
      controls.dispose()
      cube.dispose()
      if (grid) {
        grid.geometry.dispose()
        disposeMaterial(grid.material)
      }
      plateGeometry.dispose()
      plateMaterial.dispose()
      renderer.dispose()
      host.removeChild(renderer.domElement)
    }
  }, [])

  // Swap geometry when a new compile lands.
  useEffect(() => {
    apiRef.current?.setMesh(mesh)
  }, [mesh])

  useEffect(() => {
    apiRef.current?.setGhost(ghost)
  }, [ghost])

  // After the mesh effect, so the overlay is built on the geometry it indexes.
  useEffect(() => {
    apiRef.current?.setHighlight(highlight)
  }, [mesh, highlight])

  // Declared after the mesh effect so modelBox is already the new part's.
  useEffect(() => {
    if (fitToken > 0) apiRef.current?.fit()
  }, [fitToken])

  const leaveDrawing = () => {
    apiRef.current?.clearStrokes()
    setDrawing(false)
  }
  useEffect(() => {
    apiRef.current?.setDrawing(drawing)
    if (!drawing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') leaveDrawing()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawing])

  return (
    <div className={drawing ? 'viewport drawing' : 'viewport'} data-ghost={ghost ? '1' : '0'}>
      <div ref={hostRef} className="viewport-canvas" />
      <canvas ref={overlayRef} className="draw-overlay" aria-label="Markup" />
      <div className="view-cube">
        <div ref={cubeHostRef} />
        <button type="button" onClick={() => apiRef.current?.fit()} title="Frame the model">
          FIT
        </button>
        {drawing ? (
          <>
            <button type="button" onClick={() => apiRef.current?.undoStroke()} title="Remove the last stroke">
              UNDO
            </button>
            <button type="button" onClick={() => apiRef.current?.clearStrokes()} title="Remove every stroke">
              CLEAR
            </button>
            <button
              type="button"
              className="primary"
              title="Attach this view, strokes and all, to your next message"
              onClick={() => {
                const url = apiRef.current?.capture()
                if (url) onMarkup?.(url)
                leaveDrawing()
              }}
            >
              ATTACH
            </button>
            <button type="button" onClick={leaveDrawing} title="Leave draw mode (Esc)" aria-label="Leave draw mode">
              ✕
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setDrawing(true)} title="Draw on the view to mark up a change">
            DRAW
          </button>
        )}
      </div>
    </div>
  )
}
