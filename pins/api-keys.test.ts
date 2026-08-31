// The publishable / secret key guard, and the routes that sit outside it.
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newRawApp, newApp, get, post, req, type LiteApp, type LiteConnection } from '../test/harness.ts'

const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters'
const PUBLISHABLE = 'sb_publishable_testkey'
const SECRET = 'sb_secret_testkey'

const keyedConfig = {
   auth: {
      enabled: true,
      jwt_secret: JWT_SECRET,
      site_url: 'http://localhost:3000',
      publishable_key: PUBLISHABLE,
      secret_key: SECRET,
   },
}

describe('with no keys configured', () => {
   test('the guard is disabled and every route is open', async () => {
      const { app, connection } = await newRawApp({
         auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000' },
      })
      await connection.exec('CREATE TABLE t (id integer primary key)')
      assert.equal((await get(app, '/rest/v1/t?select=id')).status, 200)
   })

   test('an invalid key is ignored rather than rejected', async () => {
      const { app, connection } = await newRawApp({
         auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000' },
      })
      await connection.exec('CREATE TABLE t (id integer primary key)')
      assert.equal((await get(app, '/rest/v1/t?select=id', { apikey: 'nonsense' })).status, 200)
   })
})

describe('with keys configured', () => {
   let app: LiteApp
   before(async () => {
      const made = await newRawApp(keyedConfig)
      app = made.app
      await made.connection.exec('CREATE TABLE t (id integer primary key, v text)')
   })

   test('a request with no key is refused', async () => {
      const r = await get(app, '/rest/v1/t?select=id')
      assert.equal(r.status, 401)
      assert.equal(r.body.message, 'No API key found in request')
      assert.equal(r.body.hint, 'No `apikey` request header or url param was found.')
   })

   test('an unrecognised key is refused with a different message', async () => {
      const r = await get(app, '/rest/v1/t?select=id', { apikey: 'sb_secret_wrong' })
      assert.equal(r.status, 401)
      assert.equal(r.body.message, 'Invalid API key')
      assert.equal(r.body.hint, 'Double check your Supabase `apikey`')
   })

   test('the publishable key is accepted', async () => {
      assert.equal((await get(app, '/rest/v1/t?select=id', { apikey: PUBLISHABLE })).status, 200)
   })

   test('the secret key is accepted', async () => {
      assert.equal((await get(app, '/rest/v1/t?select=id', { apikey: SECRET })).status, 200)
   })

   test('the key may be given as a url parameter instead of a header', async () => {
      assert.equal((await get(app, `/rest/v1/t?select=id&apikey=${PUBLISHABLE}`)).status, 200)
   })

   test('a wrong key in the url parameter is refused too', async () => {
      assert.equal((await get(app, '/rest/v1/t?select=id&apikey=bad')).status, 401)
   })

   test('an api key in the Authorization header does NOT satisfy the guard', async () => {
      const r = await get(app, '/rest/v1/t?select=id', { Authorization: `Bearer ${PUBLISHABLE}` })
      assert.equal(r.status, 401)
      assert.equal(r.body.message, 'No API key found in request')
   })
})

describe('which routes the guard covers', () => {
   let app: LiteApp
   before(async () => {
      app = (await newRawApp(keyedConfig)).app
   })

   test('the auth service is behind the guard', async () => {
      assert.equal((await get(app, '/auth/v1/health')).status, 401)
      assert.equal((await post(app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })).status, 401)
   })

   test('signup succeeds once the key is presented', async () => {
      const r = await post(
         app,
         '/auth/v1/signup',
         { email: 'keyed@b.co', password: 'password123' },
         { apikey: PUBLISHABLE },
      )
      assert.equal(r.status, 200)
      assert.ok(r.body.access_token)
   })

   test('the _system routes are NOT behind the guard', async () => {
      assert.equal((await get(app, '/_system/ping')).status, 200)
      assert.equal((await get(app, '/_system/config')).status, 200)
   })
})

describe('service_role and row level security', () => {
   let app: LiteApp
   let connection: LiteConnection
   let userAuth: Record<string, string>
   let userId: string
   const OTHER = '00000000-0000-0000-0000-000000000000'

   beforeEach(async () => {
      ;({ app, connection } = await newRawApp(keyedConfig))
      await (
         await connection.createMigrator(`
            CREATE TABLE notes (id int primary key, owner uuid, body text);
            ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
            CREATE POLICY own_all ON notes FOR ALL USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
         `)
      ).migrate()
      const session = (
         await post(app, '/auth/v1/signup', { email: 'owner@b.co', password: 'password123' }, { apikey: PUBLISHABLE })
      ).body
      userId = session.user.id
      userAuth = { apikey: PUBLISHABLE, Authorization: `Bearer ${session.access_token}` }
      await post(app, '/rest/v1/notes', { id: 1, owner: userId, body: 'mine' }, userAuth)
   })

   test('the owner sees their row', async () => {
      assert.deepEqual((await get(app, '/rest/v1/notes?select=body', userAuth)).body, [{ body: 'mine' }])
   })

   test('the publishable key alone is anon, and sees nothing', async () => {
      assert.deepEqual((await get(app, '/rest/v1/notes?select=body', { apikey: PUBLISHABLE })).body, [])
   })

   test('the secret key is service_role and BYPASSES the policy', async () => {
      assert.deepEqual((await get(app, '/rest/v1/notes?select=body', { apikey: SECRET })).body, [{ body: 'mine' }])
   })

   test('service_role can write a row it does not own', async () => {
      const r = await post(
         app,
         '/rest/v1/notes',
         { id: 2, owner: OTHER, body: 'written by the service' },
         { apikey: SECRET, Prefer: 'return=representation' },
      )
      assert.equal(r.status, 201)
      assert.equal(r.body[0].owner, OTHER)
   })

   test('service_role can delete a row it does not own', async () => {
      const r = await req(app, 'DELETE', '/rest/v1/notes?id=eq.1', undefined, {
         apikey: SECRET,
         Prefer: 'return=representation',
      })
      assert.equal(r.body.length, 1)
      assert.deepEqual((await get(app, '/rest/v1/notes?select=id', { apikey: SECRET })).body, [])
   })
})

describe('key format helpers line up with the guard', () => {
   test('the configured keys carry the prefixes apiKeyType recognises', async () => {
      const { lite } = await import('../test/harness.ts')
      assert.equal(lite.apiKeyType(PUBLISHABLE), 'publishable')
      assert.equal(lite.apiKeyType(SECRET), 'secret')
   })

   test('a generated key is accepted when it is the configured one', async () => {
      const { lite } = await import('../test/harness.ts')
      const generated = await lite.generateApiKey('secret')
      const { app, connection } = await newRawApp({
         auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000', secret_key: generated.key },
      })
      await connection.exec('CREATE TABLE t (id integer primary key)')
      assert.equal((await get(app, '/rest/v1/t?select=id', { apikey: generated.key })).status, 200)
      assert.equal((await get(app, '/rest/v1/t?select=id', { apikey: 'sb_secret_other' })).status, 401)
   })
})

describe('auth disabled', () => {
   test('a request still works with no auth service configured at all', async () => {
      const { app } = await newApp({ auth: false })
      assert.equal((await get(app, '/rest/v1/authors?select=id')).status, 200)
   })
})
