// Asserts behaviour the published build does not have: /auth/v1/factors is not mounted there.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { newApp, newRawApp, get, post, JWT_SECRET, type LiteApp, type LiteConnection } from '../../test/harness.ts'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

// Computed here from RFC 6238 on node:crypto, independently of the patch. Two implementations
// agreeing is what makes it real TOTP rather than something six digits long.
function totp(secret: string, step = Math.floor(Date.now() / 1000 / 30)): string {
   let bits = ''
   for (const char of secret) bits += BASE32.indexOf(char).toString(2).padStart(5, '0')
   const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)))

   const counter = Buffer.alloc(8)
   counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0)
   counter.writeUInt32BE(step >>> 0, 4)

   const mac = createHmac('sha1', key).update(counter).digest()
   const offset = mac[mac.length - 1] & 0x0f
   const binary = mac.readUInt32BE(offset) & 0x7fffffff
   return String(binary % 1000000).padStart(6, '0')
}

const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

/**
 * A code this secret does not accept, right now. A fixed `'000000'` would not do: with the skew
 * allowance three of the million codes are live at any instant, so it fails one run in three hundred
 * thousand — rare enough to be dismissed as flake.
 */
function wrongCode(secret: string): string {
   const step = Math.floor(Date.now() / 1000 / 30)
   const live = new Set([totp(secret, step - 1), totp(secret, step), totp(secret, step + 1)])
   for (let candidate = 0; ; candidate++) {
      const code = String(candidate).padStart(6, '0')
      if (!live.has(code)) return code
   }
}

describe('FEAT-003 TOTP second factor', () => {
   // A session each, not one shared: a successful verify ends the user's other sessions, so a shared
   // bearer would stop working at the first verify. That is the feature, not a fixture problem.
   interface Enrolled {
      app: LiteApp
      connection: LiteConnection
      auth: Record<string, string>
   }

   async function newUser(config?: Record<string, unknown>): Promise<Enrolled> {
      const { app, connection } = config
         ? await newRawApp({
              auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000', ...config },
           })
         : await newApp({ seed: false })
      const session = (await post(app, '/auth/v1/signup', { email: 'mfa@b.co', password: 'password123' })).body
      return { app, connection, auth: { Authorization: `Bearer ${session.access_token}` } }
   }

   const enroll = async (u: Enrolled, body: Record<string, unknown> = {}) =>
      (await post(u.app, '/auth/v1/factors', { factor_type: 'totp', friendly_name: 'Phone', ...body }, u.auth)).body
   const challenge = async (u: Enrolled, id: string) =>
      (await post(u.app, `/auth/v1/factors/${id}/challenge`, {}, u.auth)).body
   const verify = (u: Enrolled, id: string, body: Record<string, unknown>) =>
      post(u.app, `/auth/v1/factors/${id}/verify`, body, u.auth)

   test('enrolling returns a secret and an otpauth URI', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      assert.ok(factor.id)
      assert.equal(factor.type, 'totp')
      assert.match(factor.totp.secret, /^[A-Z2-7]{32}$/)
      assert.match(factor.totp.uri, /^otpauth:\/\/totp\/.*secret=[A-Z2-7]{32}/)
   })

   // The issuer is what an authenticator app shows as the provider, and the label is the identity
   // within it. The friendly name names the factor, so it is neither.
   test('the issuer reaches the URI, and the label is the account', async () => {
      const u = await newUser()
      const factor = await enroll(u, { issuer: 'Acme Corp', friendly_name: 'Work phone' })
      const uri = decodeURIComponent(factor.totp.uri)
      assert.match(uri, /^otpauth:\/\/totp\/Acme Corp:mfa@b\.co\?/)
      assert.match(uri, /issuer=Acme Corp/)
      assert.equal(factor.friendly_name, 'Work phone')
   })

   test('a challenge can be raised for the factor', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const raised = await challenge(u, factor.id)
      assert.ok(raised.id)
      assert.equal(raised.factor_id, factor.id)
      assert.ok(raised.expires_at > Math.floor(Date.now() / 1000))
   })

   test('the right code verifies the factor and returns a session', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const raised = await challenge(u, factor.id)
      const r = await verify(u, factor.id, { challenge_id: raised.id, code: totp(factor.totp.secret) })

      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 140))
      assert.ok(r.body.access_token)
      assert.ok(r.body.refresh_token)
   })

   test('a wrong code is refused', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const raised = await challenge(u, factor.id)
      const r = await verify(u, factor.id, { challenge_id: raised.id, code: wrongCode(factor.totp.secret) })
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'mfa_verification_failed')
   })

   // Time is frozen: computing the previous step and then verifying reads the clock twice, and a run
   // crossing a 30-second boundary between them offers a code two steps old, correctly refused.
   test('a code from a neighbouring time step is accepted', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const raised = await challenge(u, factor.id)

      const now = Date.now
      const frozen = now()
      Date.now = () => frozen
      try {
         const previous = totp(factor.totp.secret, Math.floor(frozen / 1000 / 30) - 1)
         assert.equal((await verify(u, factor.id, { challenge_id: raised.id, code: previous })).status, 200)
      } finally {
         Date.now = now
      }
   })

   test('a challenge cannot be replayed', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const raised = await challenge(u, factor.id)
      const code = totp(factor.totp.secret)

      assert.equal((await verify(u, factor.id, { challenge_id: raised.id, code })).status, 200)
      const again = await verify(u, factor.id, { challenge_id: raised.id, code })
      assert.equal(again.status, 404)
      assert.equal(again.body.error_code, 'mfa_challenge_not_found')
   })

   // Without a cap the challenge stands for its whole 300 s under unlimited guesses.
   test('a challenge dies after too many wrong codes', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const raised = await challenge(u, factor.id)
      const wrong = { challenge_id: raised.id, code: wrongCode(factor.totp.secret) }

      for (let attempt = 0; attempt < 5; attempt++) {
         assert.equal((await verify(u, factor.id, wrong)).status, 422)
      }

      const right = await verify(u, factor.id, { challenge_id: raised.id, code: totp(factor.totp.secret) })
      assert.equal(right.status, 404)
      assert.equal(right.body.error_code, 'mfa_challenge_not_found')

      const again = await challenge(u, factor.id)
      assert.equal((await verify(u, factor.id, { challenge_id: again.id, code: totp(factor.totp.secret) })).status, 200)
   })

   test('a non-totp factor is refused by name', async () => {
      const u = await newUser()
      const r = await post(u.app, '/auth/v1/factors', { factor_type: 'phone' }, u.auth)
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'validation_failed')
   })

   // supabase-js has no GET /factors: mfa.listFactors() reads user.factors from getUser().
   test('factors are exposed on the user, where supabase-js reads them', async () => {
      const fresh: { app: LiteApp } = await newApp({ seed: false })
      const session = (await post(fresh.app, '/auth/v1/signup', { email: 'lister@b.co', password: 'password123' })).body
      const bearer = { Authorization: `Bearer ${session.access_token}` }

      // Absent rather than empty, as upstream leaves it for a user who has never enrolled.
      const before = await get(fresh.app, '/auth/v1/user', bearer)
      assert.equal(before.body.factors, undefined)

      const factor = (
         await post(fresh.app, '/auth/v1/factors', { factor_type: 'totp', friendly_name: 'Phone' }, bearer)
      ).body
      const after = await get(fresh.app, '/auth/v1/user', bearer)

      assert.equal(after.body.factors.length, 1)
      assert.equal(after.body.factors[0].id, factor.id)
      assert.equal(after.body.factors[0].friendly_name, 'Phone')
      assert.equal(after.body.factors[0].factor_type, 'totp')
      assert.equal(after.body.factors[0].status, 'unverified')

      // And a verified one reads back as verified, which is how listFactors() splits them.
      const raised = (await post(fresh.app, `/auth/v1/factors/${factor.id}/challenge`, {}, bearer)).body
      await post(
         fresh.app,
         `/auth/v1/factors/${factor.id}/verify`,
         { challenge_id: raised.id, code: totp(factor.totp.secret) },
         bearer,
      )
      const verified = await get(fresh.app, '/auth/v1/user', bearer)
      assert.equal(verified.body.factors[0].status, 'verified')
   })

   test('factors are scoped to their owner', async () => {
      const u = await newUser()
      const mine = await enroll(u)
      const other = (await post(u.app, '/auth/v1/signup', { email: 'other@b.co', password: 'password123' })).body
      const theirs = { Authorization: `Bearer ${other.access_token}` }

      // The owner sees it; the other user does not, and cannot raise a challenge against it either.
      assert.equal((await get(u.app, '/auth/v1/user', u.auth)).body.factors.length, 1)
      assert.equal((await get(u.app, '/auth/v1/user', theirs)).body.factors, undefined)
      assert.equal((await post(u.app, `/auth/v1/factors/${mine.id}/challenge`, {}, theirs)).status, 404)
   })

   // The point of MFA. getAuthenticatorAssuranceLevel() in supabase-js reads `aal` out of the JWT.
   test('verifying raises the session to aal2', async () => {
      const fresh: { app: LiteApp } = await newApp({ seed: false })
      const session = (await post(fresh.app, '/auth/v1/signup', { email: 'aal@b.co', password: 'password123' })).body
      const bearer = { Authorization: `Bearer ${session.access_token}` }
      assert.equal(claimsOf(session.access_token).aal, 'aal1')

      const factor = (await post(fresh.app, '/auth/v1/factors', { factor_type: 'totp' }, bearer)).body
      const raised = (await post(fresh.app, `/auth/v1/factors/${factor.id}/challenge`, {}, bearer)).body
      const elevated = await post(
         fresh.app,
         `/auth/v1/factors/${factor.id}/verify`,
         { challenge_id: raised.id, code: totp(factor.totp.secret) },
         bearer,
      )

      const claims = claimsOf(elevated.body.access_token)
      assert.equal(claims.aal, 'aal2')

      // `amr` is the session's authentication history, handed back as currentAuthenticationMethods.
      // Verifying adds to it: replacing the list would tell a caller they never entered a password.
      // Most recent first, as Supabase documents — a policy reading amr[0] asks what happened last.
      assert.deepEqual(
         claims.amr.map((entry: { method: string }) => entry.method),
         ['totp', 'password'],
      )
      assert.ok(claims.amr.every((entry: { timestamp: number }) => typeof entry.timestamp === 'number'))
   })

   // Intentionally on every session, not only MFA ones: without it getAuthenticatorAssuranceLevel()
   // reports the level as unknown rather than aal1.
   test('an ordinary session carries aal1 and its own method', async () => {
      const u = await newUser()
      const claims = claimsOf(
         (
            await post(u.app, '/auth/v1/token?grant_type=password', {
               email: 'mfa@b.co',
               password: 'password123',
            })
         ).body.access_token,
      )

      assert.equal(claims.aal, 'aal1')
      assert.deepEqual(
         claims.amr.map((entry: { method: string }) => entry.method),
         ['password'],
      )
   })

   // Upstream carries a unique index on (user_id, friendly_name) and a public error for hitting it —
   // two factors a caller cannot tell apart are worse than a refusal.
   test('a second factor cannot reuse a friendly name', async () => {
      const u = await newUser()
      await enroll(u, { friendly_name: 'Work phone' })

      const again = await post(u.app, '/auth/v1/factors', { factor_type: 'totp', friendly_name: 'Work phone' }, u.auth)
      assert.equal(again.status, 422)
      assert.equal(again.body.error_code, 'mfa_factor_name_conflict')

      // A different name is fine, and so are two blank ones: a blank name indexes as NULL, and NULL
      // does not collide. That is upstream's `WHERE trim(friendly_name) <> ''` without a partial
      // index, so this does not quietly depend on FIX-001.
      for (const friendly_name of ['Tablet', '']) {
         const r = await post(u.app, '/auth/v1/factors', { factor_type: 'totp', friendly_name }, u.auth)
         assert.equal(r.status, 200, `${JSON.stringify(friendly_name)}: ${JSON.stringify(r.body).slice(0, 80)}`)
      }

      // And stored as written: the rule lives in the index expression, not in the column.
      const names = (await get(u.app, '/auth/v1/user', u.auth)).body.factors.map(
         (f: { friendly_name: string }) => f.friendly_name,
      )
      assert.deepEqual(names.sort(), ['', 'Tablet', 'Work phone'])
   })

   // Verifying twice on one session does not make it twice as authenticated. Without the constraint
   // the claim grows: ['password', 'totp', 'totp'].
   test('a second verification does not repeat the method', async () => {
      const u = await newUser()
      const factor = await enroll(u)

      let claims
      for (let round = 0; round < 2; round++) {
         const raised = await challenge(u, factor.id)
         const r = await verify(u, factor.id, { challenge_id: raised.id, code: totp(factor.totp.secret) })
         assert.equal(r.status, 200)
         claims = claimsOf(r.body.access_token)
      }

      // Uniqueness, ordering and timestamps in one: the method appears once, is the most recent thing
      // about the session, and happened after the password.
      assert.deepEqual(
         claims.amr.map((entry: { method: string }) => entry.method),
         ['totp', 'password'],
      )
      assert.ok(claims.amr[0].timestamp >= claims.amr[1].timestamp)
   })

   // supabase-js types a Factor with both timestamps, and the status moves on verification.
   test('a factor carries both timestamps, and updated_at moves when it is verified', async () => {
      const u = await newUser()
      const factor = await enroll(u)

      const before = (await get(u.app, '/auth/v1/user', u.auth)).body.factors[0]
      assert.ok(before.created_at)
      assert.ok(before.updated_at)

      const raised = await challenge(u, factor.id)
      await verify(u, factor.id, { challenge_id: raised.id, code: totp(factor.totp.secret) })

      const after = (await get(u.app, '/auth/v1/user', u.auth)).body.factors[0]
      assert.equal(after.status, 'verified')
      assert.ok(Date.parse(after.updated_at) >= Date.parse(before.updated_at))
   })

   // The elevation is a fact about the session, not one token, so it is read back from the row
   // rather than carried in the request.
   test('aal2 survives a refresh', async () => {
      const fresh: { app: LiteApp } = await newApp({ seed: false })
      const session = (await post(fresh.app, '/auth/v1/signup', { email: 'refresh@b.co', password: 'password123' }))
         .body
      const bearer = { Authorization: `Bearer ${session.access_token}` }

      const factor = (await post(fresh.app, '/auth/v1/factors', { factor_type: 'totp' }, bearer)).body
      const raised = (await post(fresh.app, `/auth/v1/factors/${factor.id}/challenge`, {}, bearer)).body
      const elevated = (
         await post(
            fresh.app,
            `/auth/v1/factors/${factor.id}/verify`,
            { challenge_id: raised.id, code: totp(factor.totp.secret) },
            bearer,
         )
      ).body

      const refreshed = await post(fresh.app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: elevated.refresh_token,
      })
      assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body).slice(0, 140))
      assert.equal(claimsOf(refreshed.body.access_token).aal, 'aal2')
   })

   // Sessions established at aal1 must not outlive the elevation, or an older token walks around the
   // second factor.
   test('verifying ends the other sessions of that user', async () => {
      const fresh: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      const first = (await post(fresh.app, '/auth/v1/signup', { email: 'many@b.co', password: 'password123' })).body
      const second = (
         await post(fresh.app, '/auth/v1/token?grant_type=password', { email: 'many@b.co', password: 'password123' })
      ).body
      assert.equal(((await fresh.connection.exec('SELECT id FROM "auth.sessions"')).rows ?? []).length, 2)

      const bearer = { Authorization: `Bearer ${second.access_token}` }
      const factor = (await post(fresh.app, '/auth/v1/factors', { factor_type: 'totp' }, bearer)).body
      const raised = (await post(fresh.app, `/auth/v1/factors/${factor.id}/challenge`, {}, bearer)).body
      await post(
         fresh.app,
         `/auth/v1/factors/${factor.id}/verify`,
         { challenge_id: raised.id, code: totp(factor.totp.secret) },
         bearer,
      )

      assert.equal(((await fresh.connection.exec('SELECT id FROM "auth.sessions"')).rows ?? []).length, 1)
      const stale = await post(fresh.app, '/auth/v1/token?grant_type=refresh_token', {
         refresh_token: first.refresh_token,
      })
      assert.notEqual(stale.status, 200)
   })

   // Upstream guards every one of these routes: there is no first factor for a second to strengthen.
   test('an anonymous user cannot enrol a factor', async () => {
      const anon: { app: LiteApp } = await newRawApp({
         auth: {
            enabled: true,
            jwt_secret: JWT_SECRET,
            site_url: 'http://localhost:3000',
            enable_anonymous_sign_ins: true,
         },
      })
      const session = (await post(anon.app, '/auth/v1/signup', {})).body
      if (!session.access_token) return // the anonymous sign-in patch is not applied

      const r = await post(
         anon.app,
         '/auth/v1/factors',
         { factor_type: 'totp' },
         { Authorization: `Bearer ${session.access_token}` },
      )
      assert.equal(r.status, 403)
      assert.equal(r.body.error_code, 'no_authorization')
   })

   // Two patches wrap the same two token-minting methods, and both re-sign. Each reads the claims
   // back out of the token and spreads them, so they survive in either order.
   test('a permanent user is stamped by both patches at once', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const raised = await challenge(u, factor.id)
      const verified = await verify(u, factor.id, { challenge_id: raised.id, code: totp(factor.totp.secret) })

      const claims = claimsOf(verified.body.access_token)
      assert.equal(claims.aal, 'aal2')
      assert.deepEqual(
         claims.amr.map((entry: { method: string }) => entry.method),
         ['totp', 'password'],
      )
      // FEAT-001's claim on a session FEAT-003 elevated: neither wrapper erased the other's work.
      assert.equal(claims.is_anonymous, false)
   })

   test('the secret is stored, and this build stores it in the clear', async () => {
      const u = await newUser()
      const factor = await enroll(u)
      const [row] = ((await u.connection.exec('SELECT secret FROM "auth.mfa_factors" WHERE id = ?', factor.id)).rows ??
         []) as { secret: string }[]
      // Recorded rather than hidden: GoTrue can encrypt MFA secrets at rest and this does not.
      assert.equal(row.secret, factor.totp.secret)
   })
})
