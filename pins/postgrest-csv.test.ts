// The text/csv request and response paths.
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, req, pgrstCode, type LiteApp } from '../test/harness.ts'

const CSV_IN = { 'Content-Type': 'text/csv', Prefer: 'return=representation' }
const rows = (app: LiteApp) => get(app, '/rest/v1/authors?select=id,name,bio&order=id')

describe('csv insert', () => {
   let app: LiteApp
   beforeEach(async () => {
      const made = await newApp({ seed: false })
      app = made.app
      await made.connection.exec(
         'CREATE TABLE authors (id integer primary key, name text not null, bio text, rating real, active integer default 1)',
      )
   })

   test('a header row plus data rows inserts each row', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name\n1,Ursula\n2,Borges', CSV_IN)
      assert.equal(r.status, 201)
      assert.deepEqual(
         r.body.map((row: any) => row.name),
         ['Ursula', 'Borges'],
      )
   })

   test('columns the CSV omits take their table defaults', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name\n1,Ursula', CSV_IN)
      assert.equal(r.body[0].bio, null)
      assert.equal(r.body[0].rating, null)
      assert.equal(r.body[0].active, 1)
   })

   test('a doubled quote inside a quoted field becomes one quote', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name\n1,"O""Brien"', CSV_IN)
      assert.equal(r.body[0].name, 'O"Brien')
   })

   test('a comma inside a quoted field does not split the row', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name,bio\n1,Nemo,"a, b"', CSV_IN)
      assert.equal(r.body[0].bio, 'a, b')
   })

   test('an empty trailing field is read as null, not as an empty string', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name,bio\n1,Nemo,', CSV_IN)
      assert.equal(r.body[0].bio, null)
   })

   test('CRLF line endings are handled', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name\r\n1,CRLF\r\n', CSV_IN)
      assert.equal(r.status, 201)
      assert.equal(r.body[0].name, 'CRLF')
   })

   test('a trailing newline does not produce a phantom row', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name\n1,One\n2,Two\n', CSV_IN)
      assert.equal(r.body.length, 2)
   })

   test('a header with no data rows inserts nothing and still succeeds', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name', CSV_IN)
      assert.equal(r.status, 201)
      assert.deepEqual(r.body, [])
   })

   test('an empty body is a parse error, not an empty insert', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', '', CSV_IN)
      assert.equal(r.status, 400)
      assert.equal(pgrstCode(r), 'PGRST102')
      assert.match(r.body.message, /parse error \(not enough input\)/)
   })

   test('a row with MORE fields than the header silently drops the extras', async () => {
      const r = await req(app, 'POST', '/rest/v1/authors', 'id,name\n1,A,surplus', CSV_IN)
      assert.equal(r.status, 201)
      assert.equal(r.body[0].name, 'A')
   })

   test('the inserted rows are really in the table afterwards', async () => {
      await req(app, 'POST', '/rest/v1/authors', 'id,name\n1,One\n2,Two', { 'Content-Type': 'text/csv' })
      assert.deepEqual(
         (await rows(app)).body.map((row: any) => row.name),
         ['One', 'Two'],
      )
   })
})

describe('csv on other verbs', () => {
   let app: LiteApp
   beforeEach(async () => {
      const made = await newApp({ seed: false })
      app = made.app
      await made.connection.exec(
         'CREATE TABLE authors (id integer primary key, name text not null, bio text, rating real, active integer default 1)',
      )
      await req(app, 'POST', '/rest/v1/authors', 'id,name\n1,Original', { 'Content-Type': 'text/csv' })
   })

   test('PATCH accepts a CSV body', async () => {
      const r = await req(app, 'PATCH', '/rest/v1/authors?id=eq.1', 'name\nRenamed', CSV_IN)
      assert.equal(r.status, 200)
      assert.equal(r.body[0].name, 'Renamed')
   })

   test('a CSV round trip survives quoting in both directions', async () => {
      await req(app, 'POST', '/rest/v1/authors', 'id,name,bio\n2,Quoter,"has, comma"', { 'Content-Type': 'text/csv' })
      const exported = await get(app, '/rest/v1/authors?select=id,name,bio&order=id', { Accept: 'text/csv' })
      assert.match(exported.body, /"has, comma"/)
   })
})
