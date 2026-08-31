// Runs every patch's tests against two builds and requires the result to differ in exactly the
// declared way.
//
//   published   node_modules/@supabase/lite/dist/index.js
//   patched     the same bundle with every patch applied
//
// A patch's own test asserts the CORRECT behaviour, so it fails on the published build by design.
// The patch is proven when its assertions fail there and pass here.
//
// `pins/` is the other, larger half: several hundred assertions describing what the published
// package does, defects included. They must answer the same on both builds, and an undeclared
// divergence is a failure — which is what catches a patch that touched more than it meant to.
//
// Both runs happen INSIDE node_modules/@supabase/lite, by swapping its dist/index.js: the bundle
// contains a self-import, so it only resolves correctly from its own location.
import { buildPatchedBundle, loadPatches, BUNDLE } from '../apply.ts'
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)

const HOST = join(PKG, 'node_modules', '@supabase', 'lite')
const ENTRY = join(HOST, 'dist', BUNDLE)
const BACKUP = join(HOST, 'dist', 'index.published.js')
const PATCHED = join(PKG, 'dist-patched')

if (!existsSync(ENTRY)) {
   console.error(`published build not found: ${ENTRY}\nrun \`npm i\` first`)
   process.exit(2)
}

const testFiles = (root: string) =>
   existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
           .filter((e) => e.isDirectory() && existsSync(join(root, e.name, 'test.ts')))
           .map((e) => join(root, e.name, 'test.ts'))
      : []

const pinFiles = (root: string) =>
   existsSync(root)
      ? readdirSync(root)
           .filter((name) => name.endsWith('.test.ts'))
           .map((name) => join(root, name))
      : []

const files = [...testFiles(join(PKG, 'fixes')), ...testFiles(join(PKG, 'features')), ...pinFiles(join(PKG, 'pins'))]

function run(label: string): Map<string, boolean> {
   const res = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', cwd: PKG })
   const tap = (res.stdout ?? '') + (res.stderr ?? '')

   // Names come from `# Subtest:` lines, results from `ok` / `not ok`. TAP prints a parent's result
   // after its children, so a child is read before its parent's name is known. Four spaces per level.
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

   console.log(`${label.padEnd(11)} ${[...results.values()].filter(Boolean).length}/${results.size} passed`)
   return results
}

const patches = await loadPatches()
await buildPatchedBundle(PATCHED)

console.log(`test files: ${files.length}`)
console.log(`patches:    ${patches.map((p) => p.id).join(', ')}\n`)

// The published bundle is restored whatever happens, so a crashed run never leaves the installed
// package holding a patched build.
copyFileSync(ENTRY, BACKUP)
let published: Map<string, boolean>
let patched: Map<string, boolean>
try {
   published = run('published')
   copyFileSync(join(PATCHED, BUNDLE), ENTRY)
   patched = run('patched')
} finally {
   copyFileSync(BACKUP, ENTRY)
   rmSync(BACKUP, { force: true })
}

const names = new Set([...published.keys(), ...patched.keys()])
const observed = [...names]
   .filter((n) => published.get(n) !== patched.get(n))
   .map((n) => ({ name: n, before: published.get(n), after: patched.get(n) }))

const declared = new Map(patches.flatMap((p) => p.expectedDivergence.map((t: string) => [t, p] as const)))
const confirmed = observed.filter((d) => declared.has(d.name) && d.before === false && d.after === true)
const unexpected = observed.filter((d) => !confirmed.includes(d))
const missing = [...declared.keys()].filter((t) => !confirmed.some((c) => c.name === t))

console.log()
if (!published.size) {
   console.log('FAILED: the published build produced no results')
   process.exit(1)
}

if (confirmed.length) {
   console.log(`PROVEN: ${confirmed.length} assertions fail on the published build and pass with the patches`)
   for (const d of confirmed) console.log(`   + ${declared.get(d.name)!.id}  ${d.name}`)
}

if (!unexpected.length && !missing.length) {
   console.log(`\nUNTOUCHED: the other ${names.size - confirmed.length} assertions behave the same on both`)
   process.exit(0)
}

if (missing.length) {
   console.log(`\nUNPROVEN: ${missing.length} declared divergences were not observed.`)
   console.log('Either the patch stopped applying, or the test no longer proves anything.')
   for (const t of missing) {
      const seen = observed.find((x) => x.name === t)
      console.log(`   - ${declared.get(t)!.id}  ${t}`)
      console.log(`        ${seen ? `published=${seen.before} patched=${seen.after}` : 'both builds agree'}`)
   }
}

if (unexpected.length) {
   console.log(`\nSIDE EFFECT: ${unexpected.length} assertions diverge but were not declared`)
   for (const d of unexpected) console.log(`   ${d.name}\n      published=${d.before}  patched=${d.after}`)
}

process.exit(1)
