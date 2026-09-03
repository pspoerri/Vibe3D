import { expect, test } from 'vitest'
import { diffLines, hunks } from './diff'

test('a changed line is one removal and one addition; the rest is context', () => {
  const before = 'a\nb\nc\nd'
  const after = 'a\nB\nc\nd\ne'
  expect(diffLines(before, after).map((l) => l.kind + l.text)).toEqual([' a', '-b', '+B', ' c', ' d', '+e'])
  expect(diffLines('x', 'x')).toEqual([{ kind: ' ', text: 'x' }])
})

test('hunks keep two lines of context around each change and mark the gaps', () => {
  const lines = diffLines('1\n2\n3\n4\n5\n6\n7\n8\n9', '1\n2\n3\n4\n5\n6\n7\n8\nnine')
  expect(hunks(lines).map((l) => l.kind + l.text)).toEqual([' 7', ' 8', '-9', '+nine'])
  const two = diffLines('1\n2\n3\n4\n5\n6\n7\n8\n9', 'one\n2\n3\n4\n5\n6\n7\n8\nnine')
  expect(hunks(two, 1).map((l) => l.kind + l.text)).toEqual(['-1', '+one', ' 2', ' …', ' 8', '-9', '+nine'])
})
