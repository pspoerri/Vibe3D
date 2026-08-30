/**
 * Display units. Model space stays millimetres always (design.md §4): the
 * kernel, the source, the exported 3MF and every `-D` override are metric, and
 * this converts on the way to the screen and nowhere else. A part authored in
 * inches would be a different program, not a different readout.
 */
export type Units = 'mm' | 'in'

const MM_PER_IN = 25.4
/** mm³ per in³ — 25.4³, spelled out so it is checkable by eye. */
const MM3_PER_IN3 = MM_PER_IN * MM_PER_IN * MM_PER_IN

const RECORD = 'vibe3d.units'
/** ponytail: the pre-rename record. Delete once no browser can still hold it. */
const LEGACY = 'aimodeller.units'

export function loadUnits(): Units {
  try {
    return (localStorage.getItem(RECORD) ?? localStorage.getItem(LEGACY)) === 'in' ? 'in' : 'mm'
  } catch {
    return 'mm'
  }
}

export function saveUnits(units: Units): void {
  try {
    localStorage.setItem(RECORD, units)
  } catch {
    // Private mode or a full quota. Losing a preference is not worth a dialog.
  }
}

export const lengthLabel = (units: Units): string => (units === 'mm' ? 'mm' : 'in')
export const volumeLabel = (units: Units): string => (units === 'mm' ? 'cm³' : 'in³')

/**
 * Three decimals in inches, one in millimetres: 0.1 mm is about the finest
 * thing a printer resolves, and 0.001 in is the nearest honest equivalent.
 * Two decimals would round a 0.4 mm nozzle wall to 0.02 in and lose the
 * distinction the number exists to show.
 */
export const formatLength = (mm: number, units: Units): string =>
  units === 'mm' ? mm.toFixed(1) : (mm / MM_PER_IN).toFixed(3)

/** Volumes are reported in cm³ / in³ — mm³ runs to six digits on any real part. */
export const formatVolume = (mm3: number, units: Units): string =>
  units === 'mm' ? (mm3 / 1000).toFixed(2) : (mm3 / MM3_PER_IN3).toFixed(3)
