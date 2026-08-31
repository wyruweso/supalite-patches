// FIX-005 — triggers never reach the database through the migrator.  FINDINGS #8
//
//   translateDdl                 contains CREATE TRIGGER   ok
//   exec(translated DDL)         trigger is in the database ok
//   migrate(the same DDL)        no triggers at all         no
//
// The migration reports success, the tables are there, the trigger is not. The canonical Supabase
// recipes break: handle_new_user() on auth.users, and the updated_at trigger. Same shape as FIX-001 —
// translation is right, the migration path loses it.
//
// Two places, in order: the change has to enter the diff before it can enter the plan.
//
// The plan half is subtler. SQLite drops a table's triggers with the table, so the original
// recreates them when rebuilding one — meaning "has the original handled this trigger" can only be
// answered by comparing what it plans with what is wanted, not by name. And the steps belong before
// the plan's `COMMIT;`, or a trigger that fails to create leaves the rest committed.
import { methodNamed, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FIX-005'
export const title = 'triggers reach the database through the migrator'

// `a redefined trigger survives a table rebuild` is deliberately absent: it passes on the published
// build too, since rebuilding a table is the one path there that does recreate a trigger. It guards
// a regression of this patch's own — the first version dropped the trigger the rebuild had just
// recreated.
export const expectedDivergence = [
   'FIX-005 triggers survive a migration',
   'FIX-005 triggers survive a migration > migrating a schema with a trigger creates it',
   'FIX-005 triggers survive a migration > the trigger actually fires',
   'FIX-005 triggers survive a migration > a redefined trigger is replaced',
   'FIX-005 triggers survive a migration > trigger steps run inside the migration transaction',
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
