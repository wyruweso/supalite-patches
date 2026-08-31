// The select= grammar itself, including what it rejects.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post, pgrstCode, type LiteApp } from '../test/harness.ts'

const SCHEMA = [
   'CREATE TABLE authors (id integer primary key, name text not null, rating real)',
   'CREATE TABLE books (id integer primary key, author_id integer references authors(id), editor_id integer references authors(id), title text not null, pages integer)',
   'CREATE TABLE reviews (id integer primary key, book_id integer references books(id), stars integer)',
]

let app: LiteApp

before(async () => {
   const made = await newApp({ seed: false })
   app = made.app
   for (const ddl of SCHEMA) await made.connection.exec(ddl)
   await post(app, '/rest/v1/authors', [
      { id: 1, name: 'Ursula', rating: 4.8 },
      { id: 2, name: 'Borges', rating: 4.9 },
   ])
   await post(app, '/rest/v1/books', [
      { id: 1, author_id: 1, editor_id: 2, title: 'Dispossessed', pages: 341 },
      { id: 2, author_id: 2, editor_id: 1, title: 'Ficciones', pages: null },
   ])
   await post(app, '/rest/v1/reviews', [
      { id: 1, book_id: 1, stars: 5 },
      { id: 2, book_id: 1, stars: 4 },
   ])
})

describe('casts and aliases', () => {
   test('::text renders a number as a string', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select=id::text&order=id')).body, [{ id: '1' }, { id: '2' }])
   })

   test('::int truncates a real rather than rounding it', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select=rating::int&order=id')).body, [
         { rating: 4 },
         { rating: 4 },
      ])
   })

   test('an alias and a cast combine, and the alias names the output', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select=n:name::text&order=id')).body, [
         { n: 'Ursula' },
         { n: 'Borges' },
      ])
   })

   test('a double-quoted column name is accepted', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select="name"&order=id')).body, [
         { name: 'Ursula' },
         { name: 'Borges' },
      ])
   })

   test('whitespace around the column list is tolerated', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select= id , name &order=id')).body, [
         { id: 1, name: 'Ursula' },
         { id: 2, name: 'Borges' },
      ])
   })

   test('an empty select returns every column', async () => {
      const r = await get(app, '/rest/v1/authors?select=&order=id')
      assert.deepEqual(Object.keys(r.body[0]).sort(), ['id', 'name', 'rating'])
   })

   test('a column named twice appears once', async () => {
      assert.deepEqual((await get(app, '/rest/v1/authors?select=name,name&order=id')).body, [
         { name: 'Ursula' },
         { name: 'Borges' },
      ])
   })
})

describe('ambiguous embeds', () => {
   test('an unqualified embed with two candidate FKs is PGRST201, status 300', async () => {
      const r = await get(app, '/rest/v1/books?select=title,authors(name)&order=id')
      assert.equal(r.status, 300)
      assert.equal(pgrstCode(r), 'PGRST201')
      assert.equal(r.body.details.length, 2)
   })

   test('the candidates name both foreign keys and their cardinality', async () => {
      const r = await get(app, '/rest/v1/books?select=title,authors(name)')
      const relationships = r.body.details.map((d: any) => d.relationship)
      assert.ok(
         relationships.some((rel: string) => rel.includes('books(author_id)')),
         'author_id candidate missing',
      )
      assert.ok(
         relationships.some((rel: string) => rel.includes('books(editor_id)')),
         'editor_id candidate missing',
      )
      for (const detail of r.body.details) assert.equal(detail.cardinality, 'many-to-one')
   })

   test('`*` alongside an ambiguous embed is still ambiguous', async () => {
      assert.equal((await get(app, '/rest/v1/books?select=*,authors(name)')).status, 300)
   })
})

describe('embed hints', () => {
   test('a hint naming the constraint resolves the ambiguity', async () => {
      const r = await get(app, '/rest/v1/books?select=title,authors!books_author_id_fkey(name)&order=id')
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [
         { title: 'Dispossessed', authors: { name: 'Ursula' } },
         { title: 'Ficciones', authors: { name: 'Borges' } },
      ])
   })

   test('a hint naming the column resolves it too, and an alias renames the result', async () => {
      const r = await get(app, '/rest/v1/books?select=title,author:authors!author_id(name)&order=id')
      assert.deepEqual(r.body, [
         { title: 'Dispossessed', author: { name: 'Ursula' } },
         { title: 'Ficciones', author: { name: 'Borges' } },
      ])
   })

   test('the other foreign key selects the other relationship', async () => {
      const r = await get(app, '/rest/v1/books?select=title,editor:authors!editor_id(name)&order=id')
      assert.deepEqual(r.body, [
         { title: 'Dispossessed', editor: { name: 'Borges' } },
         { title: 'Ficciones', editor: { name: 'Ursula' } },
      ])
   })

   test('both relationships can be embedded in one query', async () => {
      const r = await get(
         app,
         '/rest/v1/books?select=title,author:authors!author_id(name),editor:authors!editor_id(name)&order=id',
      )
      assert.equal(r.status, 200)
      assert.deepEqual(r.body[0], { title: 'Dispossessed', author: { name: 'Ursula' }, editor: { name: 'Borges' } })
   })
})

describe('join modifiers', () => {
   test('!left keeps parents with no children, as an empty array', async () => {
      const r = await get(app, '/rest/v1/books?select=title,reviews!left(stars)&order=id')
      assert.deepEqual(r.body, [
         { title: 'Dispossessed', reviews: [{ stars: 5 }, { stars: 4 }] },
         { title: 'Ficciones', reviews: [] },
      ])
   })

   test('!inner drops parents with no children entirely', async () => {
      const r = await get(app, '/rest/v1/books?select=title,reviews!inner(stars)&order=id')
      assert.deepEqual(r.body, [{ title: 'Dispossessed', reviews: [{ stars: 5 }, { stars: 4 }] }])
   })
})

describe('filtering and shaping an embed', () => {
   test('a filter on the embedded table narrows the children, not the parents', async () => {
      const r = await get(app, '/rest/v1/books?select=title,reviews(stars)&reviews.stars=eq.5&order=id')
      assert.deepEqual(r.body, [
         { title: 'Dispossessed', reviews: [{ stars: 5 }] },
         { title: 'Ficciones', reviews: [] },
      ])
   })

   test('order and limit apply within the embed', async () => {
      const r = await get(
         app,
         '/rest/v1/books?select=title,reviews(stars)&reviews.order=stars.desc&reviews.limit=1&order=id',
      )
      assert.deepEqual(r.body[0].reviews, [{ stars: 5 }])
   })

   test('count inside an embed returns a per-parent count, zero included', async () => {
      const r = await get(app, '/rest/v1/books?select=title,reviews(count)&order=id')
      assert.deepEqual(r.body, [
         { title: 'Dispossessed', reviews: [{ count: 2 }] },
         { title: 'Ficciones', reviews: [{ count: 0 }] },
      ])
   })
})

describe('embeds that cannot be resolved', () => {
   test('an unknown table is PGRST200', async () => {
      const r = await get(app, '/rest/v1/books?select=title,nope(x)')
      assert.equal(r.status, 400)
      assert.equal(pgrstCode(r), 'PGRST200')
      assert.match(r.body.message, /Could not find a relationship/)
   })

   test('the PGRST200 detail names the schema as "test", which is not a schema that exists', async () => {
      const r = await get(app, '/rest/v1/books?select=title,nope(x)')
      assert.match(r.body.details, /in the schema 'test'/)
   })
})
