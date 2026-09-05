import sign from './biergarten-sign.scad?raw'
import plate from './mounting-plate.scad?raw'
import plant from './potted-plant.scad?raw'

/**
 * Example documents. Each is a `.scad` file imported verbatim, so it is also
 * what you get by opening the file in desktop OpenSCAD. The document's name
 * comes from the file's first comment line, like any other source.
 */
export const EXAMPLES: readonly { name: string; slug: string; source: string }[] = [
  { name: 'A mounting plate', slug: 'mounting-plate', source: plate },
  { name: 'A potted plant', slug: 'potted-plant', source: plant },
  { name: 'A Biergarten sign', slug: 'biergarten-sign', source: sign },
]

/** The source an `#example=<slug>` link opens, or null when the hash is no such link. */
export function exampleFromHash(hash: string): string | null {
  return EXAMPLES.find((ex) => hash === `#example=${ex.slug}`)?.source ?? null
}

/** The document a fresh browser boots into. */
export const STARTER = plate
