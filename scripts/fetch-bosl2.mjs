// Fetches the BOSL2 library (BSD-2-Clause) at a pinned commit and packs its
// top-level .scad files and LICENSE into src/kernel/vendor/BOSL2.zip, which
// the kernel worker unzips into its FS for a source that includes it. Runs at
// install and before build, test and dev; a no-op when the pinned zip is there.
// Bump the pin here, or once with BOSL2_COMMIT=<sha> in the environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { unzipSync, zipSync } from 'three/examples/jsm/libs/fflate.module.js'

const COMMIT = process.env.BOSL2_COMMIT ?? 'fcfce7c763863d8e66d5f36a551d11129ec1a607'
const OUT = new URL('../src/kernel/vendor/BOSL2.zip', import.meta.url)
const PIN = new URL('../src/kernel/vendor/BOSL2.zip.commit', import.meta.url)

if (existsSync(OUT) && existsSync(PIN) && readFileSync(PIN, 'utf8').trim() === COMMIT) process.exit(0)

const url = `https://github.com/BelfrySCAD/BOSL2/archive/${COMMIT}.zip`
const response = await fetch(url)
if (!response.ok) {
  console.error(`BOSL2: ${url} answered ${response.status}`)
  process.exit(1)
}
const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
const files = {}
for (const [path, bytes] of Object.entries(archive)) {
  // BOSL2-<commit>/name.scad is the library proper; tests, examples and docs live in subdirectories.
  const m = /^[^/]+\/([^/]+\.scad|LICENSE)$/.exec(path)
  if (m) files[`BOSL2/${m[1]}`] = bytes
}
const count = Object.keys(files).length
if (count < 50) {
  console.error(`BOSL2: expected the library's files, found ${count}`)
  process.exit(1)
}
mkdirSync(new URL('.', OUT), { recursive: true })
writeFileSync(OUT, zipSync(files, { level: 9 }))
writeFileSync(PIN, `${COMMIT}\n`)
console.log(`BOSL2 ${COMMIT.slice(0, 7)}: ${count} files, src/kernel/vendor/BOSL2.zip`)
