// The /_system routes and the OpenAPI document.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, type LiteApp } from '../test/harness.ts'

describe('_system', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('ping answers pong', async () => {
      const r = await get(app, '/_system/ping')
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { message: 'pong' })
   })

   test('config reports the resolved configuration', async () => {
      const r = await get(app, '/_system/config')
      assert.equal(r.status, 200)
      assert.equal(r.body.auth.enabled, true)
      assert.equal(r.body.auth.site_url, 'http://localhost:3000')
      assert.equal(r.body.auth.jwt_expiry, 3600)
   })

   test('config redacts the jwt secret rather than serving it', async () => {
      const r = await get(app, '/_system/config')
      assert.equal(r.body.auth.jwt_secret, '[redacted]')
   })

   test('config exposes defaults the caller never set', async () => {
      const r = await get(app, '/_system/config')
      assert.equal(r.body.auth.enable_refresh_token_rotation, true)
      assert.equal(r.body.auth.refresh_token_reuse_interval, 10)
      assert.equal(r.body.auth.enable_manual_linking, false)
   })

   // A table is located by its DDL rather than its reported name: whether the auth table comes back
   // as `auth.users` or as `users` with `schema: 'auth'` depends on whether the Postgres metadata was
   // merged in, which is FIX-003's subject and is asserted there.
   const authUsers = (body: any) => body.tables.find((t: any) => String(t.sql).includes('"auth.users"'))

   test('introspect reports the tables with their SQLite DDL', async () => {
      const r = await get(app, '/_system/introspect')
      assert.equal(r.status, 200)
      assert.ok(Array.isArray(r.body.tables))
      assert.ok(authUsers(r.body), `auth.users missing from ${JSON.stringify(r.body.tables.map((t: any) => t.name))}`)
      assert.ok(
         r.body.tables.some((t: any) => t.name === 'authors'),
         'the seeded table is missing',
      )
   })

   test('the introspected DDL is the translated SQLite form, not the Postgres original', async () => {
      const r = await get(app, '/_system/introspect')
      const users = authUsers(r.body)
      assert.match(users.sql, /^CREATE TABLE "auth\.users" \(/)
      assert.match(users.sql, /id TEXT PRIMARY KEY CHECK \(id IS NULL OR id GLOB/)
   })

   test('info reports the connection and its translation settings', async () => {
      const r = await get(app, '/_system/info')
      assert.equal(r.status, 200)
      assert.equal(r.body.connection.url, ':memory:')
      assert.equal(r.body.connection.introspection.name, 'sqlite')
      assert.equal(r.body.connection.translation.schemas.defaultSchema, 'public')
   })

   test('info lists the tables excluded from introspection', async () => {
      const r = await get(app, '/_system/info')
      assert.deepEqual(r.body.connection.introspection.exclude_tables, [
         'sqlite_%',
         'supabase_migrations.%',
         'migrations',
      ])
   })

   test('the system endpoints need no credentials', async () => {
      for (const path of ['/_system/ping', '/_system/config', '/_system/info', '/_system/introspect'])
         assert.equal((await get(app, path)).status, 200, path)
   })
})

describe('postgrest openapi root', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('the root serves a swagger 2.0 document', async () => {
      const r = await get(app, '/rest/v1/')
      assert.equal(r.status, 200)
      assert.equal(r.body.swagger, '2.0')
      assert.equal(r.body.info.title, 'standard public schema')
      assert.equal(r.body.basePath, '/')
   })

   test('it advertises the PostgREST content types', async () => {
      const r = await get(app, '/rest/v1/')
      assert.ok(r.body.consumes.includes('application/json'))
      assert.ok(r.body.consumes.includes('application/vnd.pgrst.object+json'))
      assert.ok(r.body.consumes.includes('text/csv'))
   })

   test('the document is metadata only - it describes NO paths and NO definitions', async () => {
      const r = await get(app, '/rest/v1/')
      assert.deepEqual(Object.keys(r.body), ['swagger', 'info', 'basePath', 'schemes', 'consumes', 'produces'])
      assert.equal(r.body.paths, undefined)
      assert.equal(r.body.definitions, undefined)
   })
})

describe('gotrue discovery documents', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('health identifies itself as GoTrue', async () => {
      const r = await get(app, '/auth/v1/health')
      assert.equal(r.status, 200)
      assert.equal(r.body.name, 'GoTrue')
      assert.match(r.body.description, /user registration and authentication API/)
   })

   test('the version field is a JWT whose payload names the real implementation', async () => {
      const r = await get(app, '/auth/v1/health')
      const claims = JSON.parse(Buffer.from(r.body.version.split('.')[1], 'base64url').toString())
      assert.deepEqual(claims, { name: 'GoTrue', implementation: '@supabase/lite' })
   })

   test('email is the one provider enabled by default; every social one is off', async () => {
      const r = await get(app, '/auth/v1/settings')
      assert.equal(r.status, 200)
      assert.deepEqual(
         Object.entries(r.body.external)
            .filter(([, enabled]) => enabled)
            .map(([provider]) => provider),
         ['email'],
      )
   })

   test('settings reports the signup and confirmation policy', async () => {
      const r = await get(app, '/auth/v1/settings')
      for (const key of ['disable_signup', 'mailer_autoconfirm', 'phone_autoconfirm', 'sms_provider', 'saml_enabled'])
         assert.ok(key in r.body, `${key} is missing from settings`)
   })

   test('settings lists the providers a client can offer', async () => {
      const r = await get(app, '/auth/v1/settings')
      for (const provider of ['github', 'google', 'apple', 'discord', 'gitlab', 'anonymous_users'])
         assert.ok(provider in r.body.external, `${provider} is missing from settings`)
   })
})
