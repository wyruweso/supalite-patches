// SELECT: columns, ordering, limits, aggregates.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get } from '../test/harness.ts'
import type { LiteApp } from '../test/harness.ts'

let app: LiteApp
before(async () => ({ app } = await newApp()))

describe('select', () => {
   test('returns all columns', async () => {
      const r = await get(app, '/rest/v1/books')
      assert.equal(r.status, 200)
      assert.equal(r.body.length, 3)
      assert.ok('title' in r.body[0] && 'pages' in r.body[0])
   })

   test('projects named columns only', async () => {
      const r = await get(app, '/rest/v1/books?select=id,title')
      assert.deepEqual(Object.keys(r.body[0]).sort(), ['id', 'title'])
   })

   test('renames columns with alias:column', async () => {
      const r = await get(app, '/rest/v1/books?select=book:id,name:title')
      assert.deepEqual(Object.keys(r.body[0]).sort(), ['book', 'name'])
   })

   test('reads through a view', async () => {
      const r = await get(app, '/rest/v1/top_books?select=id,title')
      assert.equal(r.status, 200)
      assert.equal(r.body.length, 3)
   })
})

describe('embeds', () => {
   test('to-one embed returns an object', async () => {
      const r = await get(app, '/rest/v1/books?select=title,authors(name)&id=eq.1')
      assert.equal(r.status, 200)
      assert.equal(r.body[0].authors.name, 'Ursula')
   })

   test('to-many embed returns an array', async () => {
      const r = await get(app, '/rest/v1/books?select=title,reviews(stars)&id=eq.1')
      assert.ok(Array.isArray(r.body[0].reviews))
      assert.equal(r.body[0].reviews.length, 2)
   })

   test('!inner filters the parent by the embed', async () => {
      const r = await get(app, '/rest/v1/books?select=title,authors!inner(name)&authors.name=eq.Borges')
      assert.equal(r.body.length, 1)
      assert.equal(r.body[0].title, 'Ficciones')
   })

   test('spread embed flattens into the parent', async () => {
      const r = await get(app, '/rest/v1/books?select=title,...authors(name)&id=eq.1')
      assert.equal(r.body[0].name, 'Ursula')
      assert.ok(!('authors' in r.body[0]))
   })

   test('nested embed descends two levels', async () => {
      const r = await get(app, '/rest/v1/reviews?select=stars,books(title,authors(name))&id=eq.1')
      assert.equal(r.body[0].books.authors.name, 'Ursula')
   })
})

describe('order, paging and count', () => {
   test('orders ascending', async () => {
      const r = await get(app, '/rest/v1/books?select=id&order=id.asc')
      assert.deepEqual(
         r.body.map((x: { id: number }) => x.id),
         [1, 2, 3],
      )
   })

   test('orders descending', async () => {
      const r = await get(app, '/rest/v1/books?select=id&order=id.desc')
      assert.deepEqual(
         r.body.map((x: { id: number }) => x.id),
         [3, 2, 1],
      )
   })

   test('nullsfirst places nulls before values', async () => {
      const r = await get(app, '/rest/v1/books?select=id,pages&order=pages.asc.nullsfirst')
      assert.equal(r.body[0].pages, null)
   })

   test('limit and offset page the result', async () => {
      const r = await get(app, '/rest/v1/books?select=id&order=id.asc&limit=2&offset=1')
      assert.deepEqual(
         r.body.map((x: { id: number }) => x.id),
         [2, 3],
      )
   })

   test('Prefer count=exact reports the total in Content-Range', async () => {
      const r = await get(app, '/rest/v1/books?select=id', { Prefer: 'count=exact' })
      assert.match(r.contentRange ?? '', /\/3$/)
   })

   test('Range header limits the window', async () => {
      const r = await get(app, '/rest/v1/books?select=id&order=id.asc', { Range: '0-1' })
      assert.equal(r.body.length, 2)
   })
})
