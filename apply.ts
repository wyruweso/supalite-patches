// Build the published bundle with every fix and feature applied.
import type { Patch } from './lib/patcher.ts'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = join(PROJECT_DIR, 'node_modules', '@supabase', 'lite')

export const BUNDLE = 'index.js'

const PATCH_ROOTS = [
   { dir: join(PROJECT_DIR, 'fixes'), kind: 'fix' as const },
   { dir: join(PROJECT_DIR, 'features'), kind: 'feature' as const },
]

// Anchors depend on the reviewed bundle structure.
export const SUPPORTED = ['0.9.0', '0.9.1-next.1']

export async function loadPatches(): Promise<Patch[]> {
   const patches: Patch[] = []
   for (const { dir: root, kind } of PATCH_ROOTS) {
      if (!existsSync(root)) continue
      const directories = readdirSync(root, { withFileTypes: true })
         .filter((entry) => entry.isDirectory())
         .map((entry) => entry.name)
         .sort()
      for (const dir of directories) {
         const patch = (await import(pathToFileURL(join(root, dir, 'patch.ts')).href)) as Omit<Patch, 'dir' | 'kind'>
         patches.push({
            dir,
            kind,
            ...patch,
         })
      }
   }
   return patches
}

export async function buildPatchedBundle(outputDir: string): Promise<Patch[]> {
   const { version } = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }
   if (!SUPPORTED.includes(version)) {
      throw new Error(`patches are verified against @supabase/lite@${SUPPORTED.join(', ')}; ${version} is installed`)
   }

   const patches = await loadPatches()
   let source = readFileSync(join(PACKAGE_DIR, 'dist', BUNDLE), 'utf8')
   for (const patch of patches) {
      const before = source
      source = patch.apply(source)
      if (source === before) throw new Error(`${patch.id}: the patch changed nothing`)
   }

   const outputFile = join(outputDir, BUNDLE)
   mkdirSync(dirname(outputFile), { recursive: true })
   writeFileSync(outputFile, source)
   return patches
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   const outputDir = process.argv[2] ?? join(PROJECT_DIR, 'dist-patched')
   for (const patch of await buildPatchedBundle(outputDir)) console.log(`  ${patch.id.padEnd(9)} ${patch.title}`)
   console.log(`\n→ ${outputDir}`)
}
