// Asserts behaviour the published build does not have: /auth/v1/admin/* is not mounted there and
// falls through to the Studio page, so these fail with 200 and HTML rather than a 404.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { SignJWT } from 'jose'
import {
   newApp,
   newAppWithMailbox,
   newRawApp,
   get,
   post,
   req,
   JWT_SECRET,
   type LiteApp,
   type LiteConnection,
} from '../../test/harness.ts'

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

// An administrator presents an ordinary JWT with the `service_role` role, signed with the project
// secret — what supabase-js does with a service key. `sub` must be a real UUID: the zero UUID with
// this role is refused separately.
async function serviceToken(): Promise<Record<string, string>> {
   const token = await new SignJWT({ sub: crypto.randomUUID(), role: 'service_role', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET))
   return { Authorization: `Bearer ${token}` }
}

const rows = async (connection: LiteConnection, sql: string) =>
   ((await connection.exec(sql)).rows ?? []) as Record<string, unknown>[]

describe('FEAT-002 admin user API', () => {
   let app: LiteApp
   let connection: LiteConnection
   let admin: Record<string, string>

   before(async () => {
      ;({ app, connection } = await newApp({ seed: false }))
      admin = await serviceToken()
      for (const email of ['one@b.co', 'two@b.co'])
         await post(app, '/auth/v1/signup', { email, password: 'password123' })
   })

   test('listing users returns them', async () => {
      const r = await get(app, '/auth/v1/admin/users', admin)
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 140))
      assert.ok(Array.isArray(r.body.users), 'no users array')
      assert.deepEqual(r.body.users.map((u: { email: string }) => u.email).sort(), ['one@b.co', 'two@b.co'])
   })

   test('a single user can be fetched by id', async () => {
      const listed = (await get(app, '/auth/v1/admin/users', admin)).body.users[0]
      const r = await get(app, `/auth/v1/admin/users/${listed.id}`, admin)
      assert.equal(r.status, 200)
      assert.equal(r.body.id, listed.id)
   })

   // supabase-js does not read pagination out of the body: listUsers() takes `total` from
   // X-Total-Count and works out nextPage and lastPage from the Link header.
   test('the pagination headers supabase-js reads are present', async () => {
      const first = await req(app, 'GET', '/auth/v1/admin/users?page=1&per_page=1', undefined, admin)
      assert.equal(first.status, 200)
      assert.equal(first.headers.get('x-total-count'), '2')
      assert.equal(first.body.users.length, 1)

      const link = first.headers.get('link') ?? ''
      assert.match(link, /page=2[^>]*>; rel="next"/)
      assert.match(link, /rel="last"/)
      assert.doesNotMatch(link, /rel="prev"/)

      const last = await req(app, 'GET', '/auth/v1/admin/users?page=2&per_page=1', undefined, admin)
      assert.match(last.headers.get('link') ?? '', /rel="prev"/)
      assert.doesNotMatch(last.headers.get('link') ?? '', /rel="next"/)
      assert.notEqual(last.body.users[0].id, first.body.users[0].id)

      // `page` comes first in every link, because the parser reads the page out of the first `=` it
      // finds — `?per_page=1&page=2` would tell it the page is 1.
      assert.match(link, /<\/admin\/users\?page=\d+&per_page=\d+>/)
   })

   // An empty header is not an absent one: supabase-js splits on commas and parses each element, so
   // a collection with nothing in it still needs a link to parse.
   test('an empty page still carries a last link', async () => {
      const empty: { app: LiteApp } = await newApp({ seed: false })
      const r = await req(empty.app, 'GET', '/auth/v1/admin/users', undefined, admin)

      assert.equal(r.headers.get('x-total-count'), '0')
      assert.match(r.headers.get('link') ?? '', /rel="last"/)
      assert.deepEqual(r.body.users, [])
   })

   // The point of an administrative create: not the sign-up path wearing another URL. With sign-ups
   // off, a caller cannot register and an administrator still can.
   test('a user is created with sign-ups disabled, and is not signed in', async () => {
      const closed: { app: LiteApp; connection: LiteConnection } = await newRawApp({
         auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000', enable_signup: false },
      })
      const refused = await post(closed.app, '/auth/v1/signup', { email: 'nope@b.co', password: 'password123' })
      assert.equal(refused.body.error_code, 'signup_disabled')

      const created = await post(
         closed.app,
         '/auth/v1/admin/users',
         { email: 'made@b.co', password: 'password123', email_confirm: true },
         admin,
      )
      assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 140))
      assert.equal(created.body.email, 'made@b.co')

      // Created, not signed in: no session and no refresh token exist for them.
      assert.equal(created.body.access_token, undefined)
      assert.deepEqual(await rows(closed.connection, 'SELECT id FROM "auth.sessions"'), [])
      assert.deepEqual(await rows(closed.connection, 'SELECT id FROM "auth.refresh_tokens"'), [])

      // And the created user can sign in afterwards, so the password really was hashed.
      const signedIn = await post(closed.app, '/auth/v1/token?grant_type=password', {
         email: 'made@b.co',
         password: 'password123',
      })
      assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body).slice(0, 140))
   })

   test('a password is optional, and a phone number is an identifier of its own', async () => {
      const r = await post(app, '/auth/v1/admin/users', { phone: '+15550001', phone_confirm: true }, admin)
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 140))
      assert.equal(r.body.phone, '+15550001')
      assert.equal(r.body.email, '')
   })

   test('id, role and both metadata objects are taken from the request', async () => {
      const id = crypto.randomUUID()
      const r = await post(
         app,
         '/auth/v1/admin/users',
         {
            id,
            email: 'shaped@b.co',
            role: 'authenticated',
            app_metadata: { plan: 'pro' },
            user_metadata: { name: 'Ada' },
         },
         admin,
      )
      assert.equal(r.status, 200)
      assert.equal(r.body.id, id)
      assert.deepEqual(r.body.user_metadata, { name: 'Ada' })

      // Custom metadata applies over the providers, not instead of them: they record how the account
      // can be signed into, and `plan: 'pro'` is no reason to forget that.
      assert.deepEqual(r.body.app_metadata, { provider: 'email', providers: ['email'], plan: 'pro' })
   })

   // supabase-js types identities on a User, and admin-created users had none — every admin response
   // said the account could not be signed into at all.
   test('a created user has an identity per provider', async () => {
      const both = await post(app, '/auth/v1/admin/users', { email: 'two@id.co', phone: '+15550002' }, admin)
      assert.equal(both.status, 200, JSON.stringify(both.body).slice(0, 140))
      assert.deepEqual(both.body.identities.map((i: { provider: string }) => i.provider).sort(), ['email', 'phone'])
      assert.deepEqual(both.body.app_metadata, { provider: 'email', providers: ['email', 'phone'] })

      // And they are there when the user is read back, not only in the create response.
      const read = await get(app, `/auth/v1/admin/users/${both.body.id}`, admin)
      assert.equal(read.body.identities.length, 2)

      // Each identity carries only its own identifier: an email identity recording a phone number
      // would claim the account is reachable by phone through the email provider.
      const byProvider = new Map(
         both.body.identities.map((i: { provider: string; identity_data: Record<string, unknown> }) => [
            i.provider,
            i.identity_data,
         ]),
      )
      assert.deepEqual(byProvider.get('email'), { sub: both.body.id, email: 'two@id.co' })
      assert.deepEqual(byProvider.get('phone'), { sub: both.body.id, phone: '+15550002' })
      // As GoTrue does: `id` is the provider's own id, `identity_id` the row's. For email and phone
      // the provider id is the user itself.
      for (const identity of both.body.identities) assert.equal(identity.id, both.body.id)

      const byPhone = await post(app, '/auth/v1/admin/users', { phone: '+15550003' }, admin)
      assert.deepEqual(
         byPhone.body.identities.map((i: { provider: string }) => i.provider),
         ['phone'],
      )
      assert.deepEqual(byPhone.body.app_metadata, { provider: 'phone', providers: ['phone'] })
   })

   // A malformed request is a 400 and a refused one is a 422, which is the line GoTrue draws.
   test('a malformed create is a 400, and a refused one a 422', async () => {
      const cases: [Record<string, unknown> | undefined, number, string][] = [
         [undefined, 400, 'validation_failed'],
         [{}, 400, 'validation_failed'],
         [{ email: 'not an address' }, 400, 'validation_failed'],
         [{ phone: 'not a number' }, 400, 'validation_failed'],
         [
            { email: 'p@b.co', password: 'password123', password_hash: '$2a$10$abcdefghijklmnopqrstuv' },
            400,
            'validation_failed',
         ],
         // The conflict is in the fields sent, not their values: a blank password beside a hash still
         // contradicts itself, and GoTrue refuses it before ever reading the password.
         [{ email: 'p@b.co', password: '', password_hash: '$2a$10$abcdefghijklmnopqrstuv' }, 400, 'validation_failed'],
         [{ email: 'p@b.co', id: 'not-a-uuid' }, 400, 'validation_failed'],
         [{ email: 'p@b.co', id: '00000000-0000-0000-0000-000000000000' }, 400, 'validation_failed'],
         [{ email: 'one@b.co', password: 'password123' }, 422, 'email_exists'],
      ]

      for (const [body, status, code] of cases) {
         const r = await post(app, '/auth/v1/admin/users', body, admin)
         assert.equal(r.status, status, `${JSON.stringify(body)} answered ${r.status}`)
         assert.equal(r.body.error_code, code, JSON.stringify(body))
      }
   })

   // A blank password is no password rather than a weak one, and no password means a random one —
   // not an empty credential a passwordless path could hand to anyone who knows the address.
   test('an absent or blank password is replaced by one nobody knows', async () => {
      const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })

      for (const [label, body] of [
         ['absent', { email: 'nopass@b.co' }],
         ['blank', { email: 'blank@b.co', password: '' }],
         // An empty `password_hash` is an absent one, so this is the no-credential case too — and the
         // one where getting it wrong writes an empty `encrypted_password` rather than a random one.
         ['blank hash', { email: 'blankhash@b.co', password_hash: '' }],
      ] as [string, Record<string, unknown>][]) {
         const r = await post(fresh.app, '/auth/v1/admin/users', body, admin)
         assert.equal(r.status, 200, `${label}: ${JSON.stringify(r.body).slice(0, 120)}`)

         const [row] = await rows(
            fresh.connection,
            `SELECT encrypted_password FROM "auth.users" WHERE id = '${r.body.id}'`,
         )
         assert.ok(row.encrypted_password, `${label}: no credential was set`)

         const guessed = await post(fresh.app, '/auth/v1/token?grant_type=password', {
            email: body.email,
            password: '',
         })
         assert.notEqual(guessed.status, 200, `${label}: the empty password worked`)
      }
   })

   test('a duplicate phone number is refused', async () => {
      await post(app, '/auth/v1/admin/users', { phone: '+15559999' }, admin)
      const again = await post(app, '/auth/v1/admin/users', { phone: '+15559999' }, admin)
      assert.equal(again.status, 422)
      assert.equal(again.body.error_code, 'phone_exists')
   })

   test('a create with neither email nor phone is refused, and creates nothing', async () => {
      const before = (await get(app, '/auth/v1/admin/users', admin)).body.users.length

      for (const body of [undefined, {}, { password: 'password123' }]) {
         const r = await post(app, '/auth/v1/admin/users', body, admin)
         assert.equal(r.status, 400, `${JSON.stringify(body)} answered ${r.status}`)
         assert.equal(r.body.error_code, 'validation_failed')
      }

      assert.equal((await get(app, '/auth/v1/admin/users', admin)).body.users.length, before)
   })

   // A broken body and an absent one are different mistakes and are reported differently.
   test('a malformed body is bad JSON, not a missing field', async () => {
      const r = await req(app, 'POST', '/auth/v1/admin/users', '{broken', {
         ...admin,
         'Content-Type': 'application/json',
      })
      assert.equal(r.status, 400)
      assert.equal(r.body.error_code, 'bad_json')
   })

   test('a duplicate address is refused', async () => {
      const r = await post(app, '/auth/v1/admin/users', { email: 'one@b.co', password: 'password123' }, admin)
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'email_exists')
   })

   test('a user can be deleted, and their sessions go with them', async () => {
      const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      const session = (await post(fresh.app, '/auth/v1/signup', { email: 'gone@b.co', password: 'password123' })).body

      const deleted = await req(fresh.app, 'DELETE', `/auth/v1/admin/users/${session.user.id}`, undefined, admin)
      // GoTrue's answer: 200 with an empty object, not a 204 and not the user, since supabase-js runs
      // whatever comes back through its user transform.
      assert.equal(deleted.status, 200)
      assert.deepEqual(deleted.body, {})

      assert.equal((await get(fresh.app, `/auth/v1/admin/users/${session.user.id}`, admin)).status, 404)
      assert.deepEqual(await rows(fresh.connection, 'SELECT id FROM "auth.sessions"'), [])
      assert.deepEqual(await rows(fresh.connection, 'SELECT token FROM "auth.refresh_tokens"'), [])
   })

   // supabase-js sends `{ should_soft_delete }`. Upstream keeps the row and its id, replaces the
   // identifiers with a digest, clears the password, empties both metadata objects and the identity
   // data, and deletes the factors outright.
   test('a soft delete empties the user and unnames them', async () => {
      const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      const session = (
         await post(fresh.app, '/auth/v1/signup', {
            email: 'soft@b.co',
            password: 'password123',
            data: { plan: 'pro' },
         })
      ).body

      const deleted = await req(
         fresh.app,
         'DELETE',
         `/auth/v1/admin/users/${session.user.id}`,
         { should_soft_delete: true },
         admin,
      )
      assert.equal(deleted.status, 200)
      assert.deepEqual(deleted.body, {})

      const [row] = await rows(
         fresh.connection,
         `SELECT id, email, deleted_at, encrypted_password, raw_user_meta_data, raw_app_meta_data, confirmation_token
            FROM "auth.users"`,
      )
      assert.ok(row.deleted_at, 'deleted_at was not set')
      assert.equal(row.id, session.user.id, 'the row and its id are kept, so references still resolve')

      // GoTrue replaces the identifiers with base64url(sha256(id + value)) rather than keeping them.
      assert.notEqual(row.email, 'soft@b.co', 'the address was kept, so it stays registered for ever')
      assert.match(String(row.email), /^[A-Za-z0-9_-]{43}$/)

      assert.equal(row.encrypted_password, null)
      assert.equal(row.raw_user_meta_data, '{}')
      assert.equal(row.raw_app_meta_data, '{}')
      assert.equal(row.confirmation_token, null)

      // Emptied and re-keyed, not removed, so references to the identity still resolve.
      const identities = await rows(fresh.connection, 'SELECT identity_data, provider_id FROM "auth.identities"')
      assert.equal(identities.length, 1)
      assert.equal(identities[0].identity_data, '{}')
      assert.notEqual(identities[0].provider_id, session.user.id)

      // The consequence an operator meets: the address is free again.
      const again = await req(fresh.app, 'POST', '/auth/v1/admin/users', { email: 'soft@b.co' }, admin)
      assert.equal(again.status, 200, `the address stayed registered: ${JSON.stringify(again.body).slice(0, 120)}`)
      assert.notEqual(again.body.id, session.user.id)

      // And the old credentials are gone with it.
      const signedIn = await post(fresh.app, '/auth/v1/token?grant_type=password', {
         email: 'soft@b.co',
         password: 'password123',
      })
      assert.notEqual(signedIn.status, 200)
   })

   /**
    * A soft delete claims the user cannot sign in. The identifiers no longer name the row, so the
    * passwordless paths cannot reach it — but they are exercised anyway, because a code delivered to
    * an address that is now free is a different matter from one delivered to a deleted user. What
    * must hold either way: nothing authenticates as that id.
    */
   test('a soft-deleted user cannot sign in by any path this build offers', async () => {
      const { app: fresh, connection, mail } = await newAppWithMailbox()
      const email = 'revoked@b.co'
      const signup = (await post(fresh, '/auth/v1/signup', { email, password: 'password123' })).body

      await req(fresh, 'DELETE', `/auth/v1/admin/users/${signup.user.id}`, { should_soft_delete: true }, admin)

      const password = await post(fresh, '/auth/v1/token?grant_type=password', { email, password: 'password123' })
      assert.notEqual(password.status, 200, 'the password still worked')

      assert.equal((await post(fresh, '/auth/v1/otp', { email })).status, 200)
      const code = mail.code(email)
      if (code) {
         const verified = await post(fresh, '/auth/v1/verify', { type: 'magiclink', token: code, email })
         if (verified.status === 200) assert.notEqual(verified.body.user.id, signup.user.id)
      }

      assert.equal((await post(fresh, '/auth/v1/recover', { email })).status, 200)
      const token = mail.token(email)
      if (token) {
         const recovered = await post(fresh, '/auth/v1/verify', { type: 'recovery', token, email })
         if (recovered.status === 200) assert.notEqual(recovered.body.user.id, signup.user.id)
      }

      const owned = (table: string) => `SELECT id FROM "auth.${table}" WHERE user_id = '${signup.user.id}'`
      assert.deepEqual(await rows(connection, owned('sessions')), [])
      assert.deepEqual(await rows(connection, owned('refresh_tokens')), [])

      // The row itself is still there, by id, for the guard to refuse.
      const direct = await req(fresh, 'GET', `/auth/v1/admin/users/${signup.user.id}`, undefined, admin)
      assert.equal(direct.status, 200)
   })

   /**
    * The token already issued, which the guard on session creation says nothing about.
    *
    * The auth API revokes it at once, and not through this patch: the middleware loads the session
    * named by `session_id` and refuses when it is gone, so deleting the row ends the token. Worth a
    * test precisely because it is somebody else's behaviour — a build that stopped checking the
    * session would take this claim with it unnoticed.
    *
    * The Data API does not revoke. PostgREST validates the signature and expiry and asks nobody about
    * sessions, so `auth.uid()` keeps resolving to a deleted user until the token expires — upstream
    * Supabase's behaviour too, but the limit of what a soft delete buys, so it is asserted rather
    * than left to be discovered. The exposure is bounded by the token's lifetime and closed by no new
    * one being mintable.
    */
   test('a stale access token dies on the auth API and outlives the delete on the data API', async () => {
      const { app: fresh, connection: db }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      await (
         await db.createMigrator(`
            CREATE TABLE notes (id int primary key, owner uuid, body text);
            ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
            CREATE POLICY own_all ON notes FOR ALL USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
         `)
      ).migrate()

      const session = (await post(fresh, '/auth/v1/signup', { email: 'stale@b.co', password: 'password123' })).body
      const stale = { Authorization: `Bearer ${session.access_token}` }
      await post(fresh, '/rest/v1/notes', { id: 1, owner: session.user.id, body: 'mine' }, stale)
      assert.equal((await get(fresh, '/auth/v1/user', stale)).status, 200, 'the token did not work to begin with')

      const deleted = await req(
         fresh,
         'DELETE',
         `/auth/v1/admin/users/${session.user.id}`,
         { should_soft_delete: true },
         admin,
      )
      assert.equal(deleted.status, 200)

      // Immediately, on a token whose `exp` is still an hour away.
      const whoami = await get(fresh, '/auth/v1/user', stale)
      assert.equal(whoami.status, 403, JSON.stringify(whoami.body).slice(0, 140))
      assert.equal(whoami.body.error_code, 'session_not_found')

      // The refresh token went with the session, so no new token can be minted from the old one.
      const refreshed = await post(fresh, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: session.refresh_token,
      })
      assert.notEqual(refreshed.status, 200)
      assert.equal(refreshed.body.error_code, 'refresh_token_not_found')

      // And the limit, asserted so it cannot quietly become something else: the rows stay reachable
      // with the old token until it expires.
      const read = await get(fresh, '/rest/v1/notes', stale)
      assert.equal(read.status, 200)
      assert.equal(read.body.length, 1, 'RLS stopped resolving auth.uid() for the deleted user')
   })

   /**
    * `password_hash` exists for moving accounts in from another system, and nothing downstream looks
    * at it again: bcrypt's compare answers "no" to a malformed digest just as to a wrong password. An
    * unchecked hash does not fail — it creates a user who can never sign in and is never told why.
    */
   test('a password_hash that is not a bcrypt hash is refused', async () => {
      for (const hash of ['not-a-hash', '$2a$10$tooshort', '$1$abc$xyz', '$2a$10$' + 'a'.repeat(52)]) {
         const r = await post(
            app,
            '/auth/v1/admin/users',
            { email: `h${Math.random()}@b.co`, password_hash: hash },
            admin,
         )
         assert.equal(r.status, 400, `${hash} was accepted`)
         assert.equal(r.body.error_code, 'validation_failed')
      }
      assert.deepEqual(await rows(connection, `SELECT id FROM "auth.users" WHERE email LIKE 'h0.%'`), [])
   })

   test('a bcrypt hash is stored as the credential', async () => {
      const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      // bcrypt of 'password123', cost 10 — what a migration from any bcrypt store hands over.
      const hash = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

      const r = await post(fresh.app, '/auth/v1/admin/users', { email: 'moved@b.co', password_hash: hash }, admin)
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 140))

      // Stored verbatim: the plaintext never existed here, which is the whole point of the field.
      const [row] = await rows(fresh.connection, `SELECT encrypted_password FROM "auth.users"`)
      assert.equal(row.encrypted_password, hash)
   })

   test('deleting someone who is not there is a 404', async () => {
      const r = await req(app, 'DELETE', `/auth/v1/admin/users/${crypto.randomUUID()}`, undefined, admin)
      assert.equal(r.status, 404)
      assert.equal(r.body.error_code, 'user_not_found')
   })

   // Declared after requireAuth(), so the routes inherit it rather than carrying their own idea of
   // who may call them.
   test('an unauthenticated request never reaches the handler', async () => {
      const bare = await get(app, '/auth/v1/admin/users')
      assert.equal(bare.status, 401)
      assert.equal(bare.body.error_code, 'no_authorization')

      const garbage = await get(app, '/auth/v1/admin/users', { Authorization: 'Bearer not-a-jwt' })
      assert.equal(garbage.status, 403)
      assert.equal(garbage.body.error_code, 'bad_jwt')
   })

   test('an ordinary user token is refused', async () => {
      const session = (await post(app, '/auth/v1/signup', { email: 'plain@b.co', password: 'password123' })).body
      const r = await get(app, '/auth/v1/admin/users', { Authorization: `Bearer ${session.access_token}` })
      assert.equal(r.status, 403)
      assert.equal(r.body.error_code, 'not_admin')
   })

   /**
    * Input read strictly, because the lenient reading of each of these was a wrong answer rather than
    * a rough one: a mistyped delete flag removed the user irreversibly, and a page that is not a whole
    * number reached the database as an OFFSET and came back a 500.
    */
   describe('malformed input is refused before anything happens', () => {
      test('a should_soft_delete that is not a boolean is a 400, and keeps the user', async () => {
         const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
         const user = (await post(fresh.app, '/auth/v1/signup', { email: 'typo@b.co', password: 'password123' })).body
            .user

         const r = await req(
            fresh.app,
            'DELETE',
            `/auth/v1/admin/users/${user.id}`,
            { should_soft_delete: 'true' },
            admin,
         )
         assert.equal(r.status, 400, `a string flag was accepted: ${JSON.stringify(r.body).slice(0, 120)}`)
         assert.equal((await rows(fresh.connection, 'SELECT id FROM "auth.users"')).length, 1, 'the user was removed')
      })

      test('a body that is not an object is bad JSON', async () => {
         const r = await req(app, 'POST', '/auth/v1/admin/users', '[1,2]', {
            ...admin,
            'Content-Type': 'application/json',
         })
         assert.equal(r.status, 400)
         assert.equal(r.body.error_code, 'bad_json')
      })

      for (const query of ['page=1.5', 'per_page=1.5', 'page=Infinity', 'page=0', 'per_page=-1'])
         test(`?${query} is a 400, not a 500`, async () => {
            const r = await get(app, `/auth/v1/admin/users?${query}`, admin)
            assert.equal(r.status, 400, `answered ${r.status}`)
         })
   })

   // `createUser` writes a fixed set of columns and `phone_confirmed_at` is not among them, so the
   // flag was accepted and dropped.
   test('phone_confirm marks the number confirmed', async () => {
      const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      const r = await req(fresh.app, 'POST', '/auth/v1/admin/users', { phone: '+15550777', phone_confirm: true }, admin)
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 140))

      const [row] = await rows(fresh.connection, 'SELECT phone_confirmed_at FROM "auth.users"')
      assert.ok(row.phone_confirmed_at, 'phone_confirm was accepted and dropped')
   })

   /**
    * The generated password has to satisfy the configured policy, or the route refuses its own
    * credential — after the row is written, leaving a user with no password and an address that now
    * answers `email_exists`.
    */
   test('a minimum password length longer than the generator is still satisfied', async () => {
      const strict: { app: LiteApp; connection: LiteConnection } = await newRawApp({
         auth: {
            enabled: true,
            jwt_secret: JWT_SECRET,
            site_url: 'http://localhost:3000',
            minimum_password_length: 72,
         },
      })

      const r = await req(strict.app, 'POST', '/auth/v1/admin/users', { email: 'long@b.co' }, admin)
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 140))

      const [row] = await rows(strict.connection, 'SELECT encrypted_password FROM "auth.users"')
      assert.match(String(row.encrypted_password), /^\$2[aby]\$/, 'the user was left without a password')
   })

   /**
    * `role` is an ordinary admin field in GoTrue, and this route passes it through as upstream does.
    * Pinned rather than restricted, because the consequence is sharper here than the field looks: in
    * this build `service_role` bypasses RLS, so a user created with that role holds a password login
    * that reads every table. An administrator can do that deliberately; nobody should do it by
    * accident, and a change that started defaulting it would show up here.
    */
   test('a role given at creation reaches the token, service_role included', async () => {
      const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      await (
         await fresh.connection.createMigrator(
            [
               'CREATE TABLE secrets (id int primary key, body text);',
               'ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;',
               'CREATE POLICY nobody ON secrets FOR ALL USING (false) WITH CHECK (true);',
            ].join('\n'),
         )
      ).migrate()
      await fresh.connection.exec("INSERT INTO secrets (id, body) VALUES (1, 'classified')")

      const created = await req(
         fresh.app,
         'POST',
         '/auth/v1/admin/users',
         { email: 'elevated@b.co', password: 'password123', role: 'service_role', email_confirm: true },
         admin,
      )
      assert.equal(created.status, 200, JSON.stringify(created.body).slice(0, 140))
      assert.equal(created.body.role, 'service_role')

      const session = await post(fresh.app, '/auth/v1/token?grant_type=password', {
         email: 'elevated@b.co',
         password: 'password123',
      })
      assert.equal(session.status, 200, JSON.stringify(session.body).slice(0, 140))
      assert.equal(claimsOf(session.body.access_token).role, 'service_role')

      const read = await get(fresh.app, '/rest/v1/secrets?select=body', {
         Authorization: `Bearer ${session.body.access_token}`,
      })
      assert.deepEqual(read.body, [{ body: 'classified' }], 'service_role no longer bypasses RLS')
   })

   // The default is unchanged: an ordinary create is `authenticated`.
   test('a create without a role is authenticated', async () => {
      const r = await req(app, 'POST', '/auth/v1/admin/users', { email: 'plain-role@b.co' }, admin)
      assert.equal(r.status, 200)
      assert.equal(r.body.role, 'authenticated')
   })
})
