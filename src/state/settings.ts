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
  /**
   * Per model, because the levels mean different things to different models
   * and a model without reasoning ignores the knob on the wire: switching
   * models must not carry the last one's level along. Absent is high.
   */
  thinking: Partial<Record<string, Thinking>>
  /** The printer's build volume, mm: the plate outline, and a check the model box is graded against. */
  bed: [number, number, number]
}

/** Bambu A1 / P1S / X1C / X1E share this build volume. */
export const DEFAULT_BED: [number, number, number] = [256, 256, 256]

export const DEFAULT_SETTINGS: PortableSettings = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  thinking: {},
  bed: DEFAULT_BED,
}

/** "220 x 220 x 250", "256×256", "256" — one to three sizes; a missing one repeats the last. null when unreadable. */
export function parseBed(text: string): [number, number, number] | null {
  const sizes = text.split(/[x×*,\s]+/i).filter(Boolean).map(Number)
  if (sizes.length === 0 || sizes.length > 3 || sizes.some((n) => !Number.isFinite(n) || n <= 0)) return null
  const x = sizes[0]!
  const y = sizes[1] ?? x
  return [x, y, sizes[2] ?? y]
}

/** The current model's level. */
export const thinkingOf = (s: PortableSettings): Thinking => s.thinking[s.model] ?? 'high'

export const withThinking = (s: PortableSettings, level: Thinking): PortableSettings => ({
  ...s,
  thinking: { ...s.thinking, [s.model]: level },
})

const isLevel = (v: unknown): v is Thinking => THINKING.includes(v as Thinking)

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
  let model = typeof stored?.model === 'string' ? stored.model : DEFAULT_SETTINGS.model
  // ponytail: the old fixed default; the alias it became follows the catalogue.
  if (model === 'google/gemini-3.7-flash') model = DEFAULT_MODEL
  const raw = stored?.thinking as unknown
  // The pre-per-model record held one level for every model: it becomes this model's.
  const thinking: Partial<Record<string, Thinking>> = isLevel(raw)
    ? { [model]: raw }
    : raw && typeof raw === 'object'
      ? Object.fromEntries(Object.entries(raw).filter(([, v]) => isLevel(v)) as [string, Thinking][])
      : {}
  const bed = stored?.bed
  return {
    baseUrl: typeof stored?.baseUrl === 'string' ? stored.baseUrl : DEFAULT_SETTINGS.baseUrl,
    model,
    thinking,
    bed: Array.isArray(bed) && bed.length === 3 && bed.every((n) => typeof n === 'number' && n > 0)
      ? (bed as [number, number, number])
      : DEFAULT_BED,
  }
}

export function saveSettings(next: PortableSettings): void {
  try {
    localStorage.setItem(RECORD, JSON.stringify(next))
  } catch {
    // Private mode or a full quota. Losing a preference is not worth a dialog.
  }
}
