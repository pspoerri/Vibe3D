// vitest/config, not vite — Vite's own defineConfig has no `test` key.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Relative base so one build artifact deploys to a GH Pages subpath,
  // a custom domain, or anywhere else. Forbids a path-based router.
  base: './',
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
