/**
 * Fonts for text(): the Liberation family (SIL OFL 1.1), OpenSCAD's own
 * default. The wasm build ships none and its fontconfig has no default
 * config path, so without this every text() rendered nothing — silently,
 * past a "Can't get font" warning.
 *
 * Installed per kernel instance, only when the source can use them: the
 * scan fontconfig does on startup is paid per compile, and most parts have
 * no text at all.
 */
import type { OpenSCADModule } from './vendor/openscad.js'

export const FONT_FILES = [
  'LiberationSans-Regular.ttf',
  'LiberationSans-Bold.ttf',
  'LiberationSans-Italic.ttf',
  'LiberationSans-BoldItalic.ttf',
  'LiberationSerif-Regular.ttf',
  'LiberationSerif-Bold.ttf',
  'LiberationSerif-Italic.ttf',
  'LiberationSerif-BoldItalic.ttf',
  'LiberationMono-Regular.ttf',
  'LiberationMono-Bold.ttf',
  'LiberationMono-Italic.ttf',
  'LiberationMono-BoldItalic.ttf',
] as const

export type FontFile = (typeof FONT_FILES)[number]
export type FontSet = Partial<Record<FontFile, Uint8Array>>

const DIR = '/fonts'
const CONF = `${DIR}/fonts.conf`
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${DIR}</dir>
  <cachedir>/tmp/fontconfig</cachedir>
</fontconfig>
`

/** text() or textmetrics() anywhere in the source — a comment too, which merely installs fonts for nothing. */
export const usesText = (source: string): boolean => /\btext\w*\s*\(/.test(source)

/** Writes the fonts and a config that lists them, and points fontconfig at it. Before callMain. */
export function installFonts(kernel: Pick<OpenSCADModule, 'FS' | 'ENV'>, fonts: FontSet): void {
  kernel.FS.mkdir(DIR)
  kernel.FS.writeFile(CONF, FONTS_CONF)
  for (const [name, bytes] of Object.entries(fonts)) kernel.FS.writeFile(`${DIR}/${name}`, bytes)
  kernel.ENV.FONTCONFIG_FILE = CONF
}
