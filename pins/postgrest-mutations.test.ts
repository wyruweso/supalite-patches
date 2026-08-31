// INSERT, UPDATE, UPSERT, DELETE, and the Prefer headers that steer them.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, req, get, post } from '../test/harness.ts'
import type { LiteApp } from '../test/harness.ts'

let app: LiteApp
beforeEach(async () => ({ app } = await newApp()))

describe('insert', () => {
   test('defaults to no body and 201', async () => {
      const r = await post(app, '/rest/v1/reviews', { id: 10, book_id: 2, stars: 3, body: 'ok' })
      assert.equal(r.status, 201)
      assert.deepEqual(r.body, '')
   })

   test('Prefer return=representation returns the row', async () => {
      const r = await post(
         app,
         '/rest/v1/reviews',
         { id: 11, book_id: 2, stars: 2 },
         { Prefer: 'return=representation' },
      )
      assert.equal(r.status, 201)
      assert.equal(r.body[0].id, 11)
   })

   test('inserts a batch', async () => {
      const r = await post(
         app,
         '/rest/v1/reviews',
         [
            { id: 12, book_id: 2, stars: 1, body: 'a' },
            { id: 13, book_id: 2, stars: 2, body: 'b' },
         ],
         { Prefer: 'return=representation' },
      )
      assert.equal(r.body.length, 2)
   })
})

describe('upsert', () => {
   test('merge-duplicates overwrites the existing row', async () => {
      await post(app, '/rest/v1/reviews', { id: 20, book_id: 2, stars: 1, body: 'first' })
      const r = await post(
         app,
         '/rest/v1/reviews',
         { id: 20, book_id: 2, stars: 5, body: 'second' },
         { Prefer: 'resolution=merge-duplicates,return=representation' },
      )
      assert.equal(r.body[0].stars, 5)
   })

   test('ignore-duplicates keeps the existing row', async () => {
      await post(app, '/rest/v1/reviews', { id: 21, book_id: 2, stars: 1, body: 'first' })
      await post(
         app,
         '/rest/v1/reviews',
         { id: 21, book_id: 2, stars: 9, body: 'second' },
         { Prefer: 'resolution=ignore-duplicates' },
      )
      const after = await get(app, '/rest/v1/reviews?select=stars&id=eq.21')
      assert.equal(after.body[0].stars, 1)
   })
})

describe('patch, delete and put', () => {
   test('patch updates matched rows', async () => {
      const r = await req(
         app,
         'PATCH',
         '/rest/v1/reviews?id=eq.1',
         { body: 'edited' },
         { Prefer: 'return=representation' },
      )
      assert.equal(r.body[0].body, 'edited')
   })

   test('patch without a filter still targets the whole table', async () => {
      await req(app, 'PATCH', '/rest/v1/reviews?stars=eq.5', { body: 'bulk' })
      const after = await get(app, '/rest/v1/reviews?select=id,body&stars=eq.5&order=id.asc')
      assert.ok(after.body.every((x: { body: string }) => x.body === 'bulk'))
   })

   test('delete removes matched rows', async () => {
      await req(app, 'DELETE', '/rest/v1/reviews?id=eq.2')
      const after = await get(app, '/rest/v1/reviews?select=id&id=eq.2')
      assert.deepEqual(after.body, [])
   })

   test('put replaces a row', async () => {
      const r = await req(
         app,
         'PUT',
         '/rest/v1/reviews?id=eq.1',
         { id: 1, book_id: 1, stars: 1, body: 'replaced' },
         { Prefer: 'return=representation' },
      )
      assert.equal(r.body[0].body, 'replaced')
   })
})
