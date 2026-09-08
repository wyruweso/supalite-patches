// FIX-003 — values arrive in the wrong types.  FINDINGS #5
//
// `jsonb` and arrays come back over REST as the characters of their JSON and `boolean` as 0/1, so
// `row.ok === true` is never true and `row.tags.map(...)` throws.
//
// The declared Postgres types are not lost. They are collected during translation and merged back
// into the introspection — but only when `config.ddlDialect === 'postgres'`, and the constructor
// never defaults it, so for every connection built without one the merge is skipped and the row
// deserialiser is skipped with it. Two lines below the merge, the same field is reported as
// `ddl_dialect: this.config.ddlDialect ?? 'postgres'`.
//
// Upstream fixed exactly this in 0.9.1-next.2 by defaulting the field where the config is built.
import { methodNamed, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FIX-003'
export const title = 'values come back in their Postgres types'

export const expectedDivergence = [
   'FIX-003 values come back in their Postgres types',
   'FIX-003 values come back in their Postgres types > a text[] column is an array, not the characters of one',
   'FIX-003 values come back in their Postgres types > an int[] column keeps its numbers as numbers',
   'FIX-003 values come back in their Postgres types > a jsonb column is an object',
   'FIX-003 values come back in their Postgres types > a boolean column is true, not 1',
   'FIX-003 values come back in their Postgres types > the round trip is still lossless',
   'FIX-003 values come back in their Postgres types > an integer column stays an integer',
   'FIX-003 values come back in their Postgres types > an integer column stays an integer > beside a boolean whose name ends with its own',
   'FIX-003 values come back in their Postgres types > introspection reports a table under its own schema again',
   // The other three `an integer column stays an integer` cases are not declared: the published
   // build leaves those columns alone too, having no types to apply at all. They are regressions
   // against inferring a type from the schema text, which is what this patch replaced.
]

export function apply(source: string): string {
   const patched = wrapMethod(source, {
      at: methodNamed('introspect', 'createMigrator'),
      replacement: new URL('./src/db/sqlite/SqliteConnection.ts', import.meta.url),
      exported: 'introspect',
      originalAs: 'introspectBeforeDialectDefault',
   })

   return wrapMethod(patched, {
      at: methodNamed('deserializeRow', 'withSqlitePlugins'),
      replacement: new URL('./src/db/sqlite/SqliteConnection.ts', import.meta.url),
      exported: 'deserializeRow',
      originalAs: 'deserializeRowBeforeDialectDefault',
   })
}
