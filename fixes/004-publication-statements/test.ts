// Asserts the CORRECT behaviour, so it fails on the published build by design.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite, newApp, type LiteConnection } from '../../test/harness.ts'

const translate = (sql: string): Promise<string> => lite.translatePostgresDdl(sql)

describe('FIX-004 publication statements do not reach the DDL', () => {
   test('ALTER PUBLICATION translates to nothing', async () => {
      assert.equal((await translate('ALTER PUBLICATION supabase_realtime ADD TABLE messages;')).trim(), '')
   })

   // ADD, SET and DROP share one node type, so covering the type covers the variants.
   test('ALTER PUBLICATION DROP TABLE translates to nothing', async () => {
      assert.equal((await translate('ALTER PUBLICATION supabase_realtime DROP TABLE messages;')).trim(), '')
   })

   test('CREATE PUBLICATION translates to nothing', async () => {
      assert.equal((await translate('CREATE PUBLICATION supabase_realtime FOR TABLE messages;')).trim(), '')
   })

   /**
    * The third statement of the family, failing differently: `DROP PUBLICATION` has no node type of
    * its own — an ordinary DropStmt with `removeType: 'OBJECT_PUBLICATION'` — so the deparser throws
    * rather than mangling it.
    */
   test('DROP PUBLICATION translates to nothing', async () => {
      assert.equal((await translate('DROP PUBLICATION supabase_realtime;')).trim(), '')
      assert.equal((await translate('DROP PUBLICATION IF EXISTS supabase_realtime;')).trim(), '')
   })

   /**
    * What it is for: Supabase's own documented block for turning Realtime on, shape for shape. Every
    * publication statement in the family appears in it, which is why this is the test that matters —
    * before this, a schema exported from a project using Realtime failed on its first line.
    *
    * It succeeds by being ignored rather than implemented: SQLite has no logical replication to
    * translate publications into. What must happen is the ordinary table beside them being created.
    */
   test('the canonical Supabase Realtime block migrates, and the table beside it is created', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      const ddl = [
         'CREATE TABLE messages (id int primary key, body text);',
         'begin;',
         'drop publication if exists supabase_realtime;',
         'create publication supabase_realtime;',
         'commit;',
         'ALTER PUBLICATION supabase_realtime ADD TABLE messages;',
      ].join('\n')

      await (await connection.createMigrator(ddl)).migrate()

      const created = (await connection.exec(
         "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
      )) as { rows: { name: string }[] }
      assert.deepEqual(
         (created.rows ?? []).map((r) => r.name),
         ['messages'],
      )
   })

   // Guard: only publications are dropped.
   test('ordinary DDL is untouched', async () => {
      const out = await translate('CREATE TABLE t (id int primary key, name text);')
      assert.match(out, /CREATE TABLE t \(/)
      assert.match(out, /name TEXT/)
   })

   /**
    * The guard that matters here. `DROP PUBLICATION` is recognised by a field of a node type shared
    * with the drops that carry real meaning, so the risk is not missing something but taking the
    * whole family along. These must still translate, and a refused drop must still be refused.
    */
   test('other drops still translate, and an unsupported one is still refused', async () => {
      assert.match(await translate('DROP TABLE t;'), /DROP TABLE t/)
      assert.match(await translate('DROP INDEX i;'), /DROP INDEX i/)
      assert.match(await translate('DROP VIEW v;'), /DROP VIEW v/)

      await assert.rejects(() => translate('DROP SCHEMA s;'), /not supported in SQLite/)
   })
})
