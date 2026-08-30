import { useEffect, useRef } from 'react'
import {
  AmbientLight, AxesHelper, BoxGeometry, BufferAttribute, BufferGeometry,
  DirectionalLight, DoubleSide, EdgesGeometry, GridHelper, Group,
  LineBasicMaterial, LineSegments, Mesh as ThreeMesh, MeshStandardMaterial,
  PerspectiveCamera, Scene, WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Mesh } from '../kernel/off'

/** Bambu A1 / P1S / X1C / X1E share this build volume. */
const PLATE_MM = 256

export function Viewport({ mesh }: { mesh: Mesh | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const modelGroupRef = useRef<Group | null>(null)
  const renderRef = useRef<() => void>(() => {})

  // Scene is built once and reused; only the model group's contents change.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const scene = new Scene()
    const camera = new PerspectiveCamera(45, 1, 1, 5000)
    camera.position.set(220, 180, 220)

    const renderer = new WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    host.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true

    scene.add(new AmbientLight(0xffffff, 1.6))
    const key = new DirectionalLight(0xffffff, 2.0)
    key.position.set(1, 2, 1.5)
    scene.add(key)

    const grid = new GridHelper(PLATE_MM, 16, 0x888888, 0xcccccc)
    scene.add(grid)
    const axes = new AxesHelper(30)
    scene.add(axes)

    // Build-volume outline.
    const volume = new BoxGeometry(PLATE_MM, PLATE_MM, PLATE_MM)
    const outline = new LineSegments(
      new EdgesGeometry(volume),
      new LineBasicMaterial({ color: 0xbbbbbb }),
    )
    outline.position.y = PLATE_MM / 2
    scene.add(outline)

    // OpenSCAD is Z-up; three.js is Y-up. One group rotation reconciles them.
    const modelGroup = new Group()
    modelGroup.rotation.x = -Math.PI / 2
    scene.add(modelGroup)
    modelGroupRef.current = modelGroup

    const render = () => renderer.render(scene, camera)
    renderRef.current = render

    // frameloop-on-demand: the model is static, so only draw when something moved.
    controls.addEventListener('change', render)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host
      if (w === 0 || h === 0) return
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      render()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    // Damping needs a loop, but it is cheap and stops when idle.
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (controls.update()) render()
    }
    tick()

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      controls.dispose()
      renderer.dispose()
      volume.dispose()
      host.removeChild(renderer.domElement)
      modelGroupRef.current = null
    }
  }, [])

  // Swap geometry when a new compile lands.
  useEffect(() => {
    const group = modelGroupRef.current
    if (!group) return

    for (const child of [...group.children]) {
      group.remove(child)
      if (child instanceof ThreeMesh || child instanceof LineSegments) {
        child.geometry.dispose()
        ;(Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => m.dispose())
      }
    }

    if (mesh && mesh.triangleCount > 0) {
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
      geometry.setIndex(new BufferAttribute(mesh.indices, 1))
      geometry.computeVertexNormals()

      group.add(
        new ThreeMesh(
          geometry,
          // DoubleSide so an inverted winding never renders as an invisible hole.
          new MeshStandardMaterial({ color: 0xf9d72c, roughness: 0.55, metalness: 0, side: DoubleSide }),
        ),
      )
      // Crease outline aids reading the shape; threshold keeps it sparse.
      group.add(
        new LineSegments(
          new EdgesGeometry(geometry, 30),
          new LineBasicMaterial({ color: 0x3b3b3b }),
        ),
      )
    }

    renderRef.current()
  }, [mesh])

  return <div ref={hostRef} style={{ width: '100%', height: '100%', minHeight: 0 }} />
}
