import { useEffect, useRef } from 'react'
import {
  AmbientLight, AxesHelper, Box3, BufferAttribute, BufferGeometry, DirectionalLight,
  DoubleSide, EdgesGeometry, GridHelper, Group, LineBasicMaterial, LineLoop, LineSegments,
  Color, Fog, Mesh as ThreeMesh, MeshStandardMaterial, PerspectiveCamera, Quaternion, Scene,
  Vector3, WebGLRenderer, type Material,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Mesh } from '../kernel/off'
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
/** Matches the .view pane behind it, so the fog fades the grid into the page. */
const BACKGROUND = 0xf6f7f4
const SNAP_MS = 260

const disposeMaterial = (material: Material | Material[]) =>
  (Array.isArray(material) ? material : [material]).forEach((m) => m.dispose())

interface ViewportApi {
  setMesh(mesh: Mesh | null): void
  fit(): void
}

export function Viewport({
  mesh,
  fitToken = 0,
}: {
  mesh: Mesh | null
  /** Bump to re-frame. A turn replaces the whole part, so the camera the user
   *  left pointing at the last one is almost never the right one. */
  fitToken?: number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const cubeHostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<ViewportApi | null>(null)

  // Scene is built once and reused; only the model group's contents change.
  useEffect(() => {
    const host = hostRef.current
    const cubeHost = cubeHostRef.current
    if (!host || !cubeHost) return

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
    const modelBox = new Box3()
    let fitted = false

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

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host
      if (w === 0 || h === 0) return
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      draw()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    apiRef.current = {
      fit,
      setMesh(next) {
        for (const child of [...modelGroup.children]) {
          modelGroup.remove(child)
          if (child instanceof ThreeMesh || child instanceof LineSegments) {
            child.geometry.dispose()
            disposeMaterial(child.material)
          }
        }
        modelBox.makeEmpty()

        if (next && next.triangleCount > 0) {
          const geometry = new BufferGeometry()
          geometry.setAttribute('position', new BufferAttribute(next.positions, 3))
          geometry.setIndex(new BufferAttribute(next.indices, 1))
          geometry.computeVertexNormals()
          geometry.computeBoundingBox()
          if (geometry.boundingBox) modelBox.copy(geometry.boundingBox)

          modelGroup.add(
            new ThreeMesh(
              geometry,
              // DoubleSide so an inverted winding never renders as an invisible hole.
              new MeshStandardMaterial({
                color: 0xf9d72c, roughness: 0.55, metalness: 0, side: DoubleSide,
              }),
            ),
          )
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

  // Declared after the mesh effect so modelBox is already the new part's.
  useEffect(() => {
    if (fitToken > 0) apiRef.current?.fit()
  }, [fitToken])

  return (
    <div className="viewport">
      <div ref={hostRef} className="viewport-canvas" />
      <div className="view-cube">
        <div ref={cubeHostRef} />
        <button type="button" onClick={() => apiRef.current?.fit()} title="Frame the model">
          FIT
        </button>
      </div>
    </div>
  )
}
