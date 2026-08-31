// Asserts the CORRECT behaviour, so it fails on the published build by design.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, type LiteApp, type LiteConnection } from '../../test/harness.ts'

const SCHEMA = 'CREATE TABLE items (id int primary key, tags text[], nums int[], meta jsonb, ok boolean);'

describe('FIX-003 values come back in their Postgres types', () => {
   let app: LiteApp

   before(async () => {
      const a: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      await (await a.connection.createMigrator(SCHEMA)).migrate()
      app = a.app
      await post(
         app,
         '/rest/v1/items',
         { id: 1, tags: ['a', 'b'], nums: [1, 2], meta: { x: { y: 1 } }, ok: true },
         { Prefer: 'return=representation' },
      )
   })

   const row = async (select: string) => (await get(app, `/rest/v1/items?id=eq.1&select=${select}`)).body[0]

   test('a text[] column is an array, not the characters of one', async () => {
      assert.deepEqual((await row('tags')).tags, ['a', 'b'])
   })

   // The element type is not in the check, so int[] and text[] are indistinguishable. Values are
   // unaffected: numbers arrive from JSON as numbers.
   test('an int[] column keeps its numbers as numbers', async () => {
      assert.deepEqual((await row('nums')).nums, [1, 2])
   })

   test('a jsonb column is an object', async () => {
      assert.deepEqual((await row('meta')).meta, { x: { y: 1 } })
   })

   test('a boolean column is true, not 1', async () => {
      assert.equal((await row('ok')).ok, true)
   })

   test('the round trip is still lossless', async () => {
      const r = await post(
         app,
         '/rest/v1/items',
         { id: 2, tags: ['c'], nums: [3], meta: { z: 1 }, ok: false },
         { Prefer: 'return=representation' },
      )
      assert.equal(r.status, 201)
      assert.deepEqual((await get(app, '/rest/v1/items?id=eq.2&select=tags,ok')).body[0], { tags: ['c'], ok: false })
   })

   // The declared type is recovered from the CHECK the translator wrote, and one column name can end
   // another: `book_k IN (0, 1)` contains `k IN (0, 1)`, so `k` came back as true instead of 1.
   test('a column does not borrow the type of one whose name ends with its own', async () => {
      const other: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
      await (
         await other.connection.createMigrator('CREATE TABLE t (id int primary key, k int, book_k boolean);')
      ).migrate()
      await post(other.app, '/rest/v1/t', { id: 1, k: 1, book_k: true })

      const row = (await get(other.app, '/rest/v1/t?id=eq.1&select=k,book_k')).body[0]
      assert.equal(row.k, 1)
      assert.equal(row.book_k, true)
   })
})
