// Asserts the CORRECT behaviour, so it fails on the published build by design.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, post, pgrstCode, type LiteApp, type LiteConnection } from '../../test/harness.ts'

const RLS = `CREATE TABLE readonly_notes (id int primary key, owner uuid, body text);
ALTER TABLE readonly_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON readonly_notes FOR SELECT USING (true);
CREATE TABLE owned_notes (id int primary key, owner uuid, body text);
ALTER TABLE owned_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON owned_notes FOR ALL USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());`

const TYPES = [
   'CREATE TABLE items (id int primary key, nums int[], quantity int check (quantity > 0), born date);',
   'CREATE TABLE authors (id int primary key, name text not null, email text unique);',
   'CREATE TABLE books (id int primary key, author_id int references authors(id));',
].join('\n')

const REPRESENT = { Prefer: 'return=representation' }

describe('FIX-002 client errors are not reported as server faults', () => {
   let rlsApp: LiteApp
   let typedApp: LiteApp
   let alice: Record<string, string>

   before(async () => {
      const a: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      await (await a.connection.createMigrator(RLS)).migrate()
      const session = (await post(a.app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })).body
      rlsApp = a.app
      alice = { Authorization: `Bearer ${session.access_token}` }

      const b: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      await (await b.connection.createMigrator(TYPES)).migrate()
      typedApp = b.app
   })

   // The policy correctly blocks the insert; only the response changes to SQLSTATE 42501.
   test('an insert refused for want of a policy is a 42501, not a 500', async () => {
      const r = await post(rlsApp, '/rest/v1/readonly_notes', { id: 1, body: 'x' }, alice)
      assert.equal(r.status, 403)
      assert.equal(pgrstCode(r), '42501')
      assert.match(r.body.message, /row-level security policy for table "readonly_notes"/)
   })

   test('an unnamed CHECK violation is a 400, not a 500', async () => {
      const r = await post(typedApp, '/rest/v1/items', { id: 2, quantity: -1 }, REPRESENT)
      assert.equal(r.status, 400)
      assert.equal(pgrstCode(r), '23514')
   })

   test('an invalid date is a 400 too', async () => {
      const r = await post(typedApp, '/rest/v1/items', { id: 3, born: 'not-a-date' }, REPRESENT)
      assert.equal(r.status, 400)
      assert.equal(pgrstCode(r), '23514')
   })

   test('a dangling foreign key is a 409, not a 500', async () => {
      const r = await post(typedApp, '/rest/v1/books', { id: 1, author_id: 999 }, REPRESENT)
      assert.equal(r.status, 409)
      assert.equal(pgrstCode(r), '23503')
   })

   // The most common client error any API has, falling through for the same reason: normalizeDbError
   // recognises the better-sqlite3 error shape, while the package ships node:sqlite.
   test('a duplicate primary key is a 409, not a 500', async () => {
      await post(typedApp, '/rest/v1/authors', { id: 7, name: 'Gogol' }, REPRESENT)
      const r = await post(typedApp, '/rest/v1/authors', { id: 7, name: 'Gogol' }, REPRESENT)
      assert.equal(r.status, 409)
      assert.equal(pgrstCode(r), '23505')
   })

   // A different SQLite code from the one above — 2067 rather than 1555 — and the same SQLSTATE.
   test('a duplicate value in a UNIQUE column is a 409 too', async () => {
      await post(typedApp, '/rest/v1/authors', { id: 20, name: 'a', email: 'a@b.co' }, REPRESENT)
      const r = await post(typedApp, '/rest/v1/authors', { id: 21, name: 'b', email: 'a@b.co' }, REPRESENT)
      assert.equal(r.status, 409)
      assert.equal(pgrstCode(r), '23505')
   })

   test('an anonymous caller refused for want of a policy is a 401', async () => {
      const r = await post(rlsApp, '/rest/v1/readonly_notes', { id: 9, body: 'x' })
      assert.equal(r.status, 401)
      assert.equal(pgrstCode(r), '42501')
   })

   test('a NOT NULL violation is a 400, not a 500', async () => {
      const r = await post(typedApp, '/rest/v1/authors', { id: 8, name: null }, REPRESENT)
      assert.equal(r.status, 400)
      assert.equal(pgrstCode(r), '23502')
   })

   // Numeric driver codes take precedence; messages alone must not reclassify a formed error.
   describe('normalizeDbError', () => {
      let normalise: (err: unknown) => { code?: string; detail?: string; hint?: string; message?: string }

      before(async () => {
         const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
         const c = connection as unknown as { normalizeDbError(e: unknown): never }
         normalise = (err) => c.normalizeDbError(err)
      })

      test('a node:sqlite constraint error is given its SQLSTATE', () => {
         const result = normalise({
            code: 'ERR_SQLITE_ERROR',
            errcode: 2067,
            message: 'UNIQUE constraint failed: authors.email',
         })
         assert.equal(result.code, '23505')
      })

      test('an error that already carries a code is returned untouched', () => {
         const formed = {
            code: 'PT422',
            message: 'UNIQUE constraint failed: items.email',
            detail: 'custom detail',
            hint: 'custom hint',
         }
         const result = normalise(formed)
         assert.equal(result, formed)
         assert.equal(result.code, 'PT422')
         assert.equal(result.detail, 'custom detail')
         assert.equal(result.hint, 'custom hint')
      })

      test('an error the constraint table does not know is returned untouched', () => {
         const unknown = { code: 'ERR_SQLITE_ERROR', errcode: 999999, message: 'something else entirely' }
         assert.equal(normalise(unknown), unknown)

         const plain = new Error('disk I/O error')
         assert.equal(normalise(plain), plain)
      })
   })

   // Guards: what already worked must keep working.
   test('a valid reference is still accepted', async () => {
      await post(typedApp, '/rest/v1/authors', { id: 1, name: 'Tolstoy' }, REPRESENT)
      const r = await post(typedApp, '/rest/v1/books', { id: 2, author_id: 1 }, REPRESENT)
      assert.equal(r.status, 201, `PGRST code: ${pgrstCode(r)}`)
   })

   // Compare the whole response: the named CHECK path must retain its constraint details.
   test('a named CHECK violation is unchanged', async () => {
      const r = await post(typedApp, '/rest/v1/items', { id: 4, nums: 'not-an-array' }, REPRESENT)
      assert.equal(r.status, 400)
      assert.deepEqual(r.body, {
         code: '23514',
         details: 'check constraint "array_type" violated',
         hint: null,
         message: 'check constraint "array_type" violated for items.nums',
      })
   })

   // The existing WITH CHECK path keeps PGRST301 on both builds.
   test('a WITH CHECK refusal on an existing policy is unchanged', async () => {
      const mine = '00000000-0000-0000-0000-000000000001'

      const authenticated = await post(rlsApp, '/rest/v1/owned_notes', { id: 1, owner: mine, body: 'x' }, alice)
      assert.equal(authenticated.status, 403)
      assert.deepEqual(authenticated.body, {
         code: 'PGRST301',
         details: null,
         hint: null,
         message: 'new row violates row-level security policy for table "owned_notes"',
      })

      // And anonymously, where the status is a 401 instead — the same rule the fixed path follows.
      const anonymous = await post(rlsApp, '/rest/v1/owned_notes', { id: 2, owner: mine, body: 'x' })
      assert.equal(anonymous.status, 401)
      assert.equal(pgrstCode(anonymous), 'PGRST301')
   })
})
