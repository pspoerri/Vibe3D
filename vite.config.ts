// vitest/config, not vite — Vite's own defineConfig has no `test` key.
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * `git describe`: the tag itself on a release, `v0.2.0-3-gabc1234[-dirty]`
 * past it. The commit is empty exactly when the build is the clean tag — it is
 * what the footer links to otherwise. No git (a tarball): the package version.
 */
const { version, commit } = (() => {
  try {
    const git = (cmd: string): string => execSync(cmd, { encoding: 'utf8' }).trim()
    const described = git('git describe --tags --dirty')
    return {
      version: described,
      commit: described === git('git describe --tags --abbrev=0') ? '' : git('git rev-parse --short HEAD'),
    }
  } catch {
    return { version: `v${pkg.version}`, commit: '' }
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
