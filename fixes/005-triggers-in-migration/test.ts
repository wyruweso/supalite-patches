// Asserts the CORRECT behaviour, so it fails on the published build by design.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, type LiteApp, type LiteConnection } from '../../test/harness.ts'

const TABLES = [
   'CREATE TABLE src (id int primary key, name text);',
   'CREATE TABLE dst (id int primary key, name text);',
].join('\n')

const withBody = (body: string) =>
   [
      TABLES,
      `CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN ${body} RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      'CREATE TRIGGER on_src_insert AFTER INSERT ON src FOR EACH ROW EXECUTE FUNCTION copy_row();',
   ].join('\n')

const COPY = withBody('INSERT INTO public.dst (id, name) VALUES (NEW.id, NEW.name);')

/** A schema whose `src` carries an extra column, so that changing its type forces a table rebuild. */
const withColumn = (column: string, written: string) =>
   [
      `CREATE TABLE src (id int primary key, name text, ${column});`,
      'CREATE TABLE dst (id int primary key, name text);',
      `CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN INSERT INTO public.dst (id, name) VALUES (NEW.id, '${written}'); RETURN NEW; END; $$ LANGUAGE plpgsql;`,
      'CREATE TRIGGER on_src_insert AFTER INSERT ON src FOR EACH ROW EXECUTE FUNCTION copy_row();',
   ].join('\n')

async function migrate(ddl: string): Promise<{ app: LiteApp; connection: LiteConnection }> {
   const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
   await (await connection.createMigrator(ddl)).migrate()
   return { app, connection }
}

async function rows(connection: LiteConnection, sql: string): Promise<Record<string, any>[]> {
   return ((await connection.exec(sql)) as { rows?: Record<string, any>[] }).rows ?? []
}

async function triggers(connection: LiteConnection): Promise<{ name: string; sql: string }[]> {
   const r = (await connection.exec("SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name")) as {
      rows: { name: string; sql: string }[]
   }
   return r.rows ?? []
}

describe('FIX-005 triggers survive a migration', () => {
   test('migrating a schema with a trigger creates it', async () => {
      const { connection } = await migrate(COPY)
      assert.deepEqual(
         (await triggers(connection)).map((t) => t.name),
         ['on_src_insert'],
      )
   })

   // What it is for: the Supabase recipes rest on this.
   test('the trigger actually fires', async () => {
      const { app } = await migrate(COPY)
      const inserted = await post(app, '/rest/v1/src', { id: 1, name: 'first' }, { Prefer: 'return=representation' })
      assert.equal(inserted.status, 201)
      assert.deepEqual((await get(app, '/rest/v1/dst?select=id,name')).body, [{ id: 1, name: 'first' }])
   })

   test('a redefined trigger is replaced', async () => {
      const { app, connection } = await migrate(COPY)
      await (
         await connection.createMigrator(withBody("INSERT INTO public.dst (id, name) VALUES (NEW.id, 'rewritten');"))
      ).migrate()

      assert.match((await triggers(connection))[0]?.sql ?? '', /rewritten/)
      await post(app, '/rest/v1/src', { id: 2, name: 'second' })
      assert.deepEqual((await get(app, '/rest/v1/dst?select=name')).body, [{ name: 'rewritten' }])
   })

   // The original rebuild already recreates this trigger. Do not drop it after that step.
   test('a redefined trigger survives a table rebuild', async () => {
      const { connection } = await migrate(withColumn('b int', 'first'))
      await (await connection.createMigrator(withColumn('b text', 'rebuilt'))).migrate({ force: true })

      const after = await triggers(connection)
      assert.equal(after.length, 1, 'the rebuild left no trigger behind')
      assert.match(after[0].sql, /rebuilt/)

      await connection.exec("INSERT INTO src (id, name, b) VALUES (1, 'x', 'y')")
      assert.deepEqual(
         (await rows(connection, 'SELECT name FROM dst')).map((r) => r.name),
         ['rebuilt'],
      )
   })

   // The unchanged trigger belongs to src but references dst, the table being rebuilt.
   describe('a rebuild of a table a trigger writes to', () => {
      const crossTable = (dstColumn: string, withTrigger = true) =>
         [
            'CREATE TABLE src (id int primary key, name text);',
            `CREATE TABLE dst (id int primary key, name text, n ${dstColumn});`,
            ...(withTrigger
               ? [
                    `CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN INSERT INTO public.dst (id, name) VALUES (NEW.id, NEW.name); RETURN NEW; END; $$ LANGUAGE plpgsql;`,
                    'CREATE TRIGGER on_src_insert AFTER INSERT ON src FOR EACH ROW EXECUTE FUNCTION copy_row();',
                 ]
               : []),
         ].join('\n')

      test('succeeds with the trigger left in place', async () => {
         const { connection } = await migrate(crossTable('int'))
         await connection.exec("INSERT INTO src (id, name) VALUES (1, 'a')")

         await (await connection.createMigrator(crossTable('text'))).migrate({ force: true })

         assert.deepEqual(
            (await rows(connection, "SELECT name FROM sqlite_master WHERE type='trigger'")).map((r) => r.name),
            ['on_src_insert'],
         )
         // And it still fires against the rebuilt table.
         await connection.exec("INSERT INTO src (id, name) VALUES (2, 'b')")
         assert.deepEqual(
            (await rows(connection, 'SELECT name FROM dst ORDER BY id')).map((r) => r.name),
            ['a', 'b'],
         )
      })

      // The same rebuild while the trigger is being removed: its DROP has to come first as well.
      test('succeeds while the trigger is being removed', async () => {
         const { connection } = await migrate(crossTable('int'))
         await connection.exec("INSERT INTO src (id, name) VALUES (1, 'a')")

         await (await connection.createMigrator(crossTable('text', false))).migrate({ force: true })

         assert.deepEqual(await rows(connection, "SELECT name FROM sqlite_master WHERE type='trigger'"), [])
      })
   })

   // Fail the row copy after dropping the trigger, then verify rollback restores it.
   // migratePlan supplies the transaction; the plan's BEGIN/COMMIT markers alone prove nothing.
   test('a failed migration takes the trigger changes back with it', async () => {
      const withRequired = COPY.replace(
         'CREATE TABLE dst (id int primary key, name text);',
         'CREATE TABLE dst (id int primary key, name text, req text not null);',
      )
      assert.notEqual(withRequired, COPY, 'the schema under test did not change')

      const { connection } = await migrate(COPY)
      await connection.exec("INSERT INTO dst (id, name) VALUES (1, 'kept')")

      const types = (
         (await (await connection.createMigrator(withRequired)).diff()).plan.steps as { type: string }[]
      ).map((s) => s.type)
      assert.ok(types.indexOf('drop_trigger') < types.indexOf('copy_data'), `steps: ${types.join(', ')}`)

      await assert.rejects(
         async () => (await connection.createMigrator(withRequired)).migrate({ force: true }),
         /NOT NULL constraint failed/,
      )

      assert.deepEqual(
         (await rows(connection, "SELECT name FROM sqlite_master WHERE type='trigger'")).map((r) => r.name),
         ['on_src_insert'],
         'the dropped trigger was not restored by the rollback',
      )
      assert.deepEqual(
         (await rows(connection, 'SELECT name FROM dst')).map((r) => r.name),
         ['kept'],
      )
   })

   // Whitespace inside a string literal must remain significant when comparing triggers.
   test('a redefinition inside a string literal is noticed', async () => {
      const { connection } = await migrate(withBody("INSERT INTO public.dst (id, name) VALUES (NEW.id, 'a  b');"))
      await (
         await connection.createMigrator(withBody("INSERT INTO public.dst (id, name) VALUES (NEW.id, 'a b');"))
      ).migrate()

      const [trigger] = await triggers(connection)
      assert.match(trigger.sql, /'a b'/)
      assert.doesNotMatch(trigger.sql, /'a {2}b'/)
   })

   test('the same schema twice plans no trigger work', async () => {
      const { connection } = await migrate(COPY)
      const { plan } = await (await connection.createMigrator(COPY)).diff()

      const churn = (plan.steps ?? []).filter(
         (s: { type: string }) => s.type === 'create_trigger' || s.type === 'drop_trigger',
      )
      assert.deepEqual(churn, [], 'an unchanged trigger was recreated')
   })

   // The translator loses quotes before this patch runs, so both builds reject these names.
   test('a trigger name needing quotes is refused by the translator, on both builds', async () => {
      const quoted = [
         TABLES,
         'CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN INSERT INTO public.dst (id, name) VALUES (NEW.id, NEW.name); RETURN NEW; END; $$ LANGUAGE plpgsql;',
         'CREATE TRIGGER "on src" AFTER INSERT ON src FOR EACH ROW EXECUTE FUNCTION copy_row();',
      ].join('\n')

      await assert.rejects(() => migrate(quoted), /syntax error/)
   })

   // Guards. Both pass on the published build too: there are no triggers there to drop or invent.
   test('a removed trigger is dropped', async () => {
      const { connection } = await migrate(COPY)
      await (await connection.createMigrator(TABLES)).migrate()
      assert.deepEqual(await triggers(connection), [])
   })

   test('a schema without triggers still has none', async () => {
      const { connection } = await migrate(TABLES)
      assert.deepEqual(await triggers(connection), [])
   })
})
