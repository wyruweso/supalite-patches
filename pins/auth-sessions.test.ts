// Sessions, refresh tokens and logout.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, newAppWithMailbox, get, post, type LiteApp, type Mailbox } from '../test/harness.ts'

const PASSWORD = 'password123'
const signUp = async (app: LiteApp, email: string) =>
   (await post(app, '/auth/v1/signup', { email, password: PASSWORD })).body
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

describe('logout', () => {
   let app: LiteApp
   beforeEach(async () => ({ app } = await newApp()))

   for (const scope of ['local', 'global', 'others']) {
      test(`scope=${scope} succeeds with 204`, async () => {
         const session = await signUp(app, `${scope}@b.co`)
         const r = await post(app, `/auth/v1/logout?scope=${scope}`, undefined, bearer(session.access_token))
         assert.equal(r.status, 204)
      })
   }

   test('no scope defaults to local and succeeds', async () => {
      const session = await signUp(app, 'default@b.co')
      const r = await post(app, '/auth/v1/logout', undefined, bearer(session.access_token))
      assert.equal(r.status, 204)
   })

   test('an unsupported scope is rejected', async () => {
      const session = await signUp(app, 'bogus@b.co')
      const r = await post(app, '/auth/v1/logout?scope=bogus', undefined, bearer(session.access_token))
      assert.equal(r.status, 400)
      assert.equal(r.body.error_code, 'validation_failed')
      assert.match(r.body.msg, /logout scope/i)
   })

   test('the session is unusable afterwards', async () => {
      const session = await signUp(app, 'gone@b.co')
      await post(app, '/auth/v1/logout', undefined, bearer(session.access_token))
      const again = await post(app, '/auth/v1/logout', undefined, bearer(session.access_token))
      assert.equal(again.status, 403)
      assert.equal(again.body.error_code, 'session_not_found')
   })

   test('without a token it is rejected', async () => {
      const r = await post(app, '/auth/v1/logout')
      assert.ok(r.status >= 400)
   })
})

describe('refresh tokens', () => {
   let app: LiteApp
   beforeEach(async () => ({ app } = await newApp()))

   test('a valid refresh token issues a new session', async () => {
      const session = await signUp(app, 'r1@b.co')
      const r = await post(app, '/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      assert.equal(r.status, 200)
      assert.ok(r.body.access_token)
      assert.ok(r.body.refresh_token)
      assert.equal(r.body.user.email, 'r1@b.co')
   })

   test('reusing a refresh token still succeeds', async () => {
      const session = await signUp(app, 'r2@b.co')
      await post(app, '/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      const again = await post(app, '/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      assert.equal(again.status, 200)
      assert.ok(again.body.access_token)
   })

   test('an unknown refresh token is rejected', async () => {
      const r = await post(app, '/auth/v1/token?grant_type=refresh_token', { refresh_token: 'not-a-token' })
      assert.equal(r.status, 400)
      assert.equal(r.body.error_code, 'validation_failed')
   })

   test('a missing refresh token is rejected', async () => {
      const r = await post(app, '/auth/v1/token?grant_type=refresh_token', {})
      assert.ok(r.status >= 400)
   })

   test('a refresh token is useless after logout', async () => {
      const session = await signUp(app, 'r3@b.co')
      await post(app, '/auth/v1/logout?scope=global', undefined, bearer(session.access_token))
      const r = await post(app, '/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      assert.ok(r.status >= 400)
   })
})

describe('otp and recovery round trips', () => {
   let app: LiteApp
   let mail: Mailbox

   beforeEach(async () => ({ app, mail } = await newAppWithMailbox()))

   test('an otp request delivers a six-digit code', async () => {
      await signUp(app, 'otp@b.co')
      const r = await post(app, '/auth/v1/otp', { email: 'otp@b.co' })
      assert.equal(r.status, 200)
      assert.ok(mail.to('otp@b.co').length >= 1)
      assert.match(mail.code('otp@b.co') ?? '', /^\d{6}$/)
   })

   test('verifying the delivered code returns a session', async () => {
      await signUp(app, 'otp2@b.co')
      await post(app, '/auth/v1/otp', { email: 'otp2@b.co' })
      const code = mail.code('otp2@b.co')
      const r = await post(app, '/auth/v1/verify', { type: 'magiclink', token: code, email: 'otp2@b.co' })
      assert.equal(r.status, 200)
      assert.ok(r.body.access_token)
      assert.equal(r.body.user.email, 'otp2@b.co')
   })

   test('the same code cannot be used twice', async () => {
      await signUp(app, 'otp3@b.co')
      await post(app, '/auth/v1/otp', { email: 'otp3@b.co' })
      const code = mail.code('otp3@b.co')
      await post(app, '/auth/v1/verify', { type: 'magiclink', token: code, email: 'otp3@b.co' })
      const again = await post(app, '/auth/v1/verify', { type: 'magiclink', token: code, email: 'otp3@b.co' })
      assert.ok(again.status >= 400)
   })

   test('a wrong code is rejected', async () => {
      await signUp(app, 'otp4@b.co')
      await post(app, '/auth/v1/otp', { email: 'otp4@b.co' })
      const r = await post(app, '/auth/v1/verify', { type: 'magiclink', token: '000000', email: 'otp4@b.co' })
      assert.ok(r.status >= 400)
   })

   test('recovery delivers a link carrying a token', async () => {
      await signUp(app, 'rec@b.co')
      const r = await post(app, '/auth/v1/recover', { email: 'rec@b.co' })
      assert.equal(r.status, 200)
      assert.ok(mail.token('rec@b.co'), 'no verify token in the recovery email')
   })

   test('the recovery link token verifies via GET', async () => {
      await signUp(app, 'rec2@b.co')
      await post(app, '/auth/v1/recover', { email: 'rec2@b.co' })
      const token = mail.token('rec2@b.co')
      const r = await get(app, `/auth/v1/verify?token=${token}&type=recovery&redirect_to=http%3A%2F%2Flocalhost%3A3000`)
      assert.ok(r.status === 302 || r.status === 303 || r.status === 200)
   })
})

describe('oauth', () => {
   let app: LiteApp
   beforeEach(async () => ({ app } = await newApp()))

   test('an unconfigured provider is rejected', async () => {
      const r = await get(app, '/auth/v1/authorize?provider=github')
      assert.ok(r.status >= 400)
   })

   test('an unknown provider is rejected', async () => {
      const r = await get(app, '/auth/v1/authorize?provider=nope')
      assert.ok(r.status >= 400)
   })

   test('a callback without state reports bad_oauth_callback', async () => {
      const r = await get(app, '/auth/v1/callback?code=abc')
      assert.equal(r.status, 303)
      assert.equal(r.body.error_code, 'bad_oauth_callback')
   })

   test('a callback with an unknown state reports bad_oauth_state', async () => {
      const r = await get(app, '/auth/v1/callback?state=nope&code=abc')
      assert.equal(r.status, 303)
      assert.equal(r.body.error_code, 'bad_oauth_state')
   })

   test('a pkce exchange with an unknown code is rejected', async () => {
      const r = await post(app, '/auth/v1/token?grant_type=pkce', { auth_code: 'nope', code_verifier: 'x'.repeat(43) })
      assert.ok(r.status >= 400)
   })
})
