import { expect, test } from 'vitest'
import { COMPACT_PROMPT, SYSTEM_PROMPT, systemPromptFor, verifyMessage } from './prompt'

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

test('a text-only turn gets byte-identical prompts to before images existed', () => {
  // The prefix is the cacheable part. Adding a clause unconditionally would
  // move it for every user who never attaches anything.
  expect(systemPromptFor('mm', false)).toBe(systemPromptFor('mm'))
  expect(systemPromptFor('mm')).toBe(SYSTEM_PROMPT)
})

test('an image turn is told to read layout from the picture and dimensions from the words', () => {
  const prompt = systemPromptFor('mm', true)
  expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true)
  expect(prompt).toContain('Do NOT read dimensions')
})

test('the image clause composes with imperial rather than replacing it', () => {
  const prompt = systemPromptFor('in', true)
  expect(prompt).toContain('1 in = 25.4 mm')
  expect(prompt).toContain('Do NOT read dimensions')
})

test('the verification message wraps the report in structured questions, never a bare look', () => {
  const text = verifyMessage('{ "volume_mm3": 1 }', true)
  expect(text).toContain('{ "volume_mm3": 1 }')
  expect(text).toContain('green')
  expect(text).toContain('magenta')
  expect(text).toMatch(/Yes, No or Unclear/)
  expect(text).toMatch(/never from a picture/)
  expect(text).toMatch(/NO code block/)
  expect(text).not.toMatch(/look right/i)
})

test('without a render the message says so and asks the same questions', () => {
  const text = verifyMessage('{}', false)
  expect(text).toContain('No render is attached')
  expect(text).not.toContain('magenta')
  expect(text).toMatch(/Yes, No or Unclear/)
})
