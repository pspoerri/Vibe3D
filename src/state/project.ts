import { reviveDoc, type Doc } from './documents'

export const PROJECT_TYPE = 'vibe3d/project'
export const SCHEMA_VERSION = 1

/**
 * Named fields, never a spread: design.md §7 — the file must not be able to
 * grow a secret by accident. `id` stays behind so an import can never collide
 * with a row already open.
 */
export function exportProject(doc: Doc): string {
  const { name, source, head, versions, chat } = doc
  return JSON.stringify(
    { type: PROJECT_TYPE, schemaVersion: SCHEMA_VERSION, name, source, head, versions, chat },
    null,
    2,
  )
}

/** Throws with a message meant for the user. */
export function importProject(text: string, id: string, now: number, taken: string[] = []): Doc {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file is not JSON.')
  }
  const p = raw as { type?: unknown; schemaVersion?: unknown } | null
  if (!p || typeof p !== 'object' || p.type !== PROJECT_TYPE || typeof p.schemaVersion !== 'number') {
    throw new Error('That file is not a Vibe3D project.')
  }
  if (p.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `This project was saved by a newer Vibe3D (schema ${p.schemaVersion}); update the app to open it.`,
    )
  }
  const doc = reviveDoc({ ...p, id, createdAt: now, updatedAt: now }, now, taken)
  if (!doc) throw new Error('That project file has no source in it.')
  return doc
}
