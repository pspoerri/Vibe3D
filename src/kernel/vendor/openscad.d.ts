export interface OpenSCADFS {
  writeFile(path: string, data: string | Uint8Array): void
  readFile(path: string): Uint8Array
  unlink(path: string): void
  mkdir(path: string): void
}

export interface OpenSCADModule {
  FS: OpenSCADFS
  /** The program's environment, read when main() starts. */
  ENV: Record<string, string>
  /** Runs main() to process exit — the module instance is single-use afterwards. */
  callMain(args: string[]): number
}

export interface OpenSCADOptions {
  noInitialRun?: boolean
  locateFile?: (path: string) => string
  /** The module bytes, for a host with no fetch — the web glue has no Node file reader. */
  wasmBinary?: ArrayBuffer | Uint8Array
  print?: (text: string) => void
  printErr?: (text: string) => void
}

declare const OpenSCAD: (options?: OpenSCADOptions) => Promise<OpenSCADModule>
export default OpenSCAD
