// The user object: reading it, updating it, changing email and password.
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
   newApp,
   newAppWithMailbox,
   get,
   post,
   req,
   type LiteApp,
   type LiteConnection,
   type Mailbox,
} from '../test/harness.ts'

const PASSWORD = 'password123'

describe('the current user', () => {
   let app: LiteApp
   let auth: Record<string, string>
   let userId: string

   beforeEach(async () => {
      ;({ app } = await newApp())
      const session = (await post(app, '/auth/v1/signup', { email: 'me@b.co', password: PASSWORD })).body
      auth = { Authorization: `Bearer ${session.access_token}` }
      userId = session.user.id
   })

   test('GET /user returns the signed-in user', async () => {
      const r = await get(app, '/auth/v1/user', auth)
      assert.equal(r.status, 200)
      assert.equal(r.body.id, userId)
      assert.equal(r.body.email, 'me@b.co')
      assert.equal(r.body.role, 'authenticated')
      assert.equal(r.body.aud, 'authenticated')
   })

   test('the user records email as its provider', async () => {
      const r = await get(app, '/auth/v1/user', auth)
      assert.equal(r.body.app_metadata.provider, 'email')
      assert.deepEqual(r.body.app_metadata.providers, ['email'])
   })

   test('GET /user without a token is unauthorized', async () => {
      const r = await get(app, '/auth/v1/user')
      assert.equal(r.status, 401)
      assert.equal(r.body.error_code, 'no_authorization')
   })

   test('user metadata can be set and reads back', async () => {
      const updated = await req(app, 'PUT', '/auth/v1/user', { data: { nickname: 'ace' } }, auth)
      assert.equal(updated.status, 200)
      assert.equal(updated.body.user_metadata.nickname, 'ace')
      assert.equal((await get(app, '/auth/v1/user', auth)).body.user_metadata.nickname, 'ace')
   })

   test('updating metadata merges rather than replacing what was there', async () => {
      await req(app, 'PUT', '/auth/v1/user', { data: { nickname: 'ace' } }, auth)
      const second = await req(app, 'PUT', '/auth/v1/user', { data: { colour: 'blue' } }, auth)
      assert.equal(second.body.user_metadata.nickname, 'ace')
      assert.equal(second.body.user_metadata.colour, 'blue')
   })

   test('the password can be changed, and the new one signs in', async () => {
      const updated = await req(app, 'PUT', '/auth/v1/user', { password: 'newpassword123' }, auth)
      assert.equal(updated.status, 200)
      const signIn = await post(app, '/auth/v1/token?grant_type=password', {
         email: 'me@b.co',
         password: 'newpassword123',
      })
      assert.equal(signIn.status, 200)
      assert.ok(signIn.body.access_token)
   })

   test('the old password stops working after the change', async () => {
      await req(app, 'PUT', '/auth/v1/user', { password: 'newpassword123' }, auth)
      const signIn = await post(app, '/auth/v1/token?grant_type=password', { email: 'me@b.co', password: PASSWORD })
      assert.ok(signIn.status >= 400)
      assert.equal(signIn.body.error_code, 'invalid_credentials')
   })

   test('a weak password is refused with the GoTrue 422 shape', async () => {
      const r = await req(app, 'PUT', '/auth/v1/user', { password: 'x' }, auth)
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'weak_password')
      assert.deepEqual(r.body.weak_password.reasons, ['length'])
      assert.match(r.body.msg, /at least 6 characters/)
   })

   test('an update without a token is refused', async () => {
      const r = await req(app, 'PUT', '/auth/v1/user', { data: { nickname: 'nope' } })
      assert.equal(r.status, 401)
   })
})

describe('changing an email address', () => {
   let app: LiteApp
   let mail: Mailbox
   let auth: Record<string, string>

   beforeEach(async () => {
      ;({ app, mail } = await newAppWithMailbox())
      const session = (await post(app, '/auth/v1/signup', { email: 'old@b.co', password: PASSWORD })).body
      auth = { Authorization: `Bearer ${session.access_token}` }
   })

   test('requesting a change is accepted', async () => {
      const r = await req(app, 'PUT', '/auth/v1/user', { email: 'new@b.co' }, auth)
      assert.equal(r.status, 200)
   })

   test('the address does not change until confirmed - it is staged as new_email', async () => {
      const updated = await req(app, 'PUT', '/auth/v1/user', { email: 'new@b.co' }, auth)
      assert.equal(updated.body.email, 'old@b.co')
      assert.equal(updated.body.new_email, 'new@b.co')
      assert.equal((await get(app, '/auth/v1/user', auth)).body.email, 'old@b.co')
   })

   test('the confirmation goes to the CURRENT address, not the new one', async () => {
      const before = mail.to('old@b.co').length
      await req(app, 'PUT', '/auth/v1/user', { email: 'new@b.co' }, auth)
      assert.equal(mail.to('new@b.co').length, 0, 'the unconfirmed address must not be written to')
      assert.equal(mail.to('old@b.co').length, before + 1, 'the current address was not notified')
   })
})

describe('signup paths that are refused', () => {
   let app: LiteApp
   before(async () => {
      ;({ app } = await newApp())
      await post(app, '/auth/v1/signup', { email: 'taken@b.co', password: PASSWORD })
   })

   test('signing up twice reports user_already_exists', async () => {
      const r = await post(app, '/auth/v1/signup', { email: 'taken@b.co', password: PASSWORD })
      assert.equal(r.status, 422)
      assert.equal(r.body.error_code, 'user_already_exists')
   })

   test('an unsupported grant type is reported as invalid_credentials', async () => {
      const r = await post(app, '/auth/v1/token?grant_type=id_token', {})
      assert.equal(r.status, 400)
      assert.equal(r.body.error_code, 'invalid_credentials')
      assert.equal(r.body.msg, 'unsupported_grant_type')
   })

   test('an unknown verification type is a validation failure', async () => {
      const r = await post(app, '/auth/v1/verify', { type: 'nope', token: 'x', email: 'taken@b.co' })
      assert.equal(r.status, 400)
      assert.equal(r.body.error_code, 'validation_failed')
      assert.match(r.body.msg, /Invalid email verification type/)
   })
})

describe('reauthenticate, magiclink and resend', () => {
   let app: LiteApp
   let mail: Mailbox
   let auth: Record<string, string>

   beforeEach(async () => {
      ;({ app, mail } = await newAppWithMailbox())
      const session = (await post(app, '/auth/v1/signup', { email: 'me@b.co', password: PASSWORD })).body
      auth = { Authorization: `Bearer ${session.access_token}` }
   })

   test('reauthenticate accepts a signed-in caller and answers with an empty body', async () => {
      const r = await get(app, '/auth/v1/reauthenticate', auth)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, {})
   })

   test('reauthenticate needs a token', async () => {
      assert.equal((await get(app, '/auth/v1/reauthenticate')).status, 401)
   })

   test('magiclink is accepted and delivers a mail', async () => {
      const r = await post(app, '/auth/v1/magiclink', { email: 'me@b.co' })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, {})
      assert.ok(mail.to('me@b.co').length >= 1)
   })

   test('resend is accepted for a signup confirmation', async () => {
      const r = await post(app, '/auth/v1/resend', { type: 'signup', email: 'me@b.co' })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, {})
   })

   test('magiclink for an unknown address is still accepted, revealing nothing', async () => {
      const r = await post(app, '/auth/v1/magiclink', { email: 'stranger@b.co' })
      assert.equal(r.status, 200)
   })
})

// auth.users carries deleted_at, but the string occurs exactly once in the published bundle: in the
// DDL that creates the column. No ordinary path writes it, so there is no soft delete here.
describe('deleted_at', () => {
   test('stays null through signup, sign-in and an update', async () => {
      const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp()
      const session = (await post(app, '/auth/v1/signup', { email: 'd@b.co', password: PASSWORD })).body
      const auth = { Authorization: `Bearer ${session.access_token}` }

      await post(app, '/auth/v1/token?grant_type=password', { email: 'd@b.co', password: PASSWORD })
      await req(app, 'PUT', '/auth/v1/user', { data: { seen: true } }, auth)

      const { rows } = await connection.exec('SELECT deleted_at FROM "auth.users"')
      assert.deepEqual(
         (rows as { deleted_at: unknown }[]).map((r) => r.deleted_at),
         [null],
      )
   })
})
