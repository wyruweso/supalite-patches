// How values cross the wire, per type.
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, pgrstCode, type LiteApp, type LiteConnection } from '../test/harness.ts'

const SCHEMA = `CREATE TABLE items (
   id int primary key, tags text[], nums int[], meta jsonb, ok boolean,
   born date, at timestamptz, price numeric(8,2), ip inet
);`
const REPRESENT = { Prefer: 'return=representation' }

async function itemsApp() {
   const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
   await (await connection.createMigrator(SCHEMA)).migrate()
   return app
}

async function itemsAppWithStorage() {
   const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
   await (await connection.createMigrator(SCHEMA)).migrate()
   const stored = async (column: string, id: number): Promise<unknown> => {
      const result = (await connection.exec(`SELECT ${column} AS v FROM items WHERE id = ${id}`)) as {
         rows: { v: unknown }[]
      }
      return result.rows[0]?.v
   }
   return { app, stored }
}

describe('what comes back out', () => {
   let app: LiteApp
   before(async () => {
      app = await itemsApp()
      await post(
         app,
         '/rest/v1/items',
         {
            id: 1,
            tags: ['a', 'b'],
            nums: [1, 2],
            meta: { x: { y: 1 } },
            ok: true,
            born: '1990-05-04',
            at: '2024-01-02T03:04:05Z',
            price: 12.34,
            ip: '10.0.0.1',
         },
         REPRESENT,
      )
   })

   test('dates and timestamps are returned exactly as they were stored', async () => {
      const row = (await get(app, '/rest/v1/items?id=eq.1&select=born,at')).body[0]
      assert.equal(row.born, '1990-05-04')
      assert.equal(row.at, '2024-01-02T03:04:05Z')
   })

   test('a numeric within its declared precision round trips as a number', async () => {
      assert.equal((await get(app, '/rest/v1/items?id=eq.1&select=price')).body[0].price, 12.34)
   })

   test('inet round trips as its text form', async () => {
      assert.equal((await get(app, '/rest/v1/items?id=eq.1&select=ip')).body[0].ip, '10.0.0.1')
   })
})

describe('boolean coercion on the way in', () => {
   let app: LiteApp
   let stored: (column: string, id: number) => Promise<unknown>
   before(async () => {
      ;({ app, stored } = await itemsAppWithStorage())
   })

   for (const [id, input, expected] of [
      [1, true, 1],
      [2, false, 0],
      [3, 'yes', 1],
      [4, 'no', 0],
      [5, 'false', 0],
      [6, 0, 0],
      [7, 1, 1],
      [8, null, null],
   ] as const)
      test(`ok: ${JSON.stringify(input)} is stored as ${JSON.stringify(expected)}`, async () => {
         const r = await post(app, '/rest/v1/items', { id, ok: input }, REPRESENT)
         assert.equal(r.status, 201)
         assert.equal(await stored('ok', id), expected)
      })
})

describe('array filters', () => {
   let app: LiteApp
   before(async () => {
      app = await itemsApp()
      await post(app, '/rest/v1/items', { id: 1, tags: ['a', 'b'] }, REPRESENT)
      await post(app, '/rest/v1/items', { id: 2, tags: ['c'] }, REPRESENT)
   })

   test('cs. matches a row whose array contains the given elements', async () => {
      assert.deepEqual((await get(app, '/rest/v1/items?tags=cs.{a}&select=id')).body, [{ id: 1 }])
   })

   test('cd. matches every row whose array is contained by the given set', async () => {
      assert.deepEqual((await get(app, '/rest/v1/items?tags=cd.{a,b,c}&select=id&order=id')).body, [
         { id: 1 },
         { id: 2 },
      ])
   })

   test('cd. excludes a row with an element outside the given set', async () => {
      assert.deepEqual((await get(app, '/rest/v1/items?tags=cd.{a,b}&select=id&order=id')).body, [{ id: 1 }])
   })

   test('ov. matches a row whose array overlaps the given set', async () => {
      assert.deepEqual((await get(app, '/rest/v1/items?tags=ov.{b,z}&select=id')).body, [{ id: 1 }])
   })

   test('a non-matching containment filter returns nothing', async () => {
      assert.deepEqual((await get(app, '/rest/v1/items?tags=cs.{z}&select=id')).body, [])
   })
})

describe('nulls and empties', () => {
   let app: LiteApp
   let stored: (column: string, id: number) => Promise<unknown>
   beforeEach(async () => {
      ;({ app, stored } = await itemsAppWithStorage())
   })

   test('a null array is stored as null, not as an empty array', async () => {
      const r = await post(app, '/rest/v1/items', { id: 1, tags: null }, REPRESENT)
      assert.equal(r.body[0].tags, null)
   })

   test('an empty array is stored as an empty JSON array', async () => {
      const r = await post(app, '/rest/v1/items', { id: 2, tags: [] }, REPRESENT)
      assert.equal(r.status, 201)
      assert.equal(await stored('tags', 2), '[]')
   })

   test('omitted columns come back as null', async () => {
      const r = await post(app, '/rest/v1/items', { id: 3 }, REPRESENT)
      for (const column of ['tags', 'nums', 'meta', 'ok', 'born', 'at', 'price', 'ip'])
         assert.equal(r.body[0][column], null, column)
   })
})

describe('values the CHECK constraints reject', () => {
   let app: LiteApp
   let stored: (column: string, id: number) => Promise<unknown>
   beforeEach(async () => {
      ;({ app, stored } = await itemsAppWithStorage())
   })

   test('a NAMED constraint violation is a proper 400 with a PostgREST code', async () => {
      const r = await post(app, '/rest/v1/items', { id: 1, nums: 'not-an-array' }, REPRESENT)
      assert.equal(r.status, 400)
      assert.equal(pgrstCode(r), '23514')
      assert.match(r.body.message, /check constraint "array_type" violated for items\.nums/)
   })

   test('a bare string in a jsonb column is accepted, JSON-encoded', async () => {
      const r = await post(app, '/rest/v1/items', { id: 4, meta: 'plain string' }, REPRESENT)
      assert.equal(r.status, 201)
      assert.equal(await stored('meta', 4), '"plain string"')
   })
})

describe('bytea columns are unreachable over REST', () => {
   let app: LiteApp
   let connection: LiteConnection

   before(async () => {
      ;({ app, connection } = await newApp({ seed: false }))
      await (await connection.createMigrator('CREATE TABLE files (id int primary key, blob bytea);')).migrate()
   })

   test('bytea becomes a real BLOB column, not TEXT', async () => {
      const { ddl } = await connection.translateDdl('CREATE TABLE t (b bytea);')
      assert.match(ddl, /b BLOB/)
   })

   for (const [label, value] of [
      ['a postgres hex literal', String.fromCharCode(92) + 'x48656c6c6f'],
      ['a plain string', 'Hello'],
      ['base64', 'SGVsbG8='],
   ] as const)
      test(`${label} is refused with a TEXT-into-BLOB error`, async () => {
         const r = await post(app, '/rest/v1/files', { id: Math.floor(Math.random() * 1e6), blob: value }, REPRESENT)
         assert.equal(r.status, 500)
         assert.equal(pgrstCode(r), 'SUP')
         assert.match(r.body.message, /cannot store TEXT value in BLOB column files\.blob/)
      })

   test('an array of byte values fails earlier still, at parameter binding', async () => {
      const r = await post(app, '/rest/v1/files', { id: 10, blob: [72, 101, 108] }, REPRESENT)
      assert.equal(r.status, 500)
      assert.match(r.body.message, /Cannot bind value at parameter/)
   })

   test('null is the only value REST can write', async () => {
      const r = await post(app, '/rest/v1/files', { id: 11, blob: null }, REPRESENT)
      assert.equal(r.status, 201)
      assert.equal(r.body[0].blob, null)
   })

   test('bytes written through the connection read back as a numeric-keyed object', async () => {
      await connection.exec('INSERT INTO files (id, blob) VALUES (?, ?)', 99, new Uint8Array([0xde, 0xad]))
      const r = await get(app, '/rest/v1/files?id=eq.99&select=blob')
      assert.deepEqual(r.body, [{ blob: { 0: 222, 1: 173 } }])
   })
})
