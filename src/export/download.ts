/** The kernel formats a user can download. OFF stays internal: it is the viewport's wire format. */
export type DownloadFormat = 'binstl' | '3mf' | 'obj'

export const MIME: Record<DownloadFormat, string> = {
  binstl: 'model/stl',
  '3mf': 'model/3mf',
  obj: 'model/obj',
}

export const EXTENSION: Record<DownloadFormat, string> = { binstl: 'stl', '3mf': '3mf', obj: 'obj' }

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
