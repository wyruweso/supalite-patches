// Runs each patch's reproduction against the installed package.
//
//   npm run repro              every patch
//   npm run repro 003 012      only these
//
// A reproduction lives beside its patch, so `fixes/002-client-errors-as-500/` holds the patch, the
// readable source, the test that proves it and the script that shows the defect.
//
// Each runs as its own process: they build fresh in-memory databases, silence the library's stderr
// and call process.exit, and one crashing must not stop the rest.
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = dirname(fileURLToPath(import.meta.url))
const wanted = process.argv.slice(2)

const scripts = ['fixes', 'features']
   .flatMap((group) =>
      readdirSync(join(PKG, group), { withFileTypes: true })
         .filter((e) => e.isDirectory() && existsSync(join(PKG, group, e.name, 'repro.ts')))
         .map((e) => join(PKG, group, e.name, 'repro.ts')),
   )
   .filter((path) => !wanted.length || wanted.some((w) => basename(dirname(path)).includes(w)))

if (!scripts.length) {
   console.error(`nothing matched: ${wanted.join(' ')}`)
   process.exit(2)
}

let failed = 0
for (const script of scripts) {
   const res = spawnSync(process.execPath, [script], { stdio: ['ignore', 'inherit', 'ignore'] })
   if (res.status !== 0) {
      failed++
      console.log(`\n  ${basename(dirname(script))} exited ${res.status}\n`)
   }
}

console.log(`${scripts.length - failed}/${scripts.length} reproductions ran\n`)
process.exit(failed ? 1 : 0)
