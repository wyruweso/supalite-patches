// FIX-004: omit publication statements from SQLite DDL so imported schemas can migrate.
// Recognize each AST form; this adds no Realtime implementation.
import { methodNamed, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FIX-004'
export const title = 'publication statements are dropped instead of mangling the DDL'

export const expectedDivergence = [
   'FIX-004 publication statements do not reach the DDL',
   'FIX-004 publication statements do not reach the DDL > ALTER PUBLICATION translates to nothing',
   'FIX-004 publication statements do not reach the DDL > ALTER PUBLICATION DROP TABLE translates to nothing',
   'FIX-004 publication statements do not reach the DDL > CREATE PUBLICATION translates to nothing',
   'FIX-004 publication statements do not reach the DDL > DROP PUBLICATION translates to nothing',
   'FIX-004 publication statements do not reach the DDL > a schema with a publication, a partial index and a trigger is migrated once',
   'FIX-004 publication statements do not reach the DDL > ALTER PUBLICATION RENAME TO translates to nothing',
   'FIX-004 publication statements do not reach the DDL > ALTER PUBLICATION OWNER TO translates to nothing',
   'FIX-004 publication statements do not reach the DDL > changing only the publication plans nothing and keeps the rows',
   'FIX-004 publication statements do not reach the DDL > the canonical Supabase Realtime block migrates, and the table beside it is created',
]

export function apply(source: string): string {
   return wrapMethod(source, {
      at: methodNamed('visit', 'deparse'),
      replacement: new URL('./src/db/translation/SqliteDeparser.ts', import.meta.url),
      exported: 'visit',
      originalAs: 'visitOriginal',
   })
}
