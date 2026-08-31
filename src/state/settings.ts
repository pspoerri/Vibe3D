import { DEFAULT_BASE_URL, DEFAULT_MODEL } from '../llm/openrouter'

/**
 * Portable because it holds no secret. The API key lives in its own module and
 * its own record (state/key.ts): structural typing cannot keep a secret out of
 * an object like this one, so the separation is physical instead of typed.
 */
/** Off is one call per message. Any other level is the wire's reasoning effort AND permission to look, cut and correct. */
export type Thinking = 'off' | 'low' | 'medium' | 'high'
export const THINKING: readonly Thinking[] = ['off', 'low', 'medium', 'high']

export interface PortableSettings {
  baseUrl: string
  model: string
  thinking: Thinking
}

export const DEFAULT_SETTINGS: PortableSettings = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  thinking: 'off',
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
  const thinking = stored?.thinking
  return {
    baseUrl: typeof stored?.baseUrl === 'string' ? stored.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model: typeof stored?.model === 'string' ? stored.model : DEFAULT_SETTINGS.model,
    thinking: THINKING.includes(thinking as Thinking) ? (thinking as Thinking) : DEFAULT_SETTINGS.thinking,
  }
}

export function saveSettings(next: PortableSettings): void {
  try {
    localStorage.setItem(RECORD, JSON.stringify(next))
  } catch {
    // Private mode or a full quota. Losing a preference is not worth a dialog.
  }
}
