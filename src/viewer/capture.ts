import {
  AmbientLight, BackSide, BufferAttribute, BufferGeometry, DirectionalLight, EdgesGeometry,
  FrontSide, LineBasicMaterial, LineSegments, Mesh as ThreeMesh, MeshBasicMaterial,
  MeshLambertMaterial, MultiplyBlending, OrthographicCamera, Plane, Scene, Vector3,
  WebGLRenderer,
} from 'three'
import type { Mesh } from '../kernel/off'
import type { ViewName, ViewRequest } from '../chat/views'
import { VIEW_DIRECTIONS, viewUp, type Vec3 } from './camera'
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
/** The named views the model can ask for: the cube's, plus the one it lacks. */
const DIRECTIONS: Record<ViewName, Vec3> = { ...VIEW_DIRECTIONS, iso_back: [-1, 1, 1] }
const AXIS: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
/** A cut face is the interior: flat and darker, so it never reads as an outer wall. */
const SHELL = 0xd8d8d0
const INTERIOR = 0x8a8f86
/** Construction geometry in a look: the viewport's blue, translucent, outlined. */
const GHOST = 0x4f79b8

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
      renderer.localClippingEnabled = true
    } catch {
      renderer = null
    }
  }
  return renderer
}

/** Orthographic, from `direction`, fitted exactly to the frame box's projection. */
function frameCamera(frame: Box, direction = ISO, up: Vec3 = [0, 0, 1]): OrthographicCamera {
  const center = new Vector3(...frame.min).add(new Vector3(...frame.max)).multiplyScalar(0.5)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 1e5)
  camera.up.set(...up)
  // Distance is irrelevant to an orthographic projection; this just keeps the
  // whole part in front of the near plane.
  camera.position.copy(center).addScaledVector(direction, 1e4)
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

/** The close-up pane of a composite: a tight frame, seen from a chosen side. */
export interface Detail {
  frame: Box
  direction: Vec3
}

/**
 * design.md §6.2: before in green, after in magenta, multiplied, no depth —
 * so overlap is grey and added / removed material keeps its colour — plus a
 * sparse crease outline. The outline is depth-tested against a depth-only
 * pass of both parts, so hidden creases stay hidden: dense line work is where
 * these models fail hardest.
 */
export function renderComposite(
  before: Mesh | null,
  after: Mesh,
  frame: Box,
  detail: Detail | null = null,
  direction: Vec3 = [1, -1, 1],
): string | null {
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
  gl.render(scene, frameCamera(frame, new Vector3(...direction).normalize()))
  // Two panes on one sheet: the context and the close-up, side by side, so
  // the transcript and the wire still carry one image per round.
  const sheet = detail ? document.createElement('canvas') : null
  const ctx = sheet?.getContext('2d') ?? null
  let url: string
  if (detail && sheet && ctx) {
    sheet.width = SIZE * 2
    sheet.height = SIZE
    ctx.drawImage(gl.domElement, 0, 0)
    gl.render(scene, frameCamera(detail.frame, new Vector3(...detail.direction).normalize()))
    ctx.drawImage(gl.domElement, SIZE, 0)
    ctx.fillStyle = '#202020'
    ctx.fillRect(SIZE - 2, 0, 4, SIZE)
    url = sheet.toDataURL('image/jpeg', 0.85)
  } else {
    url = gl.domElement.toDataURL('image/jpeg', 0.85)
  }
  for (const item of owned) item.dispose()
  return url
}

/**
 * One shaded render the model asked for (design.md §6.4): a named direction,
 * optionally a cut, optionally framed on a box. The cut is a clipping plane
 * that removes the half nearer the camera; the interior it exposes is drawn as
 * the back faces in a flat darker tone.
 * ponytail: uncapped cut — a stencil cap is the upgrade if the open shell misleads.
 */
export function renderView(
  mesh: Mesh,
  request: ViewRequest,
  model: Box,
  ghost: Mesh | null = null,
  /** Where an `auto` view looks from — the caller's idealView. Without it, auto is iso. */
  from: Vec3 | null = null,
): string | null {
  const gl = acquire()
  if (!gl) return null
  const direction = new Vector3(
    ...(from ?? (request.view === 'auto' ? DIRECTIONS.iso : DIRECTIONS[request.view])),
  ).normalize()
  const up = request.view === 'top' || request.view === 'bottom' ? viewUp(request.view) : [0, 0, 1] as const
  const planes: Plane[] = []
  if (request.section) {
    const axis = new Vector3(...AXIS[request.section.axis])
    // Keep the far side: the normal points away from the camera along the axis.
    const sign = axis.dot(direction) > 0 ? -1 : 1
    planes.push(new Plane(axis.clone().multiplyScalar(sign), -sign * request.section.at))
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  geometry.setIndex(new BufferAttribute(mesh.indices, 1))
  const shell = new MeshLambertMaterial({ color: SHELL, side: FrontSide, clippingPlanes: planes, flatShading: true })
  const interior = new MeshBasicMaterial({ color: INTERIOR, side: BackSide, clippingPlanes: planes })
  const edges = new EdgesGeometry(geometry, 30)
  const line = new LineBasicMaterial({ color: EDGE, clippingPlanes: planes })
  const scene = new Scene()
  scene.add(new AmbientLight(0xffffff, 1.4))
  const key = new DirectionalLight(0xffffff, 1.6)
  key.position.copy(direction).add(new Vector3(0.3, -0.2, 0.5))
  scene.add(key, new ThreeMesh(geometry, shell), new ThreeMesh(geometry, interior), new LineSegments(edges, line))
  const owned: { dispose(): void }[] = [geometry, shell, interior, edges, line]
  if (ghost && ghost.triangleCount > 0) {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(ghost.positions, 3))
    g.setIndex(new BufferAttribute(ghost.indices, 1))
    const tint = new MeshBasicMaterial({
      color: GHOST, transparent: true, opacity: 0.18, depthWrite: false, side: BackSide, clippingPlanes: planes,
    })
    const outline = new EdgesGeometry(g, 30)
    const ink = new LineBasicMaterial({ color: GHOST, clippingPlanes: planes })
    scene.add(new ThreeMesh(g, tint), new LineSegments(outline, ink))
    owned.push(g, tint, outline, ink)
  }
  gl.render(scene, frameCamera(request.box ?? model, direction, up))
  const url = gl.domElement.toDataURL('image/jpeg', 0.85)
  for (const item of owned) item.dispose()
  return url
}
