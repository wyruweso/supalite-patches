// Which policy expressions translate, and which are refused by name.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, pgrstCode, type LiteApp, type LiteConnection } from '../test/harness.ts'

const TABLE = `CREATE TABLE notes (id int primary key, owner uuid, team text, level int, public boolean, body text);
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;`

interface Fixture {
   app: LiteApp
   auth: Record<string, string>
   userId: string
}

async function withPolicy(policy: string): Promise<Fixture> {
   const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
   await (await connection.createMigrator(`${TABLE}\n${policy}`)).migrate()
   const session = (await post(app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })).body
   const auth = { Authorization: `Bearer ${session.access_token}` }
   await post(
      app,
      '/rest/v1/notes',
      { id: 1, owner: session.user.id, team: 'a', level: 3, public: true, body: 'public note' },
      auth,
   )
   return { app, auth, userId: session.user.id }
}

const migrating = async (policy: string) => {
   const { connection } = await newApp({ seed: false })
   await (await connection.createMigrator(`${TABLE}\n${policy}`)).migrate()
}

describe('boolean composition', () => {
   test('OR widens: a row matching either side is visible', async () => {
      const { app, auth } = await withPolicy(
         'CREATE POLICY p ON notes FOR ALL USING (owner = auth.uid() OR public = true) WITH CHECK (owner = auth.uid());',
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id')).body, [{ id: 1 }])
   })

   test('AND narrows: the anonymous caller fails the owner half', async () => {
      const { app, auth } = await withPolicy(
         'CREATE POLICY p ON notes FOR ALL USING (owner = auth.uid() AND level > 1) WITH CHECK (owner = auth.uid());',
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id')).body, [])
   })

   test('NOT inverts', async () => {
      const { app, auth } = await withPolicy(
         'CREATE POLICY p ON notes FOR ALL USING (NOT (public = true)) WITH CHECK (true);',
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [])
   })

   test('USING (true) makes the table readable by anyone', async () => {
      const { app } = await withPolicy('CREATE POLICY p ON notes FOR ALL USING (true) WITH CHECK (true);')
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id')).body, [{ id: 1 }])
   })
})

describe('comparison forms', () => {
   test('IN with a literal list', async () => {
      const { app, auth } = await withPolicy(
         "CREATE POLICY p ON notes FOR ALL USING (team IN ('a','b')) WITH CHECK (true);",
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
   })

   test('IS NULL', async () => {
      const { app, auth } = await withPolicy(
         'CREATE POLICY p ON notes FOR ALL USING (owner IS NULL) WITH CHECK (true);',
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [])
   })

   test('LIKE', async () => {
      const { app, auth } = await withPolicy(
         "CREATE POLICY p ON notes FOR ALL USING (body LIKE 'pub%') WITH CHECK (true);",
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
   })

   test('a subquery against another table', async () => {
      const { app, auth } = await withPolicy(
         'CREATE POLICY p ON notes FOR ALL USING (owner IN (SELECT id FROM auth.users)) WITH CHECK (true);',
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
   })
})

describe('auth helpers', () => {
   test('auth.uid() resolves to the caller', async () => {
      const { app, auth } = await withPolicy(
         'CREATE POLICY p ON notes FOR ALL USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());',
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id')).body, [])
   })

   test('auth.role() resolves to the caller’s role', async () => {
      const { app, auth } = await withPolicy(
         "CREATE POLICY p ON notes FOR ALL USING (auth.role() = 'authenticated') WITH CHECK (true);",
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
   })

   test('auth.jwt() migrates cleanly, then 500s for a token without that claim', async () => {
      const { app, auth } = await withPolicy(
         "CREATE POLICY p ON notes FOR ALL USING (team = auth.jwt() ->> 'team') WITH CHECK (true);",
      )
      const r = await get(app, '/rest/v1/notes?select=id', auth)
      assert.equal(r.status, 500)
      assert.equal(pgrstCode(r), 'SUP')
      assert.equal(r.body.message, 'Error: Unresolved variable: {{auth.jwt.team}}')
   })
})

describe('role-targeted policies', () => {
   test('TO authenticated admits a signed-in caller and excludes an anonymous one', async () => {
      const { app, auth } = await withPolicy(
         'CREATE POLICY p ON notes FOR ALL TO authenticated USING (true) WITH CHECK (true);',
      )
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', auth)).body, [{ id: 1 }])
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id')).body, [])
   })
})

describe('expressions refused at migration time', () => {
   for (const [label, policy, expected] of [
      [
         'BETWEEN',
         'CREATE POLICY p ON notes FOR ALL USING (level BETWEEN 1 AND 5) WITH CHECK (true);',
         /Unsupported expression: A_Expr kind: AEXPR_BETWEEN/,
      ],
      [
         'current_setting()',
         "CREATE POLICY p ON notes FOR ALL USING (team = current_setting('x', true)) WITH CHECK (true);",
         /Unsupported expression: FuncCall: current_setting/,
      ],
      [
         'COALESCE',
         'CREATE POLICY p ON notes FOR ALL USING (coalesce(public,false) = true) WITH CHECK (true);',
         /Unsupported expression: deparseValue: CoalesceExpr/,
      ],
      [
         'CASE',
         'CREATE POLICY p ON notes FOR ALL USING (CASE WHEN level > 1 THEN true ELSE false END) WITH CHECK (true);',
         /Unsupported expression: .*CaseExpr/,
      ],
   ] as const)
      test(`${label} is refused, naming the construct`, async () => {
         await assert.rejects(() => migrating(policy), expected)
      })
})
