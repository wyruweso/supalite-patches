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

   /**
    * The case that loses a trigger entirely: a column change and a redefinition in one migration.
    *
    * SQLite drops a table's triggers with the table, so the original recreates them when rebuilding
    * one. Deciding by name alone that it had "already planned" the create skipped the create and ran
    * the drop anyway, leaving no trigger and a migration reporting success. The rule is what the
    * original plans compared with what is wanted.
    *
    * Not declared as a divergence: a rebuild is the one path the published build gets right, and the
    * regression this guards was this patch's own.
    */
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

   /**
    * Where the trigger steps run, not only whether. The original's plan ends `COMMIT;` then
    * `PRAGMA foreign_keys=ON;`, so appended steps run outside the transaction — a trigger failing to
    * create would leave the table changes committed and the schema half applied.
    */
   test('trigger steps run inside the migration transaction', async () => {
      const { connection } = await migrate(TABLES)
      const { plan } = await (await connection.createMigrator(COPY)).diff()

      const types = plan.steps.map((s: { type: string }) => s.type)
      const commit = types.indexOf('commit_transaction')
      const trigger = types.findIndex((t: string) => t === 'add_trigger' || t === 'drop_trigger')

      assert.notEqual(trigger, -1, 'no trigger step was planned')
      assert.notEqual(commit, -1, 'the plan has no commit to be inside of')
      assert.ok(trigger < commit, `trigger step at ${trigger} runs after the commit at ${commit}`)
   })

   /**
    * The difference a whitespace-collapsing comparison would miss: two spaces inside a string literal
    * are data, not formatting. Getting it wrong is silent — the trigger keeps its old definition for
    * ever and the migration reports success.
    */
   test('a redefinition inside a string literal is noticed', async () => {
      const { connection } = await migrate(withBody("INSERT INTO public.dst (id, name) VALUES (NEW.id, 'a  b');"))
      await (
         await connection.createMigrator(withBody("INSERT INTO public.dst (id, name) VALUES (NEW.id, 'a b');"))
      ).migrate()

      const [trigger] = await triggers(connection)
      assert.match(trigger.sql, /'a b'/)
      assert.doesNotMatch(trigger.sql, /'a {2}b'/)
   })

   /**
    * Migrating the same schema twice must plan nothing, which is what makes an exact comparison safe:
    * both sides come from the same generator, so a trigger compares byte for byte with itself.
    */
   test('the same schema twice plans no trigger work', async () => {
      const { connection } = await migrate(COPY)
      const { plan } = await (await connection.createMigrator(COPY)).diff()

      const churn = (plan.steps ?? []).filter(
         (s: { type: string }) => s.type === 'add_trigger' || s.type === 'drop_trigger',
      )
      assert.deepEqual(churn, [], 'an unchanged trigger was recreated')
   })

   /**
    * A trigger name needing quotes never reaches this patch, on either build.
    *
    * The drop it emits quotes the name and doubles an embedded quote, as SQLite requires and the name
    * reader assumes — but it cannot be shown end to end, because the translator loses the quotes
    * first: `CREATE TRIGGER "on src"` comes out as `CREATE TRIGGER on src` and is refused. A separate
    * defect in a component this patch does not touch.
    *
    * Pinned as the refusal it actually is, marking the boundary of the claim, so the quoting is ready
    * if the translator is ever fixed. Not a divergence: both builds fail identically.
    */
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
