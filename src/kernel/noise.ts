/** Printed unconditionally by the wasm build, including on successful runs. */
const NOISE = [/^Could not initialize localization/]

const HEAD = 50
const TAIL = 50

/** Drops the kernel's unconditional chatter and blank lines. */
function dropNoise(stderr: string): string[] {
  return stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !NOISE.some((re) => re.test(line)))
}

/**
 * Keeps the head and the tail rather than truncating, because the fatal
 * message is usually last and the root-cause include is usually first.
 */
function capLines(lines: string[]): string {
  if (lines.length <= HEAD + TAIL) return lines.join('\n')
  const omitted = lines.length - HEAD - TAIL
  return [...lines.slice(0, HEAD), `... ${omitted} more lines ...`, ...lines.slice(-TAIL)].join('\n')
}

/**
 * Display form. The kernel only ever sees our virtual path, so show the user a
 * name they recognise.
 */
export function stripKernelNoise(stderr: string): string {
  return capLines(dropNoise(stderr).map((line) => line.replaceAll('/in.scad', 'model.scad')))
}

/**
 * Model form, for the compile-retry loop (design.md §5).
 *
 * Same noise filter and same cap, but it NEVER rewrites a path or a line
 * number — the model has to be able to trust the diagnostic against the source
 * it just wrote. The noise filter still applies: without it every retry message
 * would open with "Could not initialize localization", which reads to a model
 * like a first error to repair.
 */
export function stderrForModel(stderr: string): string {
  return capLines(dropNoise(stderr))
}
