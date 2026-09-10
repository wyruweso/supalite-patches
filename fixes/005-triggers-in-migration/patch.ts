// FIX-005: track trigger changes and recreate triggers around table rebuilds.
import { methodNamed, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FIX-005'
export const title = 'triggers reach the database through the migrator'

// Trigger redefinition during a rebuild already works upstream; keep it as a regression guard.
export const expectedDivergence = [
   'FIX-005 triggers survive a migration',
   'FIX-005 triggers survive a migration > migrating a schema with a trigger creates it',
   'FIX-005 triggers survive a migration > the trigger actually fires',
   'FIX-005 triggers survive a migration > a redefined trigger is replaced',
   'FIX-005 triggers survive a migration > a failed migration takes the trigger changes back with it',
   'FIX-005 triggers survive a migration > a rebuild of a table a trigger writes to',
   'FIX-005 triggers survive a migration > a rebuild of a table a trigger writes to > succeeds with the trigger left in place',
   // `succeeds while the trigger is being removed` is not declared: with no trigger ever created, the
   // published build has nothing to trip over and agrees. It guards the ordering, not the fix.
   'FIX-005 triggers survive a migration > a redefinition inside a string literal is noticed',
]

export function apply(source: string): string {
   const patched = wrapMethod(source, {
      at: methodNamed('diff', 'makeIndexKey'),
      replacement: new URL('./src/db/sqlite/migration/Differ.ts', import.meta.url),
      exported: 'diff',
      originalAs: 'diffOriginal',
   })

   return wrapMethod(patched, {
      at: methodNamed('plan', 'rebuildTable'),
      replacement: new URL('./src/db/sqlite/migration/Differ.ts', import.meta.url),
      exported: 'plan',
      originalAs: 'planOriginal',
   })
}
