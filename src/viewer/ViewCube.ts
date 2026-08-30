import {
  BoxGeometry, CanvasTexture, EdgesGeometry, LineBasicMaterial, LineSegments, Mesh,
  MeshBasicMaterial, OrthographicCamera, Raycaster, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three'
import type { StandardView } from './camera'

const SIZE_PX = 84
const FACE_FILL = '#ffffff'
const LABEL_COLOR = '#414741'
const HOVER_TINT = 0xb8860b
const EDGE_COLOR = 0xb0b6aa

/**
 * BoxGeometry orders its material groups +X, −X, +Y, −Y, +Z, −Z. The cube is
 * rotated +90° about X so its local +Y lands on world +Z; that both maps the
 * faces to the labels below and keeps every side label upright, because
 * three's box UVs run their v axis along local +Y — which is now world up.
 */
const FACES: { view: StandardView; label: string }[] = [
  { view: 'right', label: 'RIGHT' },
  { view: 'left', label: 'LEFT' },
  { view: 'top', label: 'TOP' },
  { view: 'bottom', label: 'BOT' },
  { view: 'front', label: 'FRONT' },
  { view: 'back', label: 'BACK' },
]

function faceTexture(label: string): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = FACE_FILL
  ctx.fillRect(0, 0, 128, 128)
  ctx.fillStyle = LABEL_COLOR
  ctx.font = '600 20px ui-monospace, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, 64, 64)
  return new CanvasTexture(canvas)
}

export interface ViewCube {
  /** Point the cube the same way as the main camera. `offset` is camera − target. */
  update(offset: Vector3, up: Vector3): void
  dispose(): void
}

/**
 * Orientation widget: a small cube mirroring the main camera, whose faces snap
 * it to a standard view. Its own tiny WebGL context — 84 px square and 7 draw
 * calls, redrawn only when the main camera moves.
 */
export function createViewCube(host: HTMLElement, onPick: (view: StandardView) => void): ViewCube {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.setSize(SIZE_PX, SIZE_PX, false)
  host.appendChild(renderer.domElement)

  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 20)

  const geometry = new BoxGeometry(1, 1, 1)
  const textures = FACES.map((face) => faceTexture(face.label))
  const materials = textures.map((map) => new MeshBasicMaterial({ map, toneMapped: false }))
  const cube = new Mesh(geometry, materials)
  cube.rotation.x = Math.PI / 2
  scene.add(cube)

  const edgeGeometry = new EdgesGeometry(geometry)
  const edgeMaterial = new LineBasicMaterial({ color: EDGE_COLOR })
  const edges = new LineSegments(edgeGeometry, edgeMaterial)
  // Nudged outwards so the outline does not z-fight with the faces it traces.
  edges.scale.setScalar(1.002)
  cube.add(edges)

  const raycaster = new Raycaster()
  const pointer = new Vector2()
  const offset = new Vector3(1, -1, 1)
  const up = new Vector3(0, 0, 1)
  let hovered = -1

  const render = () => {
    camera.position.copy(offset).normalize().multiplyScalar(3)
    camera.up.copy(up)
    camera.lookAt(0, 0, 0)
    renderer.render(scene, camera)
  }

  const faceAt = (event: PointerEvent | MouseEvent): number => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    // `false` — the edge outline is a child and must never swallow a pick.
    const hit = raycaster.intersectObject(cube, false)[0]
    return hit?.face?.materialIndex ?? -1
  }

  const setHover = (index: number) => {
    if (index === hovered) return
    materials[hovered]?.color.set(0xffffff)
    materials[index]?.color.set(HOVER_TINT)
    hovered = index
    renderer.domElement.style.cursor = index === -1 ? 'default' : 'pointer'
    render()
  }

  const onMove = (event: PointerEvent) => setHover(faceAt(event))
  const onLeave = () => setHover(-1)
  const onClick = (event: MouseEvent) => {
    const face = FACES[faceAt(event)]
    if (face) onPick(face.view)
  }

  renderer.domElement.addEventListener('pointermove', onMove)
  renderer.domElement.addEventListener('pointerleave', onLeave)
  renderer.domElement.addEventListener('click', onClick)
  render()

  return {
    update(nextOffset, nextUp) {
      offset.copy(nextOffset)
      up.copy(nextUp)
      render()
    },
    dispose() {
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      renderer.domElement.removeEventListener('click', onClick)
      geometry.dispose()
      edgeGeometry.dispose()
      edgeMaterial.dispose()
      materials.forEach((material) => material.dispose())
      textures.forEach((texture) => texture.dispose())
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
