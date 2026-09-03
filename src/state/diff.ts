/**
 * A line diff between two versions of the source, for the version picker.
 * Plain LCS over lines: the sources are a few hundred lines, so O(n·m) is
 * nothing, and it is the answer with no dependency.
 */
export interface DiffLine {
  kind: ' ' | '-' | '+'
  text: string
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! })
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) out.push({ kind: '+', text: b[j++]! })
    else out.push({ kind: '-', text: a[i++]! })
  }
  return out
}

/** The changed lines with `context` unchanged lines around each run; `…` between runs. */
export function hunks(lines: readonly DiffLine[], context = 2): DiffLine[] {
  const keep = new Set<number>()
  lines.forEach((line, k) => {
    if (line.kind === ' ') return
    for (let d = -context; d <= context; d++) keep.add(k + d)
  })
  const out: DiffLine[] = []
  let gap = false
  lines.forEach((line, k) => {
    if (keep.has(k)) {
      if (gap && out.length > 0) out.push({ kind: ' ', text: '…' })
      gap = false
      out.push(line)
    } else gap = true
  })
  return out
}
