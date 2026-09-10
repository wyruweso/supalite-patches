// Record remaining package defects; these observations must agree with and without the patches.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { get, lite, newApp, post, type LiteConnection } from '../test/harness.ts'

const rows = async (connection: LiteConnection, sql: string) =>
   ((await connection.exec(sql)).rows ?? []).map((row: Record<string, unknown>) => ({ ...row }))

describe('migration integrity', () => {
   test('adding a foreign key accepts existing orphan rows without force', async () => {
      const { connection } = await newApp({ seed: false })
      const schema = (reference: string) =>
         `CREATE TABLE parents (id int primary key);
          CREATE TABLE children (id int primary key, parent_id int${reference});`

      await (await connection.createMigrator(schema(''))).migrate()
      await connection.exec('INSERT INTO children VALUES (1, 999)')
      await (await connection.createMigrator(schema(' REFERENCES parents(id)'))).migrate()

      const keys = await connection.exec("SELECT * FROM pragma_foreign_key_list('children')")
      assert.equal(keys.rows.length, 1)
      assert.deepEqual(await rows(connection, 'SELECT * FROM pragma_foreign_keys'), [{ foreign_keys: 1 }])
      assert.deepEqual(await rows(connection, 'SELECT * FROM pragma_foreign_key_check'), [
         { table: 'children', rowid: 1, parent: 'parents', fkid: 0 },
      ])
      await assert.rejects(
         () => connection.exec('INSERT INTO children VALUES (2, 999)'),
         /FOREIGN KEY constraint failed/,
      )
   })

   test('a dependent view blocks a table rebuild and the failure rolls back', async () => {
      const { connection } = await newApp({ seed: false })
      const schema =
         'CREATE TABLE items (id int primary key, name text);' + 'CREATE VIEW item_names AS SELECT id, name FROM items;'
      await (await connection.createMigrator(schema)).migrate()
      await connection.exec("INSERT INTO items VALUES (1, 'kept')")

      const migrator = await connection.createMigrator(`${schema} CREATE INDEX items_name_idx ON items(name);`)
      const { plan } = await migrator.diff()
      assert.ok(plan.steps.some((step: { type: string }) => step.type === 'rename_table'))
      await assert.rejects(() => migrator.migrate(), /error in view item_names: no such table: main.items/)

      assert.deepEqual(await rows(connection, 'SELECT * FROM item_names'), [{ id: 1, name: 'kept' }])
      assert.deepEqual(await rows(connection, 'SELECT * FROM pragma_foreign_keys'), [{ foreign_keys: 1 }])
   })

   test('COLLATE is silently removed from a unique index', async () => {
      const { connection } = await newApp({ seed: false })
      const schema =
         'CREATE TABLE contacts (id int primary key, email text);' +
         'CREATE UNIQUE INDEX contact_email ON contacts(email COLLATE "NOCASE");'
      const translated = await connection.translateDdl(schema)
      assert.doesNotMatch(translated.ddl, /COLLATE/i)
      await (await connection.createMigrator(schema)).migrate()
      await connection.exec("INSERT INTO contacts VALUES (1, 'Alice@example.test'), (2, 'alice@example.test')")
      assert.equal((await connection.exec('SELECT id FROM contacts')).rows.length, 2)

      await connection.exec('CREATE TABLE control (email TEXT UNIQUE COLLATE NOCASE)')
      await connection.exec("INSERT INTO control VALUES ('Alice@example.test')")
      await assert.rejects(
         () => connection.exec("INSERT INTO control VALUES ('alice@example.test')"),
         /UNIQUE constraint failed/,
      )
   })

   test('an embedded quote in a table name breaks a generated ALTER', async () => {
      const { connection } = await newApp({ seed: false })
      await connection.exec('CREATE TABLE "we""ird" (id INTEGER PRIMARY KEY)')
      await assert.rejects(
         async () =>
            (await connection.createMigrator('CREATE TABLE "we""ird" (id int primary key, extra text);')).migrate(),
         /near "ird": syntax error/,
      )
   })
})

describe('schema metadata', () => {
   test('exec DDL stays invisible to REST until the schema cache is cleared', async () => {
      const { app, connection } = await newApp({ seed: false })
      await connection.exec('CREATE TABLE existing (id INTEGER PRIMARY KEY)')
      assert.equal((await get(app, '/rest/v1/existing')).status, 200)
      await connection.exec('CREATE TABLE docs (id INTEGER PRIMARY KEY)')

      const stale = await get(app, '/rest/v1/docs')
      assert.equal(stale.status, 404)
      assert.equal(stale.body.code, 'PGRST205')

      await connection.clearSchemaCache()
      const refreshed = await get(app, '/rest/v1/docs')
      assert.equal(refreshed.status, 200)
      assert.deepEqual(refreshed.body, [])
   })

   test('boolean array elements stay numeric with Postgres metadata enabled', async () => {
      const { app, connection } = await newApp({ seed: false })
      connection.config.ddlDialect = 'postgres'
      await (
         await connection.createMigrator(
            'CREATE TABLE arrays (id int primary key, flags boolean[], nums int[], names text[]);',
         )
      ).migrate()
      const written = await post(app, '/rest/v1/arrays', { id: 1, flags: [true, false], nums: [1, 2], names: ['a'] })
      assert.equal(written.status, 201)
      assert.deepEqual((await get(app, '/rest/v1/arrays?select=flags,nums,names')).body, [
         { flags: [1, 0], nums: [1, 2], names: ['a'] },
      ])
   })

   test('the plan step enum declares trigger creation but not removal', () => {
      const types = Object.values(lite.PlanStepType)
      assert.ok(types.includes('create_trigger'))
      assert.ok(!types.includes('drop_trigger'))
   })
})

test('large bigint writes round the value and a representation error leaves the row stored', async () => {
   const { app, connection } = await newApp({ seed: false })
   await (await connection.createMigrator('CREATE TABLE large_numbers (id int primary key, value bigint);')).migrate()
   await connection.exec('INSERT INTO large_numbers VALUES (1, 9007199254740993)')

   const read = await get(app, '/rest/v1/large_numbers?id=eq.1')
   assert.equal(read.status, 500)
   assert.match(read.body.message, /too large to be represented as a JavaScript number/)

   const minimal = await post(app, '/rest/v1/large_numbers', { id: 2, value: '9007199254740993' })
   assert.equal(minimal.status, 201)
   const represented = await post(
      app,
      '/rest/v1/large_numbers',
      { id: 3, value: '9007199254740993' },
      { Prefer: 'return=representation' },
   )
   assert.equal(represented.status, 500)
   assert.match(represented.body.message, /too large to be represented as a JavaScript number/)
   assert.deepEqual(await rows(connection, 'SELECT id, CAST(value AS TEXT) AS value FROM large_numbers ORDER BY id'), [
      { id: 1, value: '9007199254740993' },
      { id: 2, value: '9007199254740992' },
      { id: 3, value: '9007199254740992' },
   ])
})
