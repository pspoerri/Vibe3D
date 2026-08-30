export type ExportFormat = 'off' | 'binstl' | '3mf'

export interface CompileRequest {
  source: string
  format: ExportFormat
}

export type CompileResponse =
  | { type: 'ok'; data: Uint8Array; stderr: string; ms: number }
  | { type: 'error'; stderr: string; ms: number }
