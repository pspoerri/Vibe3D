/** Printed unconditionally by the wasm build, including on successful runs. */
const NOISE = [/^Could not initialize localization/]

const HEAD = 50
const TAIL = 50

/**
 * Cleans kernel stderr for display and, in Milestone 2, for the model.
 *
 * The cap keeps the head and the tail rather than truncating, because the fatal
 * message is usually last and the root-cause include is usually first.
 */
export function stripKernelNoise(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !NOISE.some((re) => re.test(line)))
    // The kernel only ever sees our virtual path; show the user a real name.
    .map((line) => line.replaceAll('/in.scad', 'model.scad'))

  if (lines.length <= HEAD + TAIL) return lines.join('\n')
  const omitted = lines.length - HEAD - TAIL
  return [
    ...lines.slice(0, HEAD),
    `... ${omitted} more lines ...`,
    ...lines.slice(-TAIL),
  ].join('\n')
}
