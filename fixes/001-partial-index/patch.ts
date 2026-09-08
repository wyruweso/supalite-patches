// FIX-001 — a partial index loses its predicate.  FINDINGS #1
//
// The predicate has to survive four representations, and skipping any one brings the defect back
// whole:
//
//   Postgres AST → SQLite DDL    IndexStmt          emits WHERE
//   SQLite DDL   → schema model  introspect         reads WHERE back
//   model        → comparison    makeIndexKey       notices a changed WHERE
//   model        → SQLite DDL    MigrationPlanner   emits WHERE again
import { methodNamed, replaceFunction, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FIX-001'
export const title = 'partial indexes keep their WHERE'

export const expectedDivergence = [
   'FIX-001 partial indexes keep their predicate',
   'FIX-001 partial indexes keep their predicate > a partial UNIQUE index keeps its WHERE clause',
   'FIX-001 partial indexes keep their predicate > a plain partial index keeps its WHERE clause',
   'FIX-001 partial indexes keep their predicate > a compound predicate survives, and so does the index direction',
   'FIX-001 partial indexes keep their predicate > the predicate reaches SQLite through a migration',
   'FIX-001 partial indexes keep their predicate > the soft-delete idiom accepts what Postgres accepts',
   'FIX-001 partial indexes keep their predicate > a migration that only changes the predicate is noticed',
   'FIX-001 partial indexes keep their predicate > a WHERE inside the statement is not mistaken for the filter',
   'FIX-001 partial indexes keep their predicate > an index whose name contains a quote keeps its predicate',
   'FIX-001 partial indexes keep their predicate > the predicate survives a table rebuild',
   'FIX-001 partial indexes keep their predicate > WHERE inside an index name is not mistaken for the filter',
   'FIX-001 partial indexes keep their predicate > a predicate differing in more than spacing is a change',
   'FIX-001 partial indexes keep their predicate > a plain index becomes partial, and back',
   // `the same address twice among live rows is still refused` is not declared either: a globally
   // unique index refuses that insert too, so both builds agree. It is the other half of the idiom —
   // the half that must keep working while the reusable half is fixed.
   //
   // `the same predicate spaced differently is not a change` is not declared: with no predicate in
   // the model the published build agrees nothing changed, for the wrong reason. It guards the
   // comparison against becoming too literal.
]

export function apply(source: string): string {
   let patched = wrapMethod(source, {
      at: methodNamed('IndexStmt', 'IndexElem'),
      replacement: new URL('./src/db/translation/SqliteDeparser.ts', import.meta.url),
      exported: 'IndexStmt',
      originalAs: 'IndexStmtOriginal',
   })

   patched = wrapMethod(patched, {
      at: methodNamed('introspect', 'createMigrator'),
      replacement: new URL('./src/db/sqlite/SqliteConnection.ts', import.meta.url),
      exported: 'introspect',
      originalAs: 'introspectOriginal',
   })

   patched = replaceFunction(patched, {
      at: methodNamed('makeIndexKey', 'makeForeignKeyKey'),
      replacement: new URL('./src/db/sqlite/migration/Differ.ts', import.meta.url),
      exported: 'makeIndexKey',
   })

   return wrapMethod(patched, {
      at: methodNamed('plan', 'rebuildTable'),
      replacement: new URL('./src/db/sqlite/migration/Differ.ts', import.meta.url),
      exported: 'plan',
      originalAs: 'planOriginal',
   })
}
