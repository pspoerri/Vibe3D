export type ExportFormat = 'off' | 'binstl' | '3mf'

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
   * What lets a source `import()` a mesh — the diff booleans of design.md §6.
   */
  files?: Readonly<Record<string, Uint8Array>>
}

export type CompileResponse =
  | { type: 'ok'; data: Uint8Array; stderr: string; ms: number }
  | { type: 'error'; stderr: string; ms: number }
