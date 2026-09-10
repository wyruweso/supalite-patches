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

      const written = await post(
         app,
         '/rest/v1/items',
         { id: 1, tags: ['a', 'b'], nums: [1, 2], meta: { x: { y: 1 } }, ok: true },
         { Prefer: 'return=representation' },
      )
      assert.equal(written.status, 201, `the fixture row was not written: ${JSON.stringify(written.body)}`)
   })

   const row = async (select: string) => (await get(app, `/rest/v1/items?id=eq.1&select=${select}`)).body[0]

   test('a text[] column is an array, not the characters of one', async () => {
      assert.deepEqual((await row('tags')).tags, ['a', 'b'])
   })

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
      const sent = { id: 2, tags: ['c'], nums: [3], meta: { z: 1 }, ok: false }
      const written = await post(app, '/rest/v1/items', sent, { Prefer: 'return=representation' })
      assert.equal(written.status, 201)

      const read = (await get(app, '/rest/v1/items?id=eq.2&select=id,tags,nums,meta,ok')).body[0]
      assert.deepEqual(read, sent)
   })

   // Declared metadata must keep integers as integers, regardless of nearby CHECK expressions.
   describe('an integer column stays an integer', () => {
      const integerBesides = async (ddl: string, insert: Record<string, unknown>) => {
         const other: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
         await (await other.connection.createMigrator(ddl)).migrate()
         const written = await post(other.app, '/rest/v1/t', insert, { Prefer: 'return=representation' })
         assert.equal(written.status, 201, `the row was not written: ${JSON.stringify(written.body)}`)
         return (await get(other.app, '/rest/v1/t?id=eq.1&select=*')).body[0]
      }

      // `book_k IN (0, 1)` contains `k IN (0, 1)`.
      test('beside a boolean whose name ends with its own', async () => {
         const row = await integerBesides('CREATE TABLE t (id int primary key, k int, book_k boolean);', {
            id: 1,
            k: 1,
            book_k: true,
         })
         assert.equal(row.k, 1)
         assert.equal(row.book_k, true)
      })

      // A CHECK is not a type: an integer restricted to 0 and 1 is still an integer.
      test('with a CHECK restricting it to 0 and 1', async () => {
         const row = await integerBesides('CREATE TABLE t (id int primary key, k int check (k in (0, 1)));', {
            id: 1,
            k: 1,
         })
         assert.equal(row.k, 1)
      })

      // Nor is a string that happens to read like one.
      test("beside a DEFAULT whose text reads like a boolean's CHECK", async () => {
         const row = await integerBesides(
            "CREATE TABLE t (id int primary key, k int, note text default 'k IN (0, 1)');",
            { id: 1, k: 1 },
         )
         assert.equal(row.k, 1)
      })

      // A word boundary is not an ASCII question: `ёk` ends with `k` in every sense that matters.
      test('beside a boolean whose non-ASCII name ends with its own', async () => {
         const row = await integerBesides('CREATE TABLE t (id int primary key, k int, ёk boolean);', {
            id: 1,
            k: 1,
            ёk: true,
         })
         assert.equal(row.k, 1)
      })
   })

   // Metadata merging also restores the declared schema; pins/system.test.ts allows either shape.
   test('introspection reports a table under its own schema again', async () => {
      const { app: seeded }: { app: LiteApp } = await newApp()
      const tables = (await get(seeded, '/_system/introspect')).body.tables as { name: string; schema?: string }[]

      const users = tables.find((t) => t.name === 'users' && t.schema === 'auth')
      assert.ok(users, `no table named users in schema auth: ${JSON.stringify(tables.map((t) => t.name))}`)
   })
})
