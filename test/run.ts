// Compare published and patched TAP outcomes against each patch's expectedDivergence.
// Pins record existing behavior, including defects, and must agree on both builds.
import { buildPatchedBundle, loadPatches, BUNDLE } from '../apply.ts'
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

const PACKAGE_DIR = join(PROJECT_DIR, 'node_modules', '@supabase', 'lite')
const INSTALLED_BUNDLE = join(PACKAGE_DIR, 'dist', BUNDLE)
const PUBLISHED_BACKUP = join(PACKAGE_DIR, 'dist', 'index.published.js')
const PATCHED_DIR = join(PROJECT_DIR, 'dist-patched')

if (!existsSync(INSTALLED_BUNDLE)) {
   console.error(`published build not found: ${INSTALLED_BUNDLE}\nrun \`npm ci\` first`)
   process.exit(2)
}

function findPatchTests(root: string): string[] {
   if (!existsSync(root)) return []
   return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'test.ts')))
      .map((entry) => join(root, entry.name, 'test.ts'))
}

function findPinTests(root: string): string[] {
   if (!existsSync(root)) return []
   return readdirSync(root)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => join(root, name))
}

const testFiles = [
   ...findPatchTests(join(PROJECT_DIR, 'fixes')),
   ...findPatchTests(join(PROJECT_DIR, 'features')),
   ...findPinTests(join(PROJECT_DIR, 'pins')),
]

function runTests(label: string): Map<string, boolean> {
   const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...testFiles], {
      encoding: 'utf8',
      cwd: PROJECT_DIR,
   })
   const results = parseTapResults((result.stdout ?? '') + (result.stderr ?? ''))
   const passed = [...results.values()].filter(Boolean).length
   console.log(`${label.padEnd(11)} ${passed}/${results.size} passed`)
   return results
}

function parseTapResults(tap: string): Map<string, boolean> {
   // TAP announces suites before their children but prints suite results afterwards.
   // Keep the names by indentation level (four spaces) to reconstruct full test paths.
   const results = new Map<string, boolean>()
   const stack: string[] = []
   const depthOf = (indent: string) => Math.floor(indent.length / 4)

   for (const line of tap.split('\n')) {
      const subtest = line.match(/^(\s*)# Subtest: (.*)$/)
      if (subtest) {
         const depth = depthOf(subtest[1])
         stack.length = depth
         stack[depth] = subtest[2].trim()
         continue
      }
      const result = line.match(/^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*?)(\s+#.*)?$/)
      if (!result) continue
      const depth = depthOf(result[1])
      results.set([...stack.slice(0, depth), result[3].trim()].join(' > '), result[2] === 'ok')
   }

   return results
}

const patches = await loadPatches()
await buildPatchedBundle(PATCHED_DIR)

console.log(`test files: ${testFiles.length}`)
console.log(`patches:    ${patches.map((patch) => patch.id).join(', ')}\n`)

// Swap in place because the bundle imports itself by package name. Always restore the original.
copyFileSync(INSTALLED_BUNDLE, PUBLISHED_BACKUP)
let published: Map<string, boolean>
let patched: Map<string, boolean>
try {
   published = runTests('published')
   copyFileSync(join(PATCHED_DIR, BUNDLE), INSTALLED_BUNDLE)
   patched = runTests('patched')
} finally {
   copyFileSync(PUBLISHED_BACKUP, INSTALLED_BUNDLE)
   rmSync(PUBLISHED_BACKUP, { force: true })
}

const names = new Set([...published.keys(), ...patched.keys()])
const observed = [...names]
   .filter((name) => published.get(name) !== patched.get(name))
   .map((name) => ({ name, before: published.get(name), after: patched.get(name) }))

const declared = new Map(patches.flatMap((patch) => patch.expectedDivergence.map((name) => [name, patch] as const)))
const confirmed = observed.filter(
   (change) => declared.has(change.name) && change.before === false && change.after === true,
)
const unexpected = observed.filter((change) => !confirmed.includes(change))
const missing = [...declared.keys()].filter((name) => !confirmed.some((change) => change.name === name))

console.log()
if (!published.size) {
   console.log('FAILED: the published build produced no results')
   process.exit(1)
}

if (confirmed.length) {
   console.log(`PROVEN: ${confirmed.length} assertions fail on the published build and pass with the patches`)
   for (const change of confirmed) console.log(`   + ${declared.get(change.name)!.id}  ${change.name}`)
}

if (!unexpected.length && !missing.length) {
   console.log(`\nUNTOUCHED: the other ${names.size - confirmed.length} assertions behave the same on both`)
   process.exit(0)
}

if (missing.length) {
   console.log(`\nUNPROVEN: ${missing.length} declared divergences were not observed.`)
   console.log('Either the patch stopped applying, or the test no longer proves anything.')
   for (const name of missing) {
      const change = observed.find((change) => change.name === name)
      console.log(`   - ${declared.get(name)!.id}  ${name}`)
      console.log(`        ${change ? `published=${change.before} patched=${change.after}` : 'both builds agree'}`)
   }
}

if (unexpected.length) {
   console.log(`\nSIDE EFFECT: ${unexpected.length} assertions diverge but were not declared`)
   for (const change of unexpected) {
      console.log(`   ${change.name}\n      published=${change.before}  patched=${change.after}`)
   }
}

process.exit(1)
