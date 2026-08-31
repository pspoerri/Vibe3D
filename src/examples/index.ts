import plate from './mounting-plate.scad?raw'
import plant from './potted-plant.scad?raw'

/**
 * Example documents. Each is a `.scad` file imported verbatim, so it is also
 * what you get by opening the file in desktop OpenSCAD. The document's name
 * comes from the file's first comment line, like any other source.
 */
export const EXAMPLES: readonly { name: string; source: string }[] = [
  { name: 'A mounting plate', source: plate },
  { name: 'A potted plant', source: plant },
]

/** The document a fresh browser boots into. */
export const STARTER = plate
