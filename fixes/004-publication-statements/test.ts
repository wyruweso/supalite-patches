// Asserts the CORRECT behaviour, so it fails on the published build by design.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite, newApp, type LiteConnection } from '../../test/harness.ts'

const translate = (sql: string): Promise<string> => lite.translatePostgresDdl(sql)

describe('FIX-004 publication statements do not reach the DDL', () => {
   test('ALTER PUBLICATION translates to nothing', async () => {
      assert.equal((await translate('ALTER PUBLICATION supabase_realtime ADD TABLE messages;')).trim(), '')
   })

   // ADD, SET and DROP share one node type, so covering the type covers those variants.
   test('ALTER PUBLICATION DROP TABLE translates to nothing', async () => {
      assert.equal((await translate('ALTER PUBLICATION supabase_realtime DROP TABLE messages;')).trim(), '')
   })

   // RENAME and OWNER do not: they are a RenameStmt and an AlterOwnerStmt, and each has to be read
   // by the kind of object it names. Both threw before this.
   test('ALTER PUBLICATION RENAME TO translates to nothing', async () => {
      assert.equal((await translate('ALTER PUBLICATION supabase_realtime RENAME TO realtime;')).trim(), '')
   })

   test('ALTER PUBLICATION OWNER TO translates to nothing', async () => {
      assert.equal((await translate('ALTER PUBLICATION supabase_realtime OWNER TO postgres;')).trim(), '')
   })

   test('CREATE PUBLICATION translates to nothing', async () => {
      assert.equal((await translate('CREATE PUBLICATION supabase_realtime FOR TABLE messages;')).trim(), '')
   })

   // DROP PUBLICATION shares DropStmt with other object types.
   test('DROP PUBLICATION translates to nothing', async () => {
      assert.equal((await translate('DROP PUBLICATION supabase_realtime;')).trim(), '')
      assert.equal((await translate('DROP PUBLICATION IF EXISTS supabase_realtime;')).trim(), '')
   })

   // Publications are skipped; the ordinary table in the same schema must still be created.
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

   // Other objects sharing DropStmt must retain their translation or rejection behavior.
   test('other drops still translate, and an unsupported one is still refused', async () => {
      assert.match(await translate('DROP TABLE t;'), /DROP TABLE t/)
      assert.match(await translate('DROP INDEX i;'), /DROP INDEX i/)
      assert.match(await translate('DROP VIEW v;'), /DROP VIEW v/)

      await assert.rejects(() => translate('DROP SCHEMA s;'), /not supported in SQLite/)
   })

   // The same guard for the two node types added with RENAME and OWNER.
   test('renaming something that is not a publication still translates', async () => {
      assert.match(await translate('CREATE TABLE t (id int primary key); ALTER TABLE t RENAME TO t2;'), /RENAME TO/)
      await assert.rejects(() => translate('ALTER TYPE mood RENAME TO feeling;'), /not supported in SQLite/)
   })

   test('changing only the publication plans nothing and keeps the rows', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      const table = 'CREATE TABLE messages (id int primary key, body text);\n'

      await (await connection.createMigrator(table)).migrate()
      await connection.exec("INSERT INTO messages (id, body) VALUES (1, 'kept')")

      const { diff, plan } = (await (
         await connection.createMigrator(`${table}ALTER PUBLICATION supabase_realtime ADD TABLE messages;`)
      ).diff()) as { diff: { has_changes: boolean }; plan?: { steps: unknown[] } }

      assert.equal(diff.has_changes, false)
      assert.deepEqual(plan?.steps ?? [], [])

      const rows = (await connection.exec('SELECT body FROM messages')) as { rows: { body: string }[] }
      assert.deepEqual(
         (rows.rows ?? []).map((r) => r.body),
         ['kept'],
      )
   })

   // Everything these patches touch, migrated twice: churn here would rebuild the database on every
   // run. Holds with any subset, since both sides go through the same translator.
   test('a schema with a publication, a partial index and a trigger is migrated once', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      const full = [
         'CREATE TABLE users (id int primary key, email text, deleted_at timestamptz);',
         'CREATE TABLE log (id int primary key, note text);',
         'CREATE UNIQUE INDEX users_live_email ON users (email) WHERE deleted_at IS NULL;',
         "CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN INSERT INTO public.log (id, note) VALUES (NEW.id, 'x'); RETURN NEW; END; $$ LANGUAGE plpgsql;",
         'CREATE TRIGGER on_users AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION copy_row();',
         'ALTER PUBLICATION supabase_realtime ADD TABLE users;',
      ].join('\n')

      await (await connection.createMigrator(full)).migrate()

      const { diff, plan } = (await (await connection.createMigrator(full)).diff()) as {
         diff: { has_changes: boolean }
         plan?: { steps: unknown[] }
      }
      assert.equal(diff.has_changes, false)
      assert.deepEqual(plan?.steps ?? [], [])
   })
})
