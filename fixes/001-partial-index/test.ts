// Asserts the CORRECT behaviour, so it fails on the published build by design.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite, newApp, post, pgrstCode, type LiteApp, type LiteConnection } from '../../test/harness.ts'

const translate = (sql: string): Promise<string> => lite.translatePostgresDdl(sql)

const USERS = [
   'CREATE TABLE users (id int primary key, email text not null, deleted_at timestamptz);',
   'CREATE UNIQUE INDEX users_live_email ON users (email) WHERE deleted_at IS NULL;',
].join('\n')

async function migrate(ddl: string): Promise<{ app: LiteApp; connection: LiteConnection }> {
   const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
   await (await connection.createMigrator(ddl)).migrate()
   return { app, connection }
}

async function indexSql(connection: LiteConnection, name: string): Promise<string> {
   const result = (await connection.exec(`SELECT sql FROM sqlite_master WHERE type='index' AND name='${name}'`)) as {
      rows: { sql: string }[]
   }
   return result.rows[0]?.sql ?? ''
}

describe('FIX-001 partial indexes keep their predicate', () => {
   test('a partial UNIQUE index keeps its WHERE clause', async () => {
      const out = await translate('CREATE UNIQUE INDEX u ON users (email) WHERE deleted_at IS NULL;')
      assert.match(out, /CREATE UNIQUE INDEX u ON users \(email\)\s+WHERE deleted_at IS NULL/)
   })

   test('a plain partial index keeps its WHERE clause', async () => {
      const out = await translate('CREATE INDEX p ON t (a) WHERE a > 0;')
      assert.match(out, /CREATE INDEX p ON t \(a\)\s+WHERE a > 0/)
   })

   // The predicate goes through the ordinary expression visitor, so compound conditions work on
   // their own. The line break inside AND is existing BoolExpr formatting, not this change.
   test('a compound predicate survives, and so does the index direction', async () => {
      const out = await translate('CREATE INDEX p ON t (a DESC) WHERE a > 0 AND b IS NOT NULL;')
      assert.match(out, /\(a DESC\)/)
      assert.match(out, /WHERE a > 0\s+AND b IS NOT NULL/)
   })

   test('an index without a predicate is untouched', async () => {
      assert.equal((await translate('CREATE INDEX plain ON t (a);')).trim(), 'CREATE INDEX plain ON t (a);')
   })

   // The second path: the planner rebuilds CREATE INDEX from a structural model, so until that model
   // had a place for the predicate, fixing translation changed nothing for a migration.
   test('the predicate reaches SQLite through a migration', async () => {
      const { connection } = await migrate(USERS)
      assert.match(await indexSql(connection, 'users_live_email'), /WHERE\s+deleted_at IS NULL/)
   })

   // What it is all for: with a global constraint the database rejects a row Postgres accepts.
   test('the soft-delete idiom accepts what Postgres accepts', async () => {
      const { app } = await migrate(USERS)

      const deleted = await post(app, '/rest/v1/users', { id: 1, email: 'a@b.co', deleted_at: '2024-01-01T00:00:00Z' })
      assert.equal(deleted.status, 201, `PGRST code: ${pgrstCode(deleted)}`)

      const reused = await post(app, '/rest/v1/users', { id: 2, email: 'a@b.co' })
      assert.equal(reused.status, 201, `re-registering a soft-deleted address: ${pgrstCode(reused)}`)
   })

   // The other half: within its own subset the index is still UNIQUE. A predicate that survived but
   // matched nothing would pass the test above and fail this one.
   test('the same address twice among live rows is still refused', async () => {
      const { app, connection } = await migrate(USERS)

      assert.equal((await post(app, '/rest/v1/users', { id: 1, email: 'a@b.co' })).status, 201)

      // Refused, and the row is not there. The *status* of a constraint violation belongs to FIX-002
      // — asserting 409 here would make this suite depend on that patch being applied too.
      const duplicate = await post(app, '/rest/v1/users', { id: 2, email: 'a@b.co' })
      assert.ok(duplicate.status >= 400, `the duplicate was accepted: ${duplicate.status}`)

      const rows = (await connection.exec('SELECT id FROM users')) as { rows: { id: number }[] }
      assert.deepEqual(
         (rows.rows ?? []).map((r) => r.id),
         [1],
      )
   })

   test('a plain index becomes partial, and back', async () => {
      const table = 'CREATE TABLE notes (id int primary key, body text, archived boolean);\n'
      const plain = `${table}CREATE INDEX notes_body ON notes (body);`
      const partial = `${table}CREATE INDEX notes_body ON notes (body) WHERE archived = false;`

      const { connection } = await migrate(plain)
      assert.doesNotMatch(await indexSql(connection, 'notes_body'), /WHERE/i)

      await (await connection.createMigrator(partial)).migrate()
      assert.match(await indexSql(connection, 'notes_body'), /WHERE\s+archived = false/)

      await (await connection.createMigrator(plain)).migrate()
      assert.doesNotMatch(await indexSql(connection, 'notes_body'), /WHERE/i)
   })

   // Adding a column rebuilds the table, and the planner reassembles every index while it does.
   test('the predicate survives a table rebuild', async () => {
      const { connection } = await migrate(USERS)
      await (
         await connection.createMigrator(
            [
               'CREATE TABLE users (id int primary key, email text not null, deleted_at timestamptz, note text);',
               'CREATE UNIQUE INDEX users_live_email ON users (email) WHERE deleted_at IS NULL;',
            ].join('\n'),
         )
      ).migrate()

      assert.match(await indexSql(connection, 'users_live_email'), /WHERE\s+deleted_at IS NULL/)
   })

   test('a migration that only changes the predicate is noticed', async () => {
      const table = 'CREATE TABLE notes (id int primary key, body text, archived boolean);\n'
      const { connection } = await migrate(`${table}CREATE INDEX notes_body ON notes (body) WHERE archived = false;`)

      await (
         await connection.createMigrator(`${table}CREATE INDEX notes_body ON notes (body) WHERE body IS NOT NULL;`)
      ).migrate()

      assert.match(await indexSql(connection, 'notes_body'), /WHERE\s+body IS NOT NULL/)
   })

   // Use raw SQL to exercise quoted names the translator cannot produce.
   test('a WHERE inside the statement is not mistaken for the filter', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      await connection.exec('CREATE TABLE t (a int, note text)')
      await connection.exec(`CREATE INDEX by_literal ON t (a) WHERE note = 'x WHERE y'`)
      await connection.exec(`CREATE INDEX by_expression ON t ((note || ' WHERE ')) WHERE a > 0`)
      await connection.exec(`CREATE INDEX by_comment ON t (a) /* WHERE not this */ WHERE a > 0`)

      const found = new Map(
         (await connection.introspect()).indexes.map((index: { name: string; where?: string | null }) => [
            index.name,
            index.where,
         ]),
      )
      assert.equal(found.get('by_literal'), `note = 'x WHERE y'`)
      assert.equal(found.get('by_expression'), 'a > 0')
      assert.equal(found.get('by_comment'), 'a > 0')
   })

   test('an index whose name contains a quote keeps its predicate', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      await connection.exec('CREATE TABLE t (a int)')
      await connection.exec('CREATE INDEX "strange""index" ON t (a) WHERE a > 0')

      const index = (await connection.introspect()).indexes.find((i: { name: string }) => i.name === 'strange"index')
      assert.equal(index?.where, 'a > 0')
   })

   // An identifier is not a word boundary away from WHERE in every alphabet, so the filter is looked
   // for only after the indexed expressions close. `індексWHERE` reported `ON t(a)` as its predicate.
   test('WHERE inside an index name is not mistaken for the filter', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      await connection.exec('CREATE TABLE t (a int)')
      await connection.exec('CREATE INDEX індексWHERE ON t (a)')
      await connection.exec('CREATE INDEX індексWHERE2 ON t (a) WHERE a > 0')

      const found = new Map(
         (await connection.introspect()).indexes.map((index: { name: string; where?: string | null }) => [
            index.name,
            index.where,
         ]),
      )
      assert.equal(found.get('індексWHERE'), null)
      assert.equal(found.get('індексWHERE2'), 'a > 0')
   })

   // Raw SQL preserves spacing that the translator would normalize.
   test('the same predicate spaced differently is not a change', async () => {
      const table = 'CREATE TABLE t (a int, note text);\n'
      const { connection } = await migrate(table)
      await connection.exec('CREATE INDEX i ON t(a) WHERE a>0')

      const { diff } = (await (
         await connection.createMigrator(`${table}CREATE INDEX i ON t (a) WHERE a > 0;`)
      ).diff()) as { diff: { has_changes: boolean } }
      assert.equal(diff.has_changes, false)
   })

   // …while a predicate that differs in more than spacing still is one.
   test('a predicate differing in more than spacing is a change', async () => {
      const table = 'CREATE TABLE t (a int, note text);\n'
      const { connection } = await migrate(table)
      await connection.exec('CREATE INDEX i ON t(a) WHERE a>1')

      const { diff } = (await (
         await connection.createMigrator(`${table}CREATE INDEX i ON t (a) WHERE a > 0;`)
      ).diff()) as { diff: { has_changes: boolean } }
      assert.equal(diff.has_changes, true)
   })

   test('a SQL comment is not mistaken for subtraction when comparing predicates', async () => {
      const table = 'CREATE TABLE t (a int);\n'
      const { connection } = await migrate(table)
      await connection.exec('CREATE UNIQUE INDEX i ON t(a) WHERE (a--1\n)>0')
      await connection.exec('INSERT INTO t(a) VALUES (0)')

      const desired = `${table}CREATE UNIQUE INDEX i ON t(a) WHERE (a - -1) > 0;`
      const { diff } = await (await connection.createMigrator(desired)).diff()
      assert.equal(diff.has_changes, true)
      await (await connection.createMigrator(desired)).migrate()

      await assert.rejects(() => connection.exec('INSERT INTO t(a) VALUES (0)'), /UNIQUE constraint failed/)
   })

   test('comments and whitespace between tokens do not change a predicate', async () => {
      const table = 'CREATE TABLE t (a int, note text);\n'
      const { connection } = await migrate(table)
      await connection.exec("CREATE INDEX i ON t(a) WHERE a/* threshold */>0 AND note = '-- keep  spaces' -- end")

      const desired = `${table}CREATE INDEX i ON t(a) WHERE a > 0 AND note = '-- keep  spaces';`
      const { diff } = await (await connection.createMigrator(desired)).diff()
      assert.equal(diff.has_changes, false)
   })

   test('whitespace inside a quoted literal remains significant', async () => {
      const table = 'CREATE TABLE t (a int, note text);\n'
      const { connection } = await migrate(table)
      await connection.exec("CREATE INDEX i ON t(a) WHERE note = '-- keep  spaces'")

      const desired = `${table}CREATE INDEX i ON t(a) WHERE note = '-- keep spaces';`
      const { diff } = await (await connection.createMigrator(desired)).diff()
      assert.equal(diff.has_changes, true)
   })

   // The one place two patches write to the same plan: FIX-005 moves triggers around a rebuild,
   // FIX-001 appends the predicate to the add_index step inside it.
   test('a rebuild keeps the predicate, and any triggers with it', async () => {
      const schema = (extra: string) =>
         [
            `CREATE TABLE users (id int primary key, email text, deleted_at timestamptz${extra});`,
            'CREATE TABLE log (id int primary key, note text);',
            'CREATE UNIQUE INDEX users_live_email ON users (email) WHERE deleted_at IS NULL;',
            "CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN INSERT INTO public.log (id, note) VALUES (NEW.id, 'x'); RETURN NEW; END; $$ LANGUAGE plpgsql;",
            'CREATE TRIGGER on_users_insert AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION copy_row();',
         ].join('\n')

      const { connection } = await migrate(schema(''))
      await connection.exec("INSERT INTO users (id, email) VALUES (1, 'a@b.co')")
      const triggersBefore = await triggerNames(connection)

      // Adding a column of a new type rebuilds the table, taking its indexes and triggers with it.
      await (await connection.createMigrator(schema(', note text'))).migrate({ force: true })

      assert.match(await indexSql(connection, 'users_live_email'), /WHERE\s+deleted_at IS NULL/)

      // Only when a trigger was there to keep: without FIX-005 the first migration creates none, and
      // the rebuild then creates one from the desired schema — the published build's own behaviour.
      if (triggersBefore.length) {
         assert.deepEqual(await triggerNames(connection), triggersBefore, 'the rebuild changed which triggers exist')
      }

      // And the predicate still means what it says, on the rebuilt table.
      await connection.exec("INSERT INTO users (id, email, deleted_at) VALUES (2, 'c@b.co', '2020-01-01')")
      await connection.exec("INSERT INTO users (id, email) VALUES (3, 'c@b.co')")
      await assert.rejects(
         () => connection.exec("INSERT INTO users (id, email) VALUES (4, 'c@b.co')"),
         /UNIQUE constraint failed/,
      )

      // A trigger that exists but no longer fires would pass every check above.
      if (triggersBefore.length) {
         const logged = (await connection.exec('SELECT id FROM log ORDER BY id')) as { rows?: { id: number }[] }
         assert.deepEqual(
            (logged.rows ?? []).map((row) => row.id),
            [1, 2, 3],
         )
      }
   })
})

async function triggerNames(connection: LiteConnection): Promise<string[]> {
   const result = (await connection.exec("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")) as {
      rows?: { name: string }[]
   }
   return (result.rows ?? []).map((row) => row.name)
}
