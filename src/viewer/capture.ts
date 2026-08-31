import {
  BufferAttribute, BufferGeometry, EdgesGeometry, FrontSide, LineBasicMaterial, LineSegments,
  Mesh as ThreeMesh, MeshBasicMaterial, MultiplyBlending, OrthographicCamera, Scene, Vector3,
  WebGLRenderer,
} from 'three'
import type { Mesh } from '../kernel/off'
import type { Box } from './inspect'

/** design.md §6: 768 px is the ceiling worth paying for. */
const SIZE = 768
/**
 * Pure, at opacity 0.5, under premultiplied multiply — dst · (src + 1 − α) —
 * which is a half-strength tint: light green alone, light magenta alone, and
 * exactly 50% grey where both cover a pixel.
 */
const BEFORE = 0x00ff00
const AFTER = 0xff00ff
const OPACITY = 0.5
const EDGE = 0x202020
const ISO = new Vector3(1, -1, 1).normalize()

let renderer: WebGLRenderer | null | undefined

/**
 * One context for the app's lifetime. A WebGL context is a scarce resource
 * (browsers cap them around 16), and one per turn would leak them. null means
 * there is no WebGL here; the round then goes text-only.
 */
function acquire(): WebGLRenderer | null {
  if (renderer === undefined) {
    try {
      renderer = new WebGLRenderer({
        canvas: document.createElement('canvas'),
        antialias: true,
        // toDataURL reads the buffer after the render call returns.
        preserveDrawingBuffer: true,
      })
      renderer.setPixelRatio(1)
      renderer.setSize(SIZE, SIZE, false)
      renderer.setClearColor(0xffffff, 1)
    } catch {
      renderer = null
    }
  }
  return renderer
}

/** Orthographic, from the iso direction, +Z up, fitted exactly to the frame box's projection. */
function frameCamera(frame: Box): OrthographicCamera {
  const center = new Vector3(...frame.min).add(new Vector3(...frame.max)).multiplyScalar(0.5)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 1e5)
  camera.up.set(0, 0, 1)
  // Distance is irrelevant to an orthographic projection; this just keeps the
  // whole part in front of the near plane.
  camera.position.copy(center).addScaledVector(ISO, 1e4)
  camera.lookAt(center)
  camera.updateMatrixWorld()
  let half = 0
  for (let corner = 0; corner < 8; corner++) {
    const p = new Vector3(
      corner & 1 ? frame.max[0] : frame.min[0],
      corner & 2 ? frame.max[1] : frame.min[1],
      corner & 4 ? frame.max[2] : frame.min[2],
    ).applyMatrix4(camera.matrixWorldInverse)
    half = Math.max(half, Math.abs(p.x), Math.abs(p.y))
  }
  half = Math.max(half * 1.1, 1)
  camera.left = -half
  camera.right = half
  camera.top = half
  camera.bottom = -half
  camera.updateProjectionMatrix()
  return camera
}

/**
 * design.md §6.2: before in green, after in magenta, multiplied, no depth —
 * so overlap is grey and added / removed material keeps its colour — plus a
 * sparse crease outline. The outline is depth-tested against a depth-only
 * pass of both parts, so hidden creases stay hidden: dense line work is where
 * these models fail hardest.
 */
export function renderComposite(before: Mesh | null, after: Mesh, frame: Box): string | null {
  const gl = acquire()
  if (!gl) return null
  const scene = new Scene()
  const owned: { dispose(): void }[] = []
  const add = (mesh: Mesh, color: number): void => {
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
    geometry.setIndex(new BufferAttribute(mesh.indices, 1))
    const depth = new MeshBasicMaterial({
      colorWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    })
    const prepass = new ThreeMesh(geometry, depth)
    prepass.renderOrder = -1
    const tint = new MeshBasicMaterial({
      color,
      opacity: OPACITY,
      side: FrontSide,
      transparent: true,
      blending: MultiplyBlending,
      // Required by three for MultiplyBlending; without it the draw silently
      // overwrites instead of multiplying, and the overlap reads as "before".
      premultipliedAlpha: true,
      depthTest: false,
      depthWrite: false,
    })
    const edges = new EdgesGeometry(geometry, 30)
    const line = new LineBasicMaterial({ color: EDGE })
    scene.add(prepass, new ThreeMesh(geometry, tint), new LineSegments(edges, line))
    owned.push(geometry, depth, tint, edges, line)
  }
  if (before) add(before, BEFORE)
  add(after, AFTER)
  gl.render(scene, frameCamera(frame))
  const url = gl.domElement.toDataURL('image/jpeg', 0.85)
  for (const item of owned) item.dispose()
  return url
}
