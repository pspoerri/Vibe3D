// Builds the copy-installable skill into dist/skill: the CLI and the look
// page bundled by bun into one file each, the kernel's vendor files beside
// them, SKILL.md and the wrapper copied. Needs bun on PATH.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const skill = new URL('skills/vibe3d/', root)
const vendor = new URL('src/kernel/vendor/', root)
const out = new URL('dist/skill/', root)
const path = (url) => fileURLToPath(url)

rmSync(out, { recursive: true, force: true })
mkdirSync(new URL('vendor/', out), { recursive: true })

const bun = (...args) => {
  const r = spawnSync('bun', ['build', ...args], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
bun(path(new URL('cli.ts', skill)), '--target=bun', '--outfile', path(new URL('cli.js', out)))
bun(path(new URL('look.ts', skill)), '--target=browser', '--format=iife', '--outfile', path(new URL('look.js', out)))

for (const name of ['SKILL.md', 'vibe3d']) cpSync(new URL(name, skill), new URL(name, out))
for (const name of ['openscad.wasm', 'BOSL2.zip', 'fonts']) cpSync(new URL(name, vendor), new URL(`vendor/${name}`, out), { recursive: true })
console.log(`built ${path(out)}`)
