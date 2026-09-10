// Run matching reproductions in separate processes: each can call process.exit independently.
import { spawnSync } from 'node:child_process'
import { readdirSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2)

const scripts = ['fixes', 'features']
   .flatMap((group) =>
      readdirSync(join(PROJECT_DIR, group), { withFileTypes: true })
         .filter((entry) => entry.isDirectory() && existsSync(join(PROJECT_DIR, group, entry.name, 'repro.ts')))
         .map((entry) => join(PROJECT_DIR, group, entry.name, 'repro.ts')),
   )
   .filter((path) => !filters.length || filters.some((filter) => basename(dirname(path)).includes(filter)))

if (!scripts.length) {
   console.error(`nothing matched: ${filters.join(' ')}`)
   process.exit(2)
}

let failed = 0
for (const script of scripts) {
   const result = spawnSync(process.execPath, [script], { stdio: ['ignore', 'inherit', 'ignore'] })
   if (result.status !== 0) {
      failed++
      console.log(`\n  ${basename(dirname(script))} exited ${result.status}\n`)
   }
}

console.log(`${scripts.length - failed}/${scripts.length} reproductions ran\n`)
process.exit(failed ? 1 : 0)
