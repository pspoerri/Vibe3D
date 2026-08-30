import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  // Test the real build artifact, not the dev server — dev and prod differ in
  // exactly the ways this test exists to catch.
  webServer: {
    // --strictPort so a port collision fails loudly instead of silently binding
    // elsewhere; reuseExistingServer stays off so we never test somebody else's
    // server. 4173 is Vite's default and is commonly already taken.
    command: 'pnpm build && pnpm preview --port 4319 --strictPort',
    url: 'http://localhost:4319',
    reuseExistingServer: false,
    timeout: 180_000,
  },
  use: { baseURL: 'http://localhost:4319' },
  // The kernel is a 10.7 MB download plus a compile.
  timeout: 120_000,
})
