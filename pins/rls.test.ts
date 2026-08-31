// Row-level security: policies per command, and the roles they admit.
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, req, get, post, pgrstCode, type LiteApp, type LiteConnection } from '../test/harness.ts'

const NOTES_DDL = `
CREATE TABLE notes (id int primary key, owner uuid, body text);
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_all ON notes FOR ALL USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
`

interface Party {
   id: string
   headers: Record<string, string>
}

async function rlsApp(ddl = NOTES_DDL) {
   const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
   await (await connection.createMigrator(ddl)).migrate()
   const signUp = async (email: string): Promise<Party> => {
      const session = (await post(app, '/auth/v1/signup', { email, password: 'password123' })).body
      return { id: session.user.id, headers: { Authorization: `Bearer ${session.access_token}` } }
   }
   return { app, connection, alice: await signUp('alice@b.co'), bob: await signUp('bob@b.co') }
}

describe('a FOR ALL policy on auth.uid()', () => {
   let app: LiteApp
   let alice: Party
   let bob: Party
   beforeEach(async () => {
      ;({ app, alice, bob } = await rlsApp())
   })

   test('a user can insert a row they own', async () => {
      const r = await post(
         app,
         '/rest/v1/notes',
         { id: 1, owner: alice.id, body: 'mine' },
         { ...alice.headers, Prefer: 'return=representation' },
      )
      assert.equal(r.status, 201)
      assert.deepEqual(r.body, [{ id: 1, owner: alice.id, body: 'mine' }])
   })

   test('a user cannot insert a row owned by someone else', async () => {
      const r = await post(app, '/rest/v1/notes', { id: 1, owner: bob.id, body: 'theirs' }, alice.headers)
      assert.equal(r.status, 403)
      assert.equal(pgrstCode(r), 'PGRST301')
      assert.match(r.body.message, /violates row-level security policy for table "notes"/)
   })

   test('an anonymous insert is refused as unauthenticated rather than forbidden', async () => {
      const r = await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'x' })
      assert.equal(r.status, 401)
      assert.equal(pgrstCode(r), 'PGRST301')
   })

   test('a select returns only the caller’s own rows', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'a' }, alice.headers)
      await post(app, '/rest/v1/notes', { id: 2, owner: bob.id, body: 'b' }, bob.headers)
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id,body', alice.headers)).body, [{ id: 1, body: 'a' }])
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id,body', bob.headers)).body, [{ id: 2, body: 'b' }])
   })

   test('an anonymous select succeeds and returns nothing', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'a' }, alice.headers)
      const r = await get(app, '/rest/v1/notes?select=id')
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [])
   })

   test('a filter cannot be used to reach past the policy', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'secret' }, alice.headers)
      const r = await get(app, `/rest/v1/notes?select=body&id=eq.1`, bob.headers)
      assert.deepEqual(r.body, [])
   })

   test('an update by a non-owner matches nothing', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'original' }, alice.headers)
      const patched = await req(
         app,
         'PATCH',
         '/rest/v1/notes?id=eq.1',
         { body: 'tampered' },
         { ...bob.headers, Prefer: 'return=representation' },
      )
      assert.deepEqual(patched.body, [])
      assert.deepEqual((await get(app, '/rest/v1/notes?select=body', alice.headers)).body, [{ body: 'original' }])
   })

   test('an update by the owner applies', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'original' }, alice.headers)
      const patched = await req(
         app,
         'PATCH',
         '/rest/v1/notes?id=eq.1',
         { body: 'edited' },
         { ...alice.headers, Prefer: 'return=representation' },
      )
      assert.deepEqual(
         patched.body.map((row: any) => row.body),
         ['edited'],
      )
   })

   test('a delete by a non-owner removes nothing', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'a' }, alice.headers)
      const deleted = await req(app, 'DELETE', '/rest/v1/notes?id=eq.1', undefined, {
         ...bob.headers,
         Prefer: 'return=representation',
      })
      assert.deepEqual(deleted.body, [])
      assert.equal((await get(app, '/rest/v1/notes?select=id', alice.headers)).body.length, 1)
   })

   test('a delete by the owner removes the row', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'a' }, alice.headers)
      const deleted = await req(app, 'DELETE', '/rest/v1/notes?id=eq.1', undefined, {
         ...alice.headers,
         Prefer: 'return=representation',
      })
      assert.equal(deleted.body.length, 1)
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', alice.headers)).body, [])
   })

   test('count reflects the policy, not the table', async () => {
      await post(app, '/rest/v1/notes', { id: 1, owner: alice.id, body: 'a' }, alice.headers)
      await post(app, '/rest/v1/notes', { id: 2, owner: bob.id, body: 'b' }, bob.headers)
      const r = await get(app, '/rest/v1/notes?select=id', { ...alice.headers, Prefer: 'count=exact' })
      assert.match(r.contentRange ?? '', /\/1$/)
   })
})

describe('a SELECT-only policy', () => {
   let app: LiteApp
   let alice: Party

   before(async () => {
      ;({ app, alice } = await rlsApp(`
         CREATE TABLE readonly_notes (id int primary key, owner uuid, body text);
         ALTER TABLE readonly_notes ENABLE ROW LEVEL SECURITY;
         CREATE POLICY read_own ON readonly_notes FOR SELECT USING (owner = auth.uid());
      `))
   })

   test('a select is permitted', async () => {
      const r = await get(app, '/rest/v1/readonly_notes?select=id', alice.headers)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [])
   })
})

describe('a table without RLS', () => {
   test('is readable and writable by anyone', async () => {
      const { app } = await rlsApp('CREATE TABLE open_notes (id int primary key, body text);')
      const created = await post(
         app,
         '/rest/v1/open_notes',
         { id: 1, body: 'public' },
         { Prefer: 'return=representation' },
      )
      assert.equal(created.status, 201)
      assert.deepEqual((await get(app, '/rest/v1/open_notes?select=body')).body, [{ body: 'public' }])
   })
})
