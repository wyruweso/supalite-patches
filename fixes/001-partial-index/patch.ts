// FIX-001 — a partial index loses its predicate.  FINDINGS #1
//
// `CREATE UNIQUE INDEX u ON users (email) WHERE deleted_at IS NULL` becomes a global unique index, so
// the database rejects rows Postgres accepts — the soft-delete idiom breaks, silently, at the user.
//
// The predicate has to survive four representations, and it was lost in three:
//
//   Postgres AST → SQLite DDL    IndexStmt          emits WHERE
//   SQLite DDL   → schema model  introspect         reads WHERE back
//   model        → comparison    makeIndexKey       notices a changed WHERE
//   model        → SQLite DDL    MigrationPlanner   emits WHERE again
//
// Skipping any one brings the defect back whole, as the first attempt at translation alone proved.
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
   // `the same predicate written differently is not a change` is not declared: with no predicate in
   // the model, the published build agrees nothing changed, for the wrong reason. It guards against
   // the comparison becoming too literal.
]

export function apply(source: string): string {
   // A wrapper: the original's statement is kept whole and one suffix added. Rebuilding it would
   // need the quoting helper's minified name, and would freeze a copy of the rest of the method.
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
