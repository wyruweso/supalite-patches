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
   'CREATE TABLE items (id int primary key, nums int[], price numeric(8,2), born date);',
   'CREATE TABLE authors (id int primary key, name text not null);',
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

   /**
    * RLS denies per command: a table with only a FOR SELECT policy permits no inserts. The refusal
    * was correct and the row was not written — only its status was wrong.
    *
    * `42501` is Postgres's insufficient_privilege, what PostgREST and hosted Supabase answer a policy
    * refusal with. The neighbouring WITH CHECK path answers PGRST301 ("the JWT did not verify") and
    * keeps doing so: pinned two tests below, since it is not a 500 and so not this patch's to change.
    */
   test('an insert refused for want of a policy is a 42501, not a 500', async () => {
      const r = await post(rlsApp, '/rest/v1/readonly_notes', { id: 1, body: 'x' }, alice)
      assert.equal(r.status, 403)
      assert.equal(pgrstCode(r), '42501')
      assert.match(r.body.message, /row-level security policy for table "readonly_notes"/)
   })

   test('an unnamed CHECK violation is a 400, not a 500', async () => {
      const r = await post(typedApp, '/rest/v1/items', { id: 2, price: 1.005 }, REPRESENT)
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

   test('a NOT NULL violation is a 400, not a 500', async () => {
      const r = await post(typedApp, '/rest/v1/authors', { id: 8, name: null }, REPRESENT)
      assert.equal(r.status, 400)
      assert.equal(pgrstCode(r), '23502')
   })

   // Guards: what already worked must keep working.
   test('a valid reference is still accepted', async () => {
      await post(typedApp, '/rest/v1/authors', { id: 1, name: 'Tolstoy' }, REPRESENT)
      const r = await post(typedApp, '/rest/v1/books', { id: 2, author_id: 1 }, REPRESENT)
      assert.equal(r.status, 201, `PGRST code: ${pgrstCode(r)}`)
   })

   /**
    * The working neighbours, asserted on the whole body rather than a status and a code.
    *
    * The wrapper runs before the original, so anything it recognises it answers itself — and a named
    * CHECK reaches it as `CHECK constraint failed: array_type`, which `constraintViolation` matches.
    * Both answer 400/23514, so only the rest of the body shows which one replied: the original says
    * `check constraint "array_type" violated for items.nums` with the name in `details`, the wrapper
    * would put raw SQLite text in both.
    *
    * Guards, not fixes: these must not diverge, which is why neither is declared.
    */
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

   /**
    * The other working neighbour: a policy that exists whose WITH CHECK fails — the path the broken
    * one was diagnosed against, so it has to be shown untouched, PGRST301 included, while the
    * refusal this patch fixes now answers 42501. The disagreement is deliberate: upstream's shape
    * restored on one path, not this build's shape spread to both.
    */
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
