import { expect, test } from 'vitest'
import { COMPACT_PROMPT, SYSTEM_PROMPT, systemPromptFor } from './prompt'

test('the prompt states the output contract and the $fn rule', () => {
  expect(SYSTEM_PROMPT).toMatch(/```/)
  expect(SYSTEM_PROMPT).toMatch(/\$fn/)
})

test('metric adds nothing — it is already the language OpenSCAD speaks', () => {
  expect(systemPromptFor('mm')).toBe(SYSTEM_PROMPT)
})

test('imperial tells the model how to read the user, not what to emit', () => {
  const prompt = systemPromptFor('in')
  expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true)
  expect(prompt).toContain('25.4')
  // The source must stay metric: an inch literal in the source, or a scale
  // factor wrapped round the model, both break export and the -D overrides.
  expect(prompt).toMatch(/stays in millimetres/)
  expect(prompt).toMatch(/do not add a scale\s+factor/)
})

test('the compact prompt never asks for the source to be summarised', () => {
  expect(COMPACT_PROMPT).toMatch(/source/i)
})
