// Applying a migration, and re-applying it.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { lite, newApp, get, req, type LiteApp, type LiteConnection } from '../test/harness.ts'

const migration = (version: string, name: string, statements: string[] = []) => ({ version, name, statements })

describe('history table', () => {
   let connection: LiteConnection
   beforeEach(async () => {
      ;({ connection } = await newApp({ auth: false, seed: false }))
      await lite.ensureHistoryTable(connection)
   })

   test('a fresh history is empty', async () => {
      assert.deepEqual(await lite.listHistory(connection), [])
      assert.deepEqual(await lite.appliedVersions(connection), [])
   })

   test('ensureHistoryTable is idempotent', async () => {
      await lite.ensureHistoryTable(connection)
      await lite.ensureHistoryTable(connection)
      assert.deepEqual(await lite.appliedVersions(connection), [])
   })

   test('a recorded version reads back with its statements and null-defaulted fields', async () => {
      await lite.recordVersion(connection, migration('001', 'init', ['SELECT 1']))
      assert.deepEqual(await lite.listHistory(connection), [
         {
            version: '001',
            name: 'init',
            statements: ['SELECT 1'],
            rollback: [],
            created_by: null,
            idempotency_key: null,
         },
      ])
   })

   test('appliedVersions reports versions in order', async () => {
      await lite.recordVersion(connection, migration('001', 'init'))
      await lite.recordVersion(connection, migration('002', 'more'))
      await lite.recordVersion(connection, migration('003', 'yet more'))
      assert.deepEqual(await lite.appliedVersions(connection), ['001', '002', '003'])
   })

   test('getVersion finds one, and returns null rather than throwing for an unknown one', async () => {
      await lite.recordVersion(connection, migration('001', 'init', ['SELECT 1']))
      assert.equal((await lite.getVersion(connection, '001'))!.name, 'init')
      assert.equal(await lite.getVersion(connection, '999'), null)
   })

   test('removeVersion removes exactly the one named', async () => {
      await lite.recordVersion(connection, migration('001', 'a'))
      await lite.recordVersion(connection, migration('002', 'b'))
      await lite.removeVersion(connection, '001')
      assert.deepEqual(await lite.appliedVersions(connection), ['002'])
   })

   test('removeVersionsGte removes the named version and everything after it', async () => {
      for (const v of ['001', '002', '003']) await lite.recordVersion(connection, migration(v, v))
      await lite.removeVersionsGte(connection, '002')
      assert.deepEqual(await lite.appliedVersions(connection), ['001'])
   })

   test('removeVersionsGte with a bound below everything empties the history', async () => {
      for (const v of ['001', '002'] as const) await lite.recordVersion(connection, migration(v, v))
      await lite.removeVersionsGte(connection, '000')
      assert.deepEqual(await lite.appliedVersions(connection), [])
   })

   test('removing something that was never recorded is a no-op', async () => {
      await lite.recordVersion(connection, migration('001', 'a'))
      await lite.removeVersion(connection, '999')
      assert.deepEqual(await lite.appliedVersions(connection), ['001'])
   })
})

describe('history variant', () => {
   test('a SQLite connection reports the flattened postgres layout', async () => {
      const { connection } = await newApp({ auth: false, seed: false })
      assert.equal(lite.historyVariant(connection), 'pg-flat')
   })

   test('the history schema SQL is emitted as one semicolon-joined string', async () => {
      const sql = lite.getMigrationHistorySchemaSql('pg-flat')
      assert.equal(typeof sql, 'string')
      assert.ok(sql.trim().endsWith(';'))
      assert.match(sql, /CREATE TABLE/i)
   })
})

describe('the migrator', () => {
   let app: LiteApp
   let connection: LiteConnection
   beforeEach(async () => {
      ;({ app, connection } = await newApp({ auth: false, seed: false }))
   })

   test('migrating Postgres DDL creates a table that PostgREST can then serve', async () => {
      const migrator = await connection.createMigrator(
         'CREATE TABLE widgets (id int primary key, label text not null);',
      )
      await migrator.migrate()
      const created = await req(
         app,
         'POST',
         '/rest/v1/widgets',
         { id: 1, label: 'first' },
         { Prefer: 'return=representation' },
      )
      assert.equal(created.status, 201)
      assert.deepEqual(created.body, [{ id: 1, label: 'first' }])
   })

   test('a diff against an unchanged schema plans no steps', async () => {
      const migrator = await connection.createMigrator('CREATE TABLE widgets (id int primary key);')
      await migrator.migrate()
      const again = await connection.createMigrator('CREATE TABLE widgets (id int primary key);')
      const diff = await again.diff()
      assert.deepEqual(diff.tables ?? [], [])
   })

   test('adding a column is applied and then visible over HTTP', async () => {
      await (await connection.createMigrator('CREATE TABLE widgets (id int primary key);')).migrate()
      await (await connection.createMigrator('CREATE TABLE widgets (id int primary key, label text);')).migrate()
      const created = await req(
         app,
         'POST',
         '/rest/v1/widgets',
         { id: 1, label: 'added' },
         { Prefer: 'return=representation' },
      )
      assert.equal(created.status, 201)
      assert.deepEqual(created.body, [{ id: 1, label: 'added' }])
   })

   test('the translated DDL is reported alongside the parsed pieces', async () => {
      const translated = await connection.translateDdl('CREATE TABLE widgets (id int primary key, tags text[]);')
      assert.deepEqual(Object.keys(translated).sort(), [
         'ast',
         'comments',
         'ddl',
         'enums',
         'rls',
         'schema',
         'tableConstraints',
         'vars',
      ])
      assert.match(translated.ddl, /CREATE TABLE widgets \(/)
      assert.match(translated.ddl, /tags TEXT CHECK/)
   })

   test('empty DDL is returned untouched rather than parsed', async () => {
      assert.deepEqual(await connection.translateDdl('   '), { ddl: '   ' })
   })

   test('a migrated table appears in the introspection endpoint', async () => {
      await (await connection.createMigrator('CREATE TABLE widgets (id int primary key);')).migrate()
      const introspected = await get(app, '/_system/introspect')
      assert.ok(introspected.body.tables.some((t: any) => t.name === 'widgets'))
   })
})

describe('what the migrator carries across', () => {
   const TRIGGER_DDL = [
      'CREATE TABLE src (id int primary key, name text);',
      'CREATE TABLE dst (id int primary key, name text);',
      'CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN INSERT INTO public.dst (id, name) VALUES (NEW.id, NEW.name); RETURN NEW; END; $$ LANGUAGE plpgsql;',
      'CREATE TRIGGER on_src_insert AFTER INSERT ON src FOR EACH ROW EXECUTE FUNCTION copy_row();',
   ].join('\n')

   const triggerNames = async (connection: LiteConnection): Promise<string[]> => {
      const r = (await connection.exec("SELECT name FROM sqlite_master WHERE type='trigger'")) as {
         rows: { name: string }[]
      }
      return (r.rows ?? []).map((row) => row.name)
   }

   test('the translated DDL contains the trigger, and executing it creates one', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      const { ddl } = (await connection.translateDdl(TRIGGER_DDL)) as { ddl: string }
      assert.match(ddl, /CREATE TRIGGER on_src_insert/)

      await connection.exec(ddl)
      assert.deepEqual(await triggerNames(connection), ['on_src_insert'])
   })
})
