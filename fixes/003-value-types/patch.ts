// FIX-003: default ddlDialect to postgres so metadata merging and deserialization run.
// Fixed upstream in 0.9.1-next.2.
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
   // Unchanged integer cases guard against inferring types from neighboring CHECK expressions.
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
