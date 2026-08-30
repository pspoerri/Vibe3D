export const MIME = {
  binstl: 'model/stl',
  '3mf': 'model/3mf',
} as const

export function downloadBlob(data: Uint8Array, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke on the next frame; revoking synchronously can cancel the download.
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}
