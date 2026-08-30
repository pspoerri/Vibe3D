import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../llm/openrouter'

/**
 * Portable because it holds no secret. The API key lives in its own module and
 * its own record (state/key.ts): structural typing cannot keep a secret out of
 * an object like this one, so the separation is physical instead of typed.
 */
export interface PortableSettings {
  baseUrl: string
  model: string
}

export const DEFAULT_SETTINGS: PortableSettings = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
}

const RECORD = 'vibe3d.settings'
/** ponytail: the pre-rename record. Delete once no browser can still hold it. */
const LEGACY = 'aimodeller.settings'

/**
 * Never throws. A corrupt blob and a browser blocking site data both throw from
 * inside localStorage, and this runs during App boot.
 */
export function loadSettings(): PortableSettings {
  let stored: Partial<PortableSettings> | null = null
  try {
    const raw = localStorage.getItem(RECORD) ?? localStorage.getItem(LEGACY)
    stored = JSON.parse(raw ?? 'null') as Partial<PortableSettings>
  } catch {
    // Falls through to the defaults below rather than returning DEFAULT_SETTINGS
    // itself, so no caller can mutate the constant every later reader sees.
  }
  return {
    baseUrl: typeof stored?.baseUrl === 'string' ? stored.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: typeof stored?.model === 'string' ? stored.model : DEFAULT_SETTINGS.model,
  }
}

export function saveSettings(next: PortableSettings): void {
  try {
    localStorage.setItem(RECORD, JSON.stringify(next))
  } catch {
    // Private mode or a full quota. Losing a preference is not worth a dialog.
  }
}
