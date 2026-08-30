export interface OpenSCADFS {
  writeFile(path: string, data: string | Uint8Array): void
  readFile(path: string): Uint8Array
  unlink(path: string): void
}

export interface OpenSCADModule {
  FS: OpenSCADFS
  /** Runs main() to process exit — the module instance is single-use afterwards. */
  callMain(args: string[]): number
}

export interface OpenSCADOptions {
  noInitialRun?: boolean
  locateFile?: (path: string) => string
  print?: (text: string) => void
  printErr?: (text: string) => void
}

declare const OpenSCAD: (options?: OpenSCADOptions) => Promise<OpenSCADModule>
export default OpenSCAD
