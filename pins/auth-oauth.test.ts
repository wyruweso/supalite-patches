// The OAuth authorize and callback routes.
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newRawApp, req, get, type LiteApp } from '../test/harness.ts'

const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters'
const CONFIG = {
   auth: {
      enabled: true,
      jwt_secret: JWT_SECRET,
      site_url: 'http://localhost:3000',
      external: {
         github: { enabled: true, client_id: 'gh-id', secret: 'gh-secret' },
         google: { enabled: true, client_id: 'g-id', secret: 'g-secret' },
      },
   },
}

type Handler = [match: string, respond: () => Response]

const json = (body: unknown, status = 200) =>
   new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const GITHUB_OK: Handler[] = [
   ['login/oauth/access_token', () => json({ access_token: 'gho_test', token_type: 'bearer' })],
   ['api.github.com/user/emails', () => json([{ email: 'oauth@b.co', primary: true, verified: true }])],
   ['api.github.com/user', () => json({ id: 42, login: 'octo', name: 'Octo Cat', avatar_url: 'http://x/a.png' })],
]

const authorizeLocation = (r: { body: any }) =>
   String(r.body)
      .match(/href="([^"]+)"/)![1]
      .replace(/&amp;/g, '&')
const fragmentOf = (r: { body: any }) => new URLSearchParams(new URL(authorizeLocation(r)).hash.slice(1))

async function signInWith(app: LiteApp, provider: string, handlers: Handler[]) {
   const authorize = await req(app, 'GET', `/auth/v1/authorize?provider=${provider}`)
   const state = new URL(authorizeLocation(authorize)).searchParams.get('state')!
   const real = globalThis.fetch
   globalThis.fetch = (async (url: any) => {
      const target = String(url)
      for (const [match, respond] of handlers) if (target.includes(match)) return respond()
      return new Response(`unexpected request to ${target}`, { status: 500 })
   }) as typeof fetch
   try {
      return await req(app, 'GET', `/auth/v1/callback?code=abc&state=${encodeURIComponent(state)}`)
   } finally {
      globalThis.fetch = real
   }
}

describe('authorize', () => {
   let app: LiteApp
   before(async () => {
      ;({ app } = await newRawApp(CONFIG))
   })

   test('github redirects to GitHub with the client id, scope and a state', async () => {
      const r = await req(app, 'GET', '/auth/v1/authorize?provider=github')
      assert.equal(r.status, 302)
      const target = new URL(authorizeLocation(r))
      assert.equal(target.origin + target.pathname, 'https://github.com/login/oauth/authorize')
      assert.equal(target.searchParams.get('client_id'), 'gh-id')
      assert.equal(target.searchParams.get('scope'), 'user:email')
      assert.match(target.searchParams.get('state')!, /^[0-9a-f-]{36}$/)
   })

   test('google redirects to its own authorization endpoint', async () => {
      const target = new URL(authorizeLocation(await req(app, 'GET', '/auth/v1/authorize?provider=google')))
      assert.equal(target.origin + target.pathname, 'https://accounts.google.com/o/oauth2/v2/auth')
      assert.equal(target.searchParams.get('client_id'), 'g-id')
   })

   test('each authorize issues a fresh state', async () => {
      const first = new URL(
         authorizeLocation(await req(app, 'GET', '/auth/v1/authorize?provider=github')),
      ).searchParams.get('state')
      const second = new URL(
         authorizeLocation(await req(app, 'GET', '/auth/v1/authorize?provider=github')),
      ).searchParams.get('state')
      assert.notEqual(first, second)
   })

   test('a provider that is configured but not enabled is refused', async () => {
      const r = await req(app, 'GET', '/auth/v1/authorize?provider=discord')
      assert.equal(r.status, 400)
      assert.equal(r.body.error_code, 'validation_failed')
      assert.match(r.body.msg, /provider is not enabled/)
   })
})

describe('a successful callback', () => {
   let app: LiteApp
   beforeEach(async () => {
      ;({ app } = await newRawApp(CONFIG))
   })

   test('redirects to site_url with the session in the URL fragment', async () => {
      const r = await signInWith(app, 'github', GITHUB_OK)
      assert.equal(r.status, 302)
      const target = new URL(authorizeLocation(r))
      assert.equal(target.origin + target.pathname, 'http://localhost:3000/')
      assert.ok(target.hash.length > 1)
   })

   test('the fragment carries the tokens a client needs', async () => {
      const fragment = fragmentOf(await signInWith(app, 'github', GITHUB_OK))
      assert.deepEqual([...fragment.keys()].sort(), [
         'access_token',
         'expires_at',
         'expires_in',
         'provider_token',
         'refresh_token',
         'sb',
         'token_type',
      ])
      assert.equal(fragment.get('token_type'), 'bearer')
      assert.equal(fragment.get('provider_token'), 'gho_test')
   })

   test('the issued access token authenticates against /user', async () => {
      const fragment = fragmentOf(await signInWith(app, 'github', GITHUB_OK))
      const me = await get(app, '/auth/v1/user', { Authorization: `Bearer ${fragment.get('access_token')}` })
      assert.equal(me.status, 200)
      assert.equal(me.body.email, 'oauth@b.co')
   })

   test('the user records github as its provider', async () => {
      const fragment = fragmentOf(await signInWith(app, 'github', GITHUB_OK))
      const me = await get(app, '/auth/v1/user', { Authorization: `Bearer ${fragment.get('access_token')}` })
      assert.equal(me.body.app_metadata.provider, 'github')
      assert.deepEqual(me.body.app_metadata.providers, ['github'])
   })

   test('the provider profile is copied into user_metadata', async () => {
      const fragment = fragmentOf(await signInWith(app, 'github', GITHUB_OK))
      const me = await get(app, '/auth/v1/user', { Authorization: `Bearer ${fragment.get('access_token')}` })
      assert.equal(me.body.user_metadata.sub, '42')
      assert.equal(me.body.user_metadata.full_name, 'Octo Cat')
      assert.equal(me.body.user_metadata.user_name, 'octo')
      assert.equal(me.body.user_metadata.avatar_url, 'http://x/a.png')
      assert.equal(me.body.user_metadata.email_verified, true)
      assert.equal(me.body.user_metadata.iss, 'https://api.github.com')
   })

   test('an identity row links the provider account to the user', async () => {
      const fragment = fragmentOf(await signInWith(app, 'github', GITHUB_OK))
      const me = await get(app, '/auth/v1/user', { Authorization: `Bearer ${fragment.get('access_token')}` })
      assert.equal(me.body.identities.length, 1)
      assert.equal(me.body.identities[0].id, '42')
      assert.equal(me.body.identities[0].user_id, me.body.id)
   })

   test('signing in twice reuses the same user rather than creating another', async () => {
      const first = fragmentOf(await signInWith(app, 'github', GITHUB_OK))
      const second = fragmentOf(await signInWith(app, 'github', GITHUB_OK))
      const one = await get(app, '/auth/v1/user', { Authorization: `Bearer ${first.get('access_token')}` })
      const two = await get(app, '/auth/v1/user', { Authorization: `Bearer ${second.get('access_token')}` })
      assert.equal(one.body.id, two.body.id)
   })

   test('the email comes from the emails endpoint, not from the profile', async () => {
      const r = await signInWith(app, 'github', [
         ['login/oauth/access_token', () => json({ access_token: 'gho_test', token_type: 'bearer' })],
         [
            'api.github.com/user/emails',
            () =>
               json([
                  { email: 'secondary@b.co', primary: false, verified: true },
                  { email: 'primary@b.co', primary: true, verified: true },
               ]),
         ],
         ['api.github.com/user', () => json({ id: 42, login: 'octo', name: 'Octo Cat' })],
      ])
      const me = await get(app, '/auth/v1/user', { Authorization: `Bearer ${fragmentOf(r).get('access_token')}` })
      assert.equal(me.body.email, 'primary@b.co')
   })
})

describe('a callback the provider rejects', () => {
   let app: LiteApp
   beforeEach(async () => {
      ;({ app } = await newRawApp(CONFIG))
   })

   test('a failed code exchange still redirects, reporting the error in BOTH query and fragment', async () => {
      const r = await signInWith(app, 'github', [
         ['login/oauth/access_token', () => new Response('bad creds', { status: 401 })],
      ])
      assert.equal(r.status, 302)
      const target = new URL(authorizeLocation(r))
      assert.equal(target.searchParams.get('error'), 'server_error')
      assert.equal(target.searchParams.get('error_code'), 'unexpected_failure')
      assert.match(target.searchParams.get('error_description')!, /Unable to exchange external code/)

      const fragment = new URLSearchParams(target.hash.slice(1))
      assert.equal(fragment.get('error'), 'server_error')
      assert.equal(fragment.get('error_code'), 'unexpected_failure')
      assert.ok(!fragment.has('access_token'), 'a failed sign-in must not carry a session')
   })

   test('no user is created when the exchange fails', async () => {
      await signInWith(app, 'github', [['login/oauth/access_token', () => new Response('bad creds', { status: 401 })]])
      const attempt = await req(app, 'POST', '/auth/v1/token?grant_type=password', {
         email: 'oauth@b.co',
         password: 'password123',
      })
      assert.ok(attempt.status >= 400)
   })

   test('a failure at the profile step is reported the same way', async () => {
      const r = await signInWith(app, 'github', [
         ['login/oauth/access_token', () => json({ access_token: 'gho_test', token_type: 'bearer' })],
         ['api.github.com/user', () => new Response('forbidden', { status: 403 })],
      ])
      assert.equal(r.status, 302)
      assert.ok(new URL(authorizeLocation(r)).searchParams.has('error'))
   })
})
