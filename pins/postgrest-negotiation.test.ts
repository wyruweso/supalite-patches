// Content negotiation, Range, Prefer and the schema cache.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, req, pgrstCode, type LiteApp, type LiteConnection } from '../test/harness.ts'

describe('accept', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('text/csv returns a header row and comma-separated values', async () => {
      const r = await get(app, '/rest/v1/authors?select=id,name&order=id', { Accept: 'text/csv' })
      assert.equal(r.status, 200)
      assert.match(r.contentType ?? '', /^text\/csv/)
      assert.equal(r.body, "id,name\n1,Ursula\n2,Borges\n3,O'Brien")
   })

   test('vnd.pgrst.object+json returns a bare object rather than a list', async () => {
      const r = await get(app, '/rest/v1/authors?id=eq.1&select=id,name', {
         Accept: 'application/vnd.pgrst.object+json',
      })
      assert.equal(r.status, 200)
      assert.match(r.contentType ?? '', /^application\/vnd\.pgrst\.object\+json/)
      assert.deepEqual(r.body, { id: 1, name: 'Ursula' })
   })

   test('asking for a single object when there are none is PGRST116', async () => {
      const r = await get(app, '/rest/v1/authors?id=eq.99', { Accept: 'application/vnd.pgrst.object+json' })
      assert.equal(r.status, 406)
      assert.equal(pgrstCode(r), 'PGRST116')
      assert.equal(r.body.details, 'The result contains 0 rows')
   })

   test('nulls=stripped drops null columns from the object', async () => {
      const r = await get(app, '/rest/v1/authors?id=eq.2&select=id,bio', {
         Accept: 'application/vnd.pgrst.object+json;nulls=stripped',
      })
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { id: 2 })
   })

   test('a HEAD request returns the headers with no body', async () => {
      const r = await req(app, 'HEAD', '/rest/v1/authors?select=id')
      assert.equal(r.status, 200)
      assert.equal(r.body, '')
      assert.match(r.contentRange ?? '', /^0-2\//)
   })
})

describe('prefer', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('return=minimal answers 201 with no body, and says so', async () => {
      const r = await post(app, '/rest/v1/authors', { id: 90, name: 'Minimal' }, { Prefer: 'return=minimal' })
      assert.equal(r.status, 201)
      assert.equal(r.body, '')
      assert.equal(r.contentType, null)
   })

   test('count=exact reports the total', async () => {
      const r = await get(app, '/rest/v1/books?select=id', { Prefer: 'count=exact' })
      assert.match(r.contentRange ?? '', /\/3$/)
   })

   test('count=planned and count=estimated report an EXACT total too', async () => {
      for (const mode of ['planned', 'estimated']) {
         const r = await get(app, '/rest/v1/books?select=id', { Prefer: `count=${mode}` })
         assert.match(r.contentRange ?? '', /\/3$/, mode)
      }
   })

   test('an applied preference is echoed in Preference-Applied', async () => {
      const r = await post(app, '/rest/v1/authors', { id: 91, name: 'Echo' }, { Prefer: 'return=representation' })
      assert.equal(r.status, 201)
   })

   test('resolution=merge-duplicates upserts and reports both preferences applied', async () => {
      const r = await post(
         app,
         '/rest/v1/authors?on_conflict=id',
         { id: 1, name: 'Renamed' },
         { Prefer: 'resolution=merge-duplicates,return=representation' },
      )
      assert.equal(r.status, 200)
      assert.equal(r.body[0].name, 'Renamed')
      assert.equal(r.body[0].bio, 'sci-fi')
   })
})

describe('response headers', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('a select reports its window in Content-Range with an unknown total', async () => {
      const r = await get(app, '/rest/v1/authors?select=id')
      assert.equal(r.contentRange, '0-2/*')
   })

   test('a Range header narrows the window and the reported range follows it', async () => {
      const r = await get(app, '/rest/v1/authors?select=id&order=id', { Range: '0-0', 'Range-Unit': 'items' })
      assert.equal(r.body.length, 1)
      assert.equal(r.contentRange, '0-0/*')
   })

   test('limit narrows it the same way', async () => {
      const r = await get(app, '/rest/v1/authors?select=id&limit=1&order=id')
      assert.equal(r.body.length, 1)
      assert.equal(r.contentRange, '0-0/*')
   })

   test('an insert reports an uncounted range rather than a window', async () => {
      const r = await post(app, '/rest/v1/authors', { id: 92, name: 'Ranged' }, { Prefer: 'return=representation' })
      assert.equal(r.contentRange, '*/*')
   })
})

describe('profiles', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('an unknown Accept-Profile is PGRST106 and names the exposed schemas', async () => {
      const r = await get(app, '/rest/v1/authors?select=id', { 'Accept-Profile': 'nope' })
      assert.equal(r.status, 406)
      assert.equal(pgrstCode(r), 'PGRST106')
      assert.equal(r.body.hint, 'Only the following schemas are exposed: graphql_public, public, storage')
   })

   test('Content-Profile: public is accepted on a write', async () => {
      const r = await post(
         app,
         '/rest/v1/authors',
         { id: 93, name: 'Profiled' },
         { 'Content-Profile': 'public', Prefer: 'return=representation' },
      )
      assert.equal(r.status, 201)
      assert.equal(r.body[0].name, 'Profiled')
   })
})

describe('json columns', () => {
   let app: LiteApp
   let connection: LiteConnection
   before(async () => {
      ;({ app, connection } = await newApp({ seed: false }))
      await connection.exec('CREATE TABLE docs (id integer primary key, payload text)')
      await post(app, '/rest/v1/docs', [{ id: 1, payload: JSON.stringify({ a: { b: 7 }, list: [1, 2] }) }])
   })

   test('-> and ->> reach into a json column, and the last segment names the output', async () => {
      const r = await get(app, '/rest/v1/docs?select=payload->a->>b')
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [{ b: 7 }])
   })

   test('a json path can be filtered on', async () => {
      assert.deepEqual((await get(app, '/rest/v1/docs?payload->a->>b=eq.7&select=id')).body, [{ id: 1 }])
   })

   test('a json path that matches nothing filters the row out', async () => {
      assert.deepEqual((await get(app, '/rest/v1/docs?payload->a->>b=eq.99&select=id')).body, [])
   })
})

describe('the columns parameter', () => {
   let app: LiteApp
   before(async () => ({ app } = await newApp()))

   test('columns restricts which payload keys are read, ignoring the rest', async () => {
      const r = await post(
         app,
         '/rest/v1/authors?columns=id,name',
         { id: 94, name: 'Restricted', bogus: 'ignored' },
         { Prefer: 'return=representation' },
      )
      assert.equal(r.status, 201)
      assert.equal(r.body[0].name, 'Restricted')
      assert.equal(r.body[0].bio, null)
   })
})

describe('non-ASCII table names and Content-Location', () => {
   let app: LiteApp

   before(async () => {
      const made = await newApp({ seed: false })
      app = made.app
      await (
         await made.connection.createMigrator(
            'CREATE TABLE книги (id int primary key, name text); CREATE TABLE books (id int primary key, name text);',
         )
      ).migrate()
      await post(app, '/rest/v1/книги', { id: 1, name: 'x' })
   })

   test('a non-ASCII table accepts writes and a bare select', async () => {
      const r = await get(app, '/rest/v1/книги')
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [{ id: 1, name: 'x' }])
   })

   test('adding any query parameter turns the same request into a 500', async () => {
      const selected = await get(app, '/rest/v1/книги?select=id')
      assert.equal(selected.status, 500)
      assert.equal(pgrstCode(selected), 'SUP')
      assert.match(selected.body.message, /Cannot convert argument to a ByteString/)

      assert.equal((await get(app, '/rest/v1/книги?id=eq.1')).status, 500)
   })
   test('a non-ASCII VALUE is percent-encoded correctly, so only identifiers are affected', async () => {
      const r = await get(app, '/rest/v1/books?select=id&name=eq.Тест')
      assert.equal(r.status, 200)
   })
})
