// Applies every patch to the installed @supabase/lite, so the patched library can be used from an
// ordinary `import '@supabase/lite'`.
//
//   npm run install:patches
//   npm run uninstall:patches
//
// The original is kept beside it as index.published.js, so rolling back needs no reinstall. Running
// twice is safe: patches are applied to the backup, never to an already-patched file.
import { BUNDLE, buildPatchedBundle, SUPPORTED } from './apply.ts'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTALLED = join(HERE, 'node_modules', '@supabase', 'lite')

const target = join(INSTALLED, 'dist', BUNDLE)
const backup = join(INSTALLED, 'dist', 'index.published.js')

async function install(): Promise<void> {
   uninstall({ quiet: true })

   const staging = mkdtempSync(join(tmpdir(), 'supalite-patches-'))
   const applied = await buildPatchedBundle(staging)

   copyFileSync(target, backup)
   copyFileSync(join(staging, BUNDLE), target)
   rmSync(staging, { recursive: true, force: true })

   console.log(`@supabase/lite patched, ${applied.length} patches:`)
   for (const patch of applied) console.log(`  ${patch.id.padEnd(9)} ${patch.title}`)
   console.log('\nroll back: npm run uninstall:patches')
}

function uninstall({ quiet = false } = {}): void {
   if (!existsSync(backup)) {
      if (!quiet) console.log('no patches installed')
      return
   }
   copyFileSync(backup, target)
   rmSync(backup, { force: true })
   if (!quiet) console.log('published bundle restored')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   if (!existsSync(join(INSTALLED, 'package.json'))) {
      console.error(`package not found: ${INSTALLED} — run \`npm i\` first`)
      process.exit(2)
   }
   const version = (JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8')) as { version: string }).version
   if (!SUPPORTED.includes(version)) {
      console.error(`patches are verified against @supabase/lite@${SUPPORTED.join(', ')}; ${version} is installed`)
      process.exit(2)
   }

   if (process.argv.includes('--uninstall')) uninstall()
   else await install()
}
