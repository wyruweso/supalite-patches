// Asserts behaviour the published build does not have: it refuses anonymous sign-in with
// `anonymous_provider_disabled`.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite, newRawApp, get, post, req, JWT_SECRET, type LiteApp, type LiteConnection } from '../../test/harness.ts'

// supabase-js calls signInAnonymously() with the same request as an ordinary sign-up.
const anon = (app: LiteApp, data?: Record<string, unknown>) => post(app, '/auth/v1/signup', data ? { data } : {})

const newAnonApp = (auth: Record<string, unknown> = {}) =>
   newRawApp({
      auth: {
         enabled: true,
         jwt_secret: JWT_SECRET,
         site_url: 'http://localhost:3000',
         enable_anonymous_sign_ins: true,
         ...auth,
      },
   })

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

describe('FEAT-001 anonymous sign-in', () => {
   // Supabase gates this behind its own flag, defaulting to off, and `enable_signup` is checked
   // first — so allowing sign-ups does not by itself allow anonymous ones.
   test('it is off unless enable_anonymous_sign_ins says otherwise', async () => {
      const { app }: { app: LiteApp } = await newRawApp({
         auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000' },
      })
      const r = await anon(app)
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'anonymous_provider_disabled')
   })

   test('enable_signup=false refuses it as a sign-up, whatever the flag says', async () => {
      const { app }: { app: LiteApp } = await newAnonApp({ enable_signup: false })
      const r = await anon(app)
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'signup_disabled')
   })

   test('a signup with no credentials returns a session', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const r = await anon(app)

      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 120))
      assert.ok(r.body.access_token)
      assert.ok(r.body.refresh_token)
      assert.equal(r.body.token_type, 'bearer')
      assert.equal(typeof r.body.expires_in, 'number')
   })

   // An anonymous user has no identity, so upstream records no provider for one — `app_metadata` is
   // empty and `identities` is empty, rather than naming a provider called "anonymous".
   test('the user is a credential-less user, not a user of some anonymous provider', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const user = (await anon(app)).body.user

      assert.equal(user.is_anonymous, true)
      assert.equal(user.email, '')
      assert.equal(user.role, 'authenticated')
      assert.equal(user.aud, 'authenticated')
      assert.deepEqual(user.app_metadata, {})
      assert.deepEqual(user.user_metadata, {})
      assert.deepEqual(user.identities, [])
      assert.ok(user.created_at)
      assert.ok(user.updated_at)
      assert.ok(user.last_sign_in_at)
   })

   // The point of the feature: Supabase's documented check is on the claim, so one that lived only
   // on the user row would be no use to a policy.
   test('the access token carries is_anonymous', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const session = (await anon(app)).body
      const claims = claimsOf(session.access_token)

      assert.equal(claims.is_anonymous, true)
      assert.equal(claims.role, 'authenticated')
      assert.equal(claims.aud, 'authenticated')
      assert.equal(claims.sub, session.user.id)
   })

   // On every token, not only anonymous ones. Upstream's claim has no `omitempty`, and the
   // documented policy `(auth.jwt() ->> 'is_anonymous')::boolean is false` reads an absent claim as
   // NULL — so a policy meant to admit ordinary users would admit nobody.
   test('an ordinary session carries is_anonymous=false', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const session = (await post(app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })).body
      assert.equal(claimsOf(session.access_token).is_anonymous, false)

      const refreshed = await post(app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: session.refresh_token,
      })
      assert.equal(claimsOf(refreshed.body.access_token).is_anonymous, false)
   })

   // GoTrue asks whether anonymous sign-in is enabled BEFORE it asks whether sign-ups are, so an
   // instance with both switched off answers with the specific reason rather than the general one.
   test('with both gates closed the anonymous one answers first', async () => {
      const { app }: { app: LiteApp } = await newRawApp({
         auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000', enable_signup: false },
      })
      const r = await anon(app)
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'anonymous_provider_disabled')
   })

   /**
    * The documented way out of an anonymous account: updateUser with an address, then verify it.
    *
    * Almost none of this is the patch's. `completeVerifyOtp` predates anonymous users, but already
    * applies the pending address, creates and verifies the email identity, rebuilds the provider
    * metadata and reloads both before minting the session:
    *
    *   the library already does      claims the address, creates the identity, marks it verified,
    *                                 rebuilds app_metadata.providers, reloads both
    *   FEAT-001 adds                 is_anonymous false, and the claim on the token that follows
    *
    * The library's half is asserted too, deliberately: it is why the patch does not repeat it, so if
    * it ever stops this test says so rather than a user finding a converted account with no identity.
    *
    * Verified through POST rather than the emailed link, which answers 303 with its tokens in a
    * fragment and so has no body to assert against. Same token, same path.
    */
   test('claiming an address makes an anonymous user permanent', async () => {
      const driver = new lite.InMemoryEmailDriver({})
      const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newRawApp({
         auth: {
            enabled: true,
            jwt_secret: JWT_SECRET,
            site_url: 'http://localhost:3000',
            enable_anonymous_sign_ins: true,
         },
         options: { drivers: { email: driver } },
      })

      const session = (await anon(app)).body
      const auth = { Authorization: `Bearer ${session.access_token}` }
      assert.equal(claimsOf(session.access_token).is_anonymous, true)

      assert.equal((await req(app, 'PUT', '/auth/v1/user', { email: 'claimed@b.co' }, auth)).status, 200)

      const messages = [...(driver.messages.values() as Iterable<unknown>)].flat() as { text?: string }[]
      const code = messages[messages.length - 1]?.text?.match(/(?<!\d)(\d{6})(?!\d)/)?.[1]
      assert.match(code ?? '', /^\d{6}$/, 'no verification code was sent')

      const verified = await post(app, '/auth/v1/verify', {
         type: 'email_change',
         token: code,
         email: 'claimed@b.co',
      })
      assert.equal(verified.status, 200, JSON.stringify(verified.body).slice(0, 140))

      const [row] = ((await connection.exec('SELECT id, email, is_anonymous FROM "auth.users"')).rows ?? []) as {
         id: string
         email: string
         is_anonymous: number
      }[]
      assert.equal(row.id, session.user.id, 'the same user, not a new one')
      assert.equal(row.email, 'claimed@b.co')
      assert.equal(row.is_anonymous, 0, 'still flagged anonymous after claiming an address')

      // What FEAT-001 contributes, on the response the caller actually receives.
      assert.equal(verified.body.user.id, session.user.id)
      assert.equal(verified.body.user.is_anonymous, false)
      assert.equal(claimsOf(verified.body.access_token).is_anonymous, false)

      // The library's half, asserted because it is why the patch does not repeat it: the identity is
      // created, already verified, and present in this response rather than on some later read.
      assert.equal(verified.body.user.identities.length, 1)
      const [identity] = verified.body.user.identities
      assert.equal(identity.provider, 'email')
      assert.equal(identity.identity_data.email, 'claimed@b.co')
      assert.equal(identity.identity_data.email_verified, true)

      // And the provider metadata, which an anonymous user starts without.
      assert.deepEqual(session.user.app_metadata, {}, 'an anonymous user has no provider')
      assert.equal(verified.body.user.app_metadata.provider, 'email')
      assert.deepEqual(verified.body.user.app_metadata.providers, ['email'])

      // The next token says so too — the claim follows the row, not the moment of sign-in.
      const refreshed = await post(app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: session.refresh_token,
      })
      assert.equal(refreshed.body.user.is_anonymous, false)
      assert.equal(claimsOf(refreshed.body.access_token).is_anonymous, false)
   })

   // The user is permanent and the session refreshes like any other. A right creation path with a
   // wrong reload path shows up here: the row comes back from SQLite as 0/1, and losing that would
   // flip the user to non-anonymous on the second token.
   test('the session refreshes, and the user is still anonymous', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const session = (await anon(app)).body

      const refreshed = await post(app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: session.refresh_token,
      })
      assert.equal(refreshed.status, 200)
      assert.equal(refreshed.body.user.id, session.user.id)
      assert.equal(refreshed.body.user.is_anonymous, true)
      assert.equal(claimsOf(refreshed.body.access_token).is_anonymous, true)
   })

   test('the user reads back through GET /user', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const session = (await anon(app)).body
      const me = await get(app, '/auth/v1/user', { Authorization: `Bearer ${session.access_token}` })

      assert.equal(me.status, 200)
      assert.equal(me.body.id, session.user.id)
      assert.equal(me.body.is_anonymous, true)
   })

   // Signing out is the one-way door: nothing was ever issued that could sign this user back in.
   test('signing out ends the session', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const session = (await anon(app)).body
      const auth = { Authorization: `Bearer ${session.access_token}` }

      assert.equal((await post(app, '/auth/v1/logout', {}, auth)).status, 204)
      const refused = await post(app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: session.refresh_token,
      })
      assert.equal(refused.status, 400)
   })

   // What it is for: the session has to work like any other, or anonymous sign-in is useless.
   test('the session works against the Data API', async () => {
      const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newAnonApp()
      await (
         await connection.createMigrator(
            [
               'CREATE TABLE carts (id int primary key, owner uuid, item text);',
               'ALTER TABLE carts ENABLE ROW LEVEL SECURITY;',
               'CREATE POLICY own ON carts FOR ALL USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());',
            ].join('\n'),
         )
      ).migrate()

      const session = (await anon(app)).body
      const auth = { Authorization: `Bearer ${session.access_token}` }

      assert.equal(
         (await post(app, '/rest/v1/carts', { id: 1, owner: session.user.id, item: 'ladle' }, auth)).status,
         201,
      )
      assert.deepEqual((await get(app, '/rest/v1/carts?select=item', auth)).body, [{ item: 'ladle' }])
      assert.deepEqual((await get(app, '/rest/v1/carts?select=item')).body, [])
   })

   test('metadata passed on sign-in is kept', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const user = (await anon(app, { cart: 'before sign-in' })).body.user
      assert.equal(user.user_metadata.cart, 'before sign-in')
   })

   /**
    * Both halves of re-signing a token, asserted on an ordinary user: the claim is stamped on every
    * token, so anything the re-signing gets wrong is wrong for everybody.
    *
    * `atob` returns one character per byte, so the UTF-8 those bytes spell has to be decoded before
    * the claims are parsed — otherwise the address is re-signed mangled, with a valid signature over
    * the wrong data, while the user object still reads correctly.
    */
   test('a non-ASCII address survives being re-signed', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const address = 'міхайло@example.test'

      const session = await post(app, '/auth/v1/signup', { email: address, password: 'password123' })
      assert.equal(session.body.user.email, address)
      assert.equal(claimsOf(session.body.access_token).email, address)

      const refreshed = await post(app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: session.body.refresh_token,
      })
      assert.equal(claimsOf(refreshed.body.access_token).email, address)
   })

   /**
    * The library hangs `session_id` and `user_id` off the session non-enumerably and reads them back
    * for these headers, so replacing the token by spreading the session drops both — invisibly,
    * because signing in still works.
    */
   test('the session headers survive being re-signed', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const session = await post(app, '/auth/v1/signup', { email: 'headers@b.co', password: 'password123' })

      assert.match(String(session.headers.get('sb-auth-session-id')), /^[0-9a-f-]{36}$/)
      assert.match(String(session.headers.get('sb-auth-user-id')), /^[0-9a-f-]{36}$/)

      const refreshed = await post(app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: session.body.refresh_token,
      })
      assert.equal(refreshed.headers.get('sb-auth-session-id'), session.headers.get('sb-auth-session-id'))
      assert.equal(refreshed.headers.get('sb-auth-user-id'), session.headers.get('sb-auth-user-id'))
   })

   // Guard: an ordinary sign-up must not notice any of this.
   test('an ordinary signup is unchanged', async () => {
      const { app }: { app: LiteApp } = await newAnonApp()
      const r = await post(app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })
      assert.equal(r.status, 200)
      assert.equal(r.body.user.is_anonymous, false)
      assert.equal(r.body.user.email, 'a@b.co')
      assert.deepEqual(r.body.user.app_metadata, { provider: 'email', providers: ['email'] })
   })
})
