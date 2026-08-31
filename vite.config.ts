// vitest/config, not vite — Vite's own defineConfig has no `test` key.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/** Empty on the release tag itself (or with no git); the short commit hash otherwise. */
const commit = (() => {
  try {
    const git = (cmd: string): string => execSync(cmd, { encoding: 'utf8' }).trim()
    return git('git tag --points-at HEAD').split('\n').includes(`v${version}`) ? '' : git('git rev-parse --short HEAD')
  } catch {
    return ''
  }
})()

/**
 * 'wasm-unsafe-eval' is mandatory: without it Chromium refuses
 * WebAssembly.compile and the kernel dies on first compile. Full 'unsafe-eval'
 * is not needed — the vendored glue has no eval() and no new Function.
 * 'unsafe-inline' styles are required because CodeMirror injects its stylesheet
 * at runtime. connect-src is the point of the exercise: it is what stops an
 * injected script from posting the user's API key anywhere else.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://openrouter.ai",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'csp-meta',
      // Build only. In dev, @vitejs/plugin-react injects an inline react-refresh
      // preamble and the HMR client opens a websocket, so a static meta tag in
      // index.html would serve a blank page — and `pnpm e2e`, which runs against
      // the built artifact, would never catch it.
      apply: 'build',
      transformIndexHtml: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend' as const,
        },
      ],
    },
  ],
  // Relative base so one build artifact deploys to a GH Pages subpath,
  // a custom domain, or anywhere else. Forbids a path-based router.
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version), __APP_COMMIT__: JSON.stringify(commit) },
  worker: { format: 'es' },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
