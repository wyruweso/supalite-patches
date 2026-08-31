// Builds the patched bundle: the published one plus every patch in fixes/ and features/.
//
//   npm run build            → dist-patched/index.js
import type { Patch } from './lib/patcher.ts'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLISHED = join(HERE, 'node_modules', '@supabase', 'lite')

export const BUNDLE = 'index.js'

/** Two directories, one mechanism: fixes repair defects, features add unimplemented capabilities. */
const ROOTS = [
   { dir: join(HERE, 'fixes'), kind: 'fix' as const },
   { dir: join(HERE, 'features'), kind: 'feature' as const },
]

/** Anchors depend on the structure of a specific build; refuse any other version by name. */
export const SUPPORTED = ['0.9.0', '0.9.1-next.1']

export async function loadPatches(): Promise<Patch[]> {
   const loaded: Patch[] = []
   for (const { dir: root, kind } of ROOTS) {
      if (!existsSync(root)) continue
      const dirs = readdirSync(root, { withFileTypes: true })
         .filter((e) => e.isDirectory())
         .map((e) => e.name)
         .sort()
      for (const dir of dirs) {
         loaded.push({
            dir,
            kind,
            ...((await import(pathToFileURL(join(root, dir, 'patch.ts')).href)) as Omit<Patch, 'dir' | 'kind'>),
         })
      }
   }
   return loaded
}

export async function buildPatchedBundle(outDir: string): Promise<Patch[]> {
   const version = (JSON.parse(readFileSync(join(PUBLISHED, 'package.json'), 'utf8')) as { version: string }).version
   if (!SUPPORTED.includes(version))
      throw new Error(`patches are verified against @supabase/lite@${SUPPORTED.join(', ')}; ${version} is installed`)

   const patches = await loadPatches()
   let source = readFileSync(join(PUBLISHED, 'dist', BUNDLE), 'utf8')
   for (const patch of patches) {
      const before = source
      source = patch.apply(source)
      if (source === before) throw new Error(`${patch.id}: the patch changed nothing`)
   }

   const out = join(outDir, BUNDLE)
   mkdirSync(dirname(out), { recursive: true })
   writeFileSync(out, source)
   return patches
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   const out = process.argv[2] ?? join(HERE, 'dist-patched')
   for (const patch of await buildPatchedBundle(out)) console.log(`  ${patch.id.padEnd(9)} ${patch.title}`)
   console.log(`\n→ ${out}`)
}
