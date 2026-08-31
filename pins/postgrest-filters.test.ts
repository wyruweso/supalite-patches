// The filter operators, on every column type that takes them.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get } from '../test/harness.ts'
import type { LiteApp } from '../test/harness.ts'

let app: LiteApp
before(async () => ({ app } = await newApp()))
const ids = async (q: string): Promise<number[]> =>
   (await get(app, `/rest/v1/books?select=id&order=id.asc&${q}`)).body.map((x: { id: number }) => x.id)

describe('comparison operators', () => {
   test('eq', async () => assert.deepEqual(await ids('id=eq.2'), [2]))
   test('neq', async () => assert.deepEqual(await ids('id=neq.2'), [1, 3]))
   test('gt', async () => assert.deepEqual(await ids('id=gt.2'), [3]))
   test('gte', async () => assert.deepEqual(await ids('id=gte.2'), [2, 3]))
   test('lt', async () => assert.deepEqual(await ids('id=lt.2'), [1]))
   test('lte', async () => assert.deepEqual(await ids('id=lte.2'), [1, 2]))
   test('in', async () => assert.deepEqual(await ids('id=in.(1,3)'), [1, 3]))
})

describe('null handling', () => {
   test('is.null matches the null column', async () => assert.deepEqual(await ids('pages=is.null'), [3]))
   test('not.is.null is the complement', async () => assert.deepEqual(await ids('pages=not.is.null'), [1, 2]))
})

describe('pattern matching', () => {
   test('like is case-sensitive', async () => assert.deepEqual(await ids('title=like.*Wizard*'), [2]))
   test('like does not match the wrong case', async () => assert.deepEqual(await ids('title=like.*wizard*'), []))
   test('ilike is case-insensitive', async () => assert.deepEqual(await ids('title=ilike.*wizard*'), [2]))
})

describe('logical composition', () => {
   test('or', async () => assert.deepEqual(await ids('or=(id.eq.1,id.eq.3)'), [1, 3]))
   test('and', async () => assert.deepEqual(await ids('and=(id.gte.2,pages.not.is.null)'), [2]))
   test('not.or negates the group', async () => assert.deepEqual(await ids('not.or=(id.eq.1,id.eq.2)'), [3]))
})

describe('numeric and date columns', () => {
   test('filters on a real column', async () => assert.deepEqual(await ids('price=gte.9.99'), [1, 3]))
   test('filters on a text date column', async () => assert.deepEqual(await ids('published=lt.1970-01-01'), [2, 3]))
})

describe('filters combined with other clauses', () => {
   test('filter plus order plus limit', async () => {
      const r = await get(app, '/rest/v1/books?select=id&id=gte.1&order=id.desc&limit=1')
      assert.deepEqual(
         r.body.map((x: { id: number }) => x.id),
         [3],
      )
   })

   test('filter applies to an embedded array', async () => {
      const r = await get(app, '/rest/v1/books?select=title,reviews(stars)&id=eq.1&reviews.stars=eq.5')
      assert.equal(r.body[0].reviews.length, 1)
      assert.equal(r.body[0].reviews[0].stars, 5)
   })
})
