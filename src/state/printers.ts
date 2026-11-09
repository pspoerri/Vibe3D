/**
 * Common printers and their build volumes in mm, from the makers' spec sheets.
 * The setting stays the three numbers; a preset is only a way to fill them in,
 * and the name is read back by matching, so no second setting can disagree.
 */
export const PRINTERS: readonly { name: string; bed: readonly [number, number, number] }[] = [
  { name: 'Bambu Lab X1, P1 or A1', bed: [256, 256, 256] },
  { name: 'Bambu Lab A1 mini or Prusa MINI', bed: [180, 180, 180] },
  { name: 'Prusa MK4', bed: [250, 210, 220] },
  { name: 'Prusa Core One', bed: [250, 220, 270] },
  { name: 'Prusa XL', bed: [360, 360, 360] },
  { name: 'Creality Ender-3', bed: [220, 220, 250] },
]

/** The preset whose volume this is, if any. Printers that share a volume share an entry. */
export const printerOf = (bed: readonly number[]): string | null =>
  PRINTERS.find((p) => p.bed.every((n, i) => n === bed[i]))?.name ?? null

/**
 * Whether the part fits, as the person printing it would see it: turned a
 * quarter on the plate counts. Looser than the model's own check in
 * meshChecks, which wants the part laid out to fit as it stands.
 */
export function fitsBed(size: readonly number[], bed: readonly number[]): boolean {
  const within = (a: number, b: number) => size[a]! <= bed[b]! + 0.01
  return within(2, 2) && ((within(0, 0) && within(1, 1)) || (within(0, 1) && within(1, 0)))
}
