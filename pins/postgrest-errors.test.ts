// Which failure maps to which PostgREST code and status.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, pgrstCode } from '../test/harness.ts'
import type { LiteApp } from '../test/harness.ts'

let app: LiteApp
before(async () => ({ app } = await newApp()))

describe('schema-cache errors', () => {
   test('unknown table is PGRST205', async () => {
      const r = await get(app, '/rest/v1/nope')
      assert.equal(r.status, 404)
      assert.equal(pgrstCode(r), 'PGRST205')
   })

   test('unknown column in select is an error', async () => {
      const r = await get(app, '/rest/v1/books?select=nope')
      assert.ok(r.status >= 400)
   })

   test('unknown column in a filter is an error', async () => {
      const r = await get(app, '/rest/v1/books?nope=eq.1')
      assert.ok(r.status >= 400)
   })
})

describe('request-shape errors', () => {
   test('malformed select syntax is rejected', async () => {
      const r = await get(app, '/rest/v1/books?select=id,,')
      assert.ok(r.status >= 400)
   })

   test('ragged insert batch is PGRST102', async () => {
      const r = await post(app, '/rest/v1/reviews', [
         { id: 30, book_id: 1, stars: 1 },
         { id: 31, book_id: 1 },
      ])
      assert.equal(pgrstCode(r), 'PGRST102')
   })

   test('malformed JSON body is rejected', async () => {
      const r = await post(app, '/rest/v1/reviews', '{oops')
      assert.ok(r.status >= 400)
   })

   test('unsupported Accept is rejected', async () => {
      const r = await get(app, '/rest/v1/books', { Accept: 'application/xml' })
      assert.ok(r.status >= 400)
   })

   test('vnd.pgrst.object+json on many rows errors', async () => {
      const r = await get(app, '/rest/v1/books', { Accept: 'application/vnd.pgrst.object+json' })
      assert.ok(r.status >= 400)
   })

   test('unknown exposed schema is rejected', async () => {
      const r = await get(app, '/rest/v1/books', { 'Accept-Profile': 'nope' })
      assert.ok(r.status >= 400)
   })
})

describe('constraint violations', () => {
   test('not-null violation surfaces as an error', async () => {
      const r = await post(app, '/rest/v1/books', {
         id: 90,
         author_id: 1,
         pages: 1,
         price: 1,
         published: null,
         title: null,
      })
      assert.ok(r.status >= 400)
   })

   test('foreign-key violation surfaces as an error', async () => {
      const r = await post(app, '/rest/v1/books', {
         id: 91,
         author_id: 999,
         title: 'orphan',
         pages: 1,
         price: 1,
         published: '2000-01-01',
      })
      assert.ok(r.status >= 400)
   })

   test('primary-key conflict without upsert is an error', async () => {
      const r = await post(app, '/rest/v1/books', {
         id: 1,
         author_id: 1,
         title: 'dup',
         pages: 1,
         price: 1,
         published: '2000-01-01',
      })
      assert.ok(r.status >= 400)
   })
})

describe('routing', () => {
   test('the OpenAPI root returns JSON', async () => {
      const r = await get(app, '/rest/v1/')
      assert.equal(r.status, 200)
      assert.match(r.contentType ?? '', /application\/json/)
   })

   test('an unmatched path falls through to the studio SPA', async () => {
      const r = await get(app, '/nope/v1/x')
      assert.equal(r.status, 200)
      assert.match(r.contentType ?? '', /text\/html/)
   })
})

describe('foreign key violations', () => {
   let fkApp: LiteApp
   before(async () => {
      const a = await newApp({ seed: false })
      await (
         await a.connection.createMigrator(
            'CREATE TABLE authors (id int primary key, name text);\nCREATE TABLE books (id int primary key, author_id int references authors(id));',
         )
      ).migrate()
      fkApp = a.app
   })

   test('a valid reference is accepted, so the constraint itself works', async () => {
      await post(fkApp, '/rest/v1/authors', { id: 1, name: 'Толстой' })
      const r = await post(fkApp, '/rest/v1/books', { id: 2, author_id: 1 }, { Prefer: 'return=representation' })
      assert.equal(r.status, 201)
   })
})
