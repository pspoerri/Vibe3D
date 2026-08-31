export type ExportFormat = 'off' | 'binstl' | '3mf' | 'obj'

export interface CompileRequest {
  source: string
  format: ExportFormat
  /**
   * OpenSCAD `-D` overrides, e.g. `wall=2.5`. Each entry becomes its own
   * `-D <entry>` pair. The text is spliced into the source and parsed, so it is
   * a code-injection surface: build entries ONLY with defineFor(), never from
   * free text.
   */
  defines?: readonly string[]
  /**
   * Written to the kernel's FS before main() runs, keyed by absolute path.
   * What lets a source `import()` a mesh — the diff booleans of design.md §6,
   * and the document's components (§8).
   */
  files?: Readonly<Record<string, Uint8Array>>
}

export type CompileResponse =
  | { type: 'ok'; data: Uint8Array; stderr: string; ms: number }
  | { type: 'error'; stderr: string; ms: number }

/** Where the source goes. A relative `import("x.stl")` resolves beside it, so components live at `/x.stl`. */
export const IN_PATH = '/in.scad'
export const outPath = (format: ExportFormat): string => `/out.${format}`

/**
 * The kernel's argv, shared by the worker and the real-kernel test so the
 * oracle runs exactly what production runs. `lazy-union` is what makes a part
 * a part (design.md §8): top-level statements stay separate objects, so the
 * 3MF carries one per statement, instead of being unioned into one solid.
 * A fresh array per call — Emscripten's callMain unshifts the program name
 * into the array it is handed.
 */
export function kernelArgs(format: ExportFormat, defines: readonly string[] = []): string[] {
  return [
    IN_PATH,
    '-o',
    outPath(format),
    `--export-format=${format}`,
    '--enable=lazy-union',
    ...defines.flatMap((define) => ['-D', define]),
  ]
}
