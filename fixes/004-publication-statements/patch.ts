// FIX-004 — publication statements kill the migration, in two different ways.  FINDINGS #7
//
//   ALTER PUBLICATION supabase_realtime ADD TABLE messages;
//   → ALTER PUBLICATION supabase_realtime ADD FOR TABLE TABLE messages
//   → migration dies: near "PUBLICATION": syntax error
//
//   DROP PUBLICATION IF EXISTS supabase_realtime;
//   → throws: DROP with removeType OBJECT_PUBLICATION is not supported in SQLite
//
// The deparser emits its own `FOR TABLE` and keeps the original `TABLE`, giving output valid in
// neither dialect that then lands in executed DDL. The drop never gets that far: it shares a node
// type with DROP TABLE, whose handler raises on any object kind it does not know.
//
// The drop matters more, because Supabase's own instructions for turning Realtime on open with it:
//
//   begin;
//     drop publication if exists supabase_realtime;
//     create publication supabase_realtime;
//   commit;
//   alter publication supabase_realtime add table messages;
//
// So a schema exported from a project using Realtime failed on the first of its publication lines.
// The rule applied here covers the whole family rather than one mangled form: publication metadata
// never reaches SQLite DDL. This does not implement Realtime — SQLite has no logical replication for
// it to mean anything in — it stops publications taking the rest of the schema down with them.
//
// The library's UNSUPPORTED_TYPES already handles statements with no SQLite equivalent, but
// publications are not in it, so the node falls through to pgsql-deparser and comes back as Postgres
// syntax. The mangling is the dependency's; the answer belongs here, since the statement has no
// business reaching the output at all.
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
