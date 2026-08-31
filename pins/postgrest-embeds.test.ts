// Resource embedding through foreign keys.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, type LiteApp } from '../test/harness.ts'

const SCHEMA = [
   'CREATE TABLE authors (id integer primary key, name text, country text)',
   'CREATE TABLE books (id integer primary key, author_id integer references authors(id), title text, pages integer)',
   'CREATE TABLE reviews (id integer primary key, book_id integer references books(id), stars integer, reviewer text)',
   'CREATE TABLE profiles (id integer primary key, author_id integer unique references authors(id), bio text)',
]

let app: LiteApp

before(async () => {
   const made = await newApp({ seed: false })
   app = made.app
   for (const ddl of SCHEMA) await made.connection.exec(ddl)
   await post(app, '/rest/v1/authors', [
      { id: 1, name: 'Ursula', country: 'US' },
      { id: 2, name: 'Borges', country: 'AR' },
   ])
   await post(app, '/rest/v1/books', [
      { id: 1, author_id: 1, title: 'Dispossessed', pages: 341 },
      { id: 2, author_id: 1, title: 'Earthsea', pages: 183 },
      { id: 3, author_id: 2, title: 'Ficciones', pages: null },
   ])
   await post(app, '/rest/v1/reviews', [
      { id: 1, book_id: 1, stars: 5, reviewer: 'a' },
      { id: 2, book_id: 1, stars: 3, reviewer: 'b' },
      { id: 3, book_id: 3, stars: 4, reviewer: 'a' },
   ])
   await post(app, '/rest/v1/profiles', [{ id: 1, author_id: 1, bio: 'sf' }])
})

describe('spread embeds', () => {
   test('a to-one spread lifts the child column onto the parent row', async () => {
      assert.deepEqual((await get(app, '/rest/v1/books?select=title,...authors(name)&order=id')).body, [
         { title: 'Dispossessed', name: 'Ursula' },
         { title: 'Earthsea', name: 'Ursula' },
         { title: 'Ficciones', name: 'Borges' },
      ])
   })

   test('a spread column can be renamed', async () => {
      assert.deepEqual((await get(app, '/rest/v1/books?select=title,...authors(author_name:name)&order=id')).body, [
         { title: 'Dispossessed', author_name: 'Ursula' },
         { title: 'Earthsea', author_name: 'Ursula' },
         { title: 'Ficciones', author_name: 'Borges' },
      ])
   })

   test('several columns can be spread at once', async () => {
      assert.deepEqual((await get(app, '/rest/v1/books?select=title,...authors(name,country)&order=id')).body[0], {
         title: 'Dispossessed',
         name: 'Ursula',
         country: 'US',
      })
   })

   test('a one-to-one relationship spreads in the reverse direction, nulls included', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select=name,...profiles(bio)&order=id')).body, [
         { name: 'Ursula', bio: 'sf' },
         { name: 'Borges', bio: null },
      ])
   })

   test('a spread nested inside an embed flattens only that level', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/reviews?select=stars,books(title,...authors(name))&order=id')).body[0],
         {
            stars: 5,
            books: { title: 'Dispossessed', name: 'Ursula' },
         },
      )
   })
})

describe('nested embeds', () => {
   test('an embed two levels deep nests two objects', async () => {
      assert.deepEqual((await get(app, '/rest/v1/reviews?select=stars,books(title,authors(name))&order=id')).body[0], {
         stars: 5,
         books: { title: 'Dispossessed', authors: { name: 'Ursula' } },
      })
   })

   test('limit applies per parent, not to the whole result', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select=name,books(title)&books.limit=1&order=id')).body, [
         { name: 'Ursula', books: [{ title: 'Dispossessed' }] },
         { name: 'Borges', books: [{ title: 'Ficciones' }] },
      ])
   })

   test('a count embed counts the children of each parent', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select=name,books(count)&order=id')).body, [
         { name: 'Ursula', books: [{ count: 2 }] },
         { name: 'Borges', books: [{ count: 1 }] },
      ])
   })

   test('the parent can be ordered by an embedded column', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title,authors(name)&order=authors(name).asc')).body.map(
            (r: any) => r.title,
         ),
         ['Ficciones', 'Dispossessed', 'Earthsea'],
      )
   })
})

describe('filters that cross a join', () => {
   test('a filter on an embedded column nulls the embed rather than dropping the parent', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title,authors(name)&authors.name=eq.Ursula&order=id')).body,
         [
            { title: 'Dispossessed', authors: { name: 'Ursula' } },
            { title: 'Earthsea', authors: { name: 'Ursula' } },
            { title: 'Ficciones', authors: null },
         ],
      )
   })

   test('!inner turns the same filter into a restriction on the parent', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title,authors!inner(name)&authors.country=eq.AR&order=id')).body,
         [{ title: 'Ficciones', authors: { name: 'Borges' } }],
      )
   })

   test('an `or` scoped to the embed filters the children only', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title,reviews(stars)&reviews.or=(stars.eq.5,stars.eq.3)&order=id'))
            .body,
         [
            { title: 'Dispossessed', reviews: [{ stars: 5 }, { stars: 3 }] },
            { title: 'Earthsea', reviews: [] },
            { title: 'Ficciones', reviews: [] },
         ],
      )
   })
})

describe('logic trees on the parent', () => {
   test('or combines two predicates, null-safely', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title&or=(pages.gt.300,pages.is.null)&order=id')).body.map(
            (r: any) => r.title,
         ),
         ['Dispossessed', 'Ficciones'],
      )
   })

   test('and is available explicitly as well as by repeating parameters', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title&and=(pages.gt.100,pages.lt.400)&order=id')).body.map(
            (r: any) => r.title,
         ),
         ['Dispossessed', 'Earthsea'],
      )
   })

   test('repeating a filter on one column ANDs the two bounds', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title&pages=gte.183&pages=lte.341&order=id')).body.map(
            (r: any) => r.title,
         ),
         ['Dispossessed', 'Earthsea'],
      )
   })

   test('not.and negates the group, and a NULL row stays excluded', async () => {
      assert.deepEqual(
         (await get(app, '/rest/v1/books?select=title&not.and=(pages.gt.100,pages.lt.200)&order=id')).body.map(
            (r: any) => r.title,
         ),
         ['Dispossessed'],
      )
   })
})
