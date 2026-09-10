// Sign-up, sign-in, the token endpoint and the shape of the access token.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post } from '../test/harness.ts'
import type { LiteApp } from '../test/harness.ts'

let app: LiteApp
beforeEach(async () => ({ app } = await newApp()))

describe('metadata', () => {
   test('settings reports the provider surface', async () => {
      const r = await get(app, '/auth/v1/settings')
      assert.equal(r.status, 200)
      assert.equal(typeof r.body.external, 'object')
   })

   test('health responds', async () => {
      const r = await get(app, '/auth/v1/health')
      assert.equal(r.status, 200)
   })
})

describe('signup and sign-in', () => {
   test('signup returns a session and user', async () => {
      const r = await post(app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })
      assert.equal(r.status, 200)
      assert.ok(r.body.access_token)
      assert.equal(r.body.user.email, 'a@b.co')
      assert.equal(r.body.user.role, 'authenticated')
   })

   test('weak password is rejected', async () => {
      const r = await post(app, '/auth/v1/signup', { email: 'weak@b.co', password: '1' })
      assert.ok(r.status >= 400)
   })

   test('malformed email is rejected', async () => {
      const r = await post(app, '/auth/v1/signup', { email: 'nope', password: 'password123' })
      assert.ok(r.status >= 400)
   })

   test('password grant issues a token', async () => {
      await post(app, '/auth/v1/signup', { email: 'tok@b.co', password: 'password123' })
      const r = await post(app, '/auth/v1/token?grant_type=password', { email: 'tok@b.co', password: 'password123' })
      assert.equal(r.status, 200)
      assert.ok(r.body.access_token)
   })

   test('wrong password is invalid_credentials', async () => {
      await post(app, '/auth/v1/signup', { email: 'bad@b.co', password: 'password123' })
      const r = await post(app, '/auth/v1/token?grant_type=password', { email: 'bad@b.co', password: 'nope' })
      assert.equal(r.status, 400)
      assert.equal(r.body.error_code, 'invalid_credentials')
   })

   test('unknown grant_type is rejected', async () => {
      const r = await post(app, '/auth/v1/token?grant_type=bogus', {})
      assert.ok(r.status >= 400)
   })
})

describe('session-bearing endpoints', () => {
   test('user without a token is unauthorized', async () => {
      const r = await get(app, '/auth/v1/user')
      assert.ok(r.status >= 400)
   })

   test('user with a token returns the profile', async () => {
      const s = await post(app, '/auth/v1/signup', { email: 'me@b.co', password: 'password123' })
      const r = await get(app, '/auth/v1/user', { Authorization: 'Bearer ' + s.body.access_token })
      assert.equal(r.status, 200)
      assert.equal(r.body.email, 'me@b.co')
   })
})

describe('otp and recovery', () => {
   test('recover accepts a known address', async () => {
      await post(app, '/auth/v1/signup', { email: 'rec@b.co', password: 'password123' })
      const r = await post(app, '/auth/v1/recover', { email: 'rec@b.co' })
      assert.ok(r.status < 500)
   })

   test('otp accepts a known address', async () => {
      await post(app, '/auth/v1/signup', { email: 'otp@b.co', password: 'password123' })
      const r = await post(app, '/auth/v1/otp', { email: 'otp@b.co' })
      assert.ok(r.status < 500)
   })
})

describe('what the access token carries', () => {
   test('the token carries no app_metadata or user_metadata, so custom claims cannot reach a policy', async () => {
      const app: LiteApp = (await newApp({ seed: false })).app
      const session = (
         await post(app, '/auth/v1/signup', { email: 'claims@b.co', password: 'password123', data: { team: 'red' } })
      ).body

      assert.equal(session.user.user_metadata.team, 'red')

      const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString())
      // Check the missing metadata without excluding claims added by independent features.
      for (const claim of ['aud', 'email', 'exp', 'iat', 'role', 'session_id', 'sub']) {
         assert.ok(claim in claims, `missing claim: ${claim}`)
      }
      assert.equal(claims.user_metadata, undefined)
      assert.equal(claims.app_metadata, undefined)
   })
})
