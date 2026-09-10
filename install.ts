// Install patches in node_modules; keep index.published.js for restoration.
import { BUNDLE, buildPatchedBundle, SUPPORTED } from './apply.ts'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(PROJECT_DIR, 'node_modules', '@supabase', 'lite')

const installedBundle = join(PACKAGE_DIR, 'dist', BUNDLE)
const publishedBackup = join(PACKAGE_DIR, 'dist', 'index.published.js')

async function install(): Promise<void> {
   // Always build from the published bundle, including repeated installations.
   uninstall({ quiet: true })

   const stagingDir = mkdtempSync(join(tmpdir(), 'supalite-patches-'))
   const patches = await buildPatchedBundle(stagingDir)

   copyFileSync(installedBundle, publishedBackup)
   copyFileSync(join(stagingDir, BUNDLE), installedBundle)
   rmSync(stagingDir, { recursive: true, force: true })

   console.log(`@supabase/lite patched, ${patches.length} patches:`)
   for (const patch of patches) console.log(`  ${patch.id.padEnd(9)} ${patch.title}`)
   console.log('\nroll back: npm run uninstall:patches')
}

function uninstall({ quiet = false } = {}): void {
   if (!existsSync(publishedBackup)) {
      if (!quiet) console.log('no patches installed')
      return
   }
   copyFileSync(publishedBackup, installedBundle)
   rmSync(publishedBackup, { force: true })
   if (!quiet) console.log('published bundle restored')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   if (!existsSync(join(PACKAGE_DIR, 'package.json'))) {
      console.error(`package not found: ${PACKAGE_DIR} — run \`npm ci\` first`)
      process.exit(2)
   }
   const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }
   if (!SUPPORTED.includes(version)) {
      console.error(`patches are verified against @supabase/lite@${SUPPORTED.join(', ')}; ${version} is installed`)
      process.exit(2)
   }

   if (process.argv.includes('--uninstall')) uninstall()
   else await install()
}
