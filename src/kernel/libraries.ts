/**
 * OpenSCAD libraries for `include <BOSL2/std.scad>`: the BOSL2 library
 * (BSD-2-Clause), vendored as one zip and written into the kernel FS beside
 * the source, so a relative include resolves. Only when the source names it:
 * the unzip and the write are paid per compile, and most parts want neither.
 */
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import type { OpenSCADModule } from './vendor/openscad.js'

/** `include <BOSL2/...>` or `use <BOSL2/...>` anywhere in the source. */
export const usesLibrary = (source: string): boolean => /\b(include|use)\s*<\s*BOSL2\//.test(source)

/** Unzips the library into the kernel FS at `/BOSL2/…`. Before callMain. */
export function installLibraries(kernel: Pick<OpenSCADModule, 'FS'>, zip: Uint8Array): void {
  const made = new Set<string>()
  for (const [path, bytes] of Object.entries(unzipSync(zip))) {
    if (path.endsWith('/')) continue
    const dir = `/${path.slice(0, path.lastIndexOf('/'))}`
    if (dir !== '/' && !made.has(dir)) {
      try {
        kernel.FS.mkdir(dir)
      } catch {
        // Already there.
      }
      made.add(dir)
    }
    kernel.FS.writeFile(`/${path}`, bytes)
  }
}
