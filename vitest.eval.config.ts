// `pnpm eval`: the turn controller against a real model and the real kernel.
// Kept out of `pnpm test` by its own include; gated on OPENROUTER_API_KEY inside.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['eval/**/*.eval.ts'], testTimeout: 15 * 60_000, hookTimeout: 60_000 },
})
