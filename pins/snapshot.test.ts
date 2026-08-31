// Exact-response snapshots against the published build, field for field. Regenerate with `node pins/snapshot.test.ts --update`.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newApp, req } from '../test/harness.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAP = join(HERE, '__snapshots__', 'responses.json')

const redact = (s: string): string =>
   String(s)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '<ts>')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
      .replace(/sb_(publishable|secret)_[A-Za-z0-9_-]+/g, '<key>')
      .replace(/[0-9a-f]{32,}/gi, '<hex>')
      .replace(/"expires_at":\s*\d+/g, '"expires_at":"<exp>"')

function stable(v: any): any {
   if (v === null || typeof v !== 'object') return v
   if (Array.isArray(v)) return v.map(stable)
   const o: Record<string, any> = {}
   for (const k of Object.keys(v).sort()) o[k] = stable(v[k])
   return o
}

type Case = [name: string, method: string, path: string, body?: unknown, headers?: Record<string, string>]

const CASES: Case[] = [
   ['select all', 'GET', '/rest/v1/books?select=*&order=id.asc'],
   ['select projection', 'GET', '/rest/v1/books?select=id,title&order=id.asc'],
   ['select rename', 'GET', '/rest/v1/books?select=book:id,name:title&order=id.asc'],
   ['embed to-one', 'GET', '/rest/v1/books?select=title,authors(name)&order=id.asc'],
   ['embed to-many', 'GET', '/rest/v1/books?select=title,reviews(stars)&order=id.asc'],
   ['embed spread', 'GET', '/rest/v1/books?select=title,...authors(name)&order=id.asc'],
   ['embed nested', 'GET', '/rest/v1/reviews?select=stars,books(title,authors(name))&order=id.asc'],
   ['embed inner filtered', 'GET', '/rest/v1/books?select=title,authors!inner(name)&authors.name=eq.Borges'],
   ['filter in', 'GET', '/rest/v1/books?select=id&id=in.(1,3)&order=id.asc'],
   ['filter like', 'GET', '/rest/v1/books?select=id,title&title=like.*Wizard*'],
   ['filter ilike', 'GET', '/rest/v1/books?select=id,title&title=ilike.*wizard*'],
   ['filter is null', 'GET', '/rest/v1/books?select=id&pages=is.null'],
   ['filter or', 'GET', '/rest/v1/books?select=id&or=(id.eq.1,id.eq.3)&order=id.asc'],
   ['filter regex glob-able', 'GET', '/rest/v1/books?select=id&title=match.^A'],
   ['order desc nullsfirst', 'GET', '/rest/v1/books?select=id,pages&order=pages.desc.nullsfirst'],
   ['limit offset', 'GET', '/rest/v1/books?select=id&order=id.asc&limit=2&offset=1'],
   ['view read', 'GET', '/rest/v1/top_books?select=*&order=id.asc'],
   ['csv output', 'GET', '/rest/v1/books?select=id,title&order=id.asc', undefined, { Accept: 'text/csv' }],
   [
      'single object',
      'GET',
      '/rest/v1/books?id=eq.1&select=id,title',
      undefined,
      { Accept: 'application/vnd.pgrst.object+json' },
   ],
   ['openapi root', 'GET', '/rest/v1/'],

   [
      'insert representation',
      'POST',
      '/rest/v1/reviews',
      { id: 50, book_id: 2, stars: 3, body: 'snap' },
      { Prefer: 'return=representation' },
   ],
   [
      'patch representation',
      'PATCH',
      '/rest/v1/reviews?id=eq.1',
      { body: 'patched' },
      { Prefer: 'return=representation' },
   ],
   ['delete representation', 'DELETE', '/rest/v1/reviews?id=eq.2', undefined, { Prefer: 'return=representation' }],

   ['error unknown table', 'GET', '/rest/v1/nope'],
   ['error unknown column', 'GET', '/rest/v1/books?select=nope'],
   ['error bad select', 'GET', '/rest/v1/books?select=id,,'],
   ['error ragged batch', 'POST', '/rest/v1/reviews', [{ id: 60, stars: 1 }, { id: 61 }]],
   ['error aggregate', 'GET', '/rest/v1/books?select=author_id,pages.sum()'],
   ['error bad accept', 'GET', '/rest/v1/books', undefined, { Accept: 'application/xml' }],
   ['error bad profile', 'GET', '/rest/v1/books', undefined, { 'Accept-Profile': 'other' }],
   ['error rpc', 'POST', '/rest/v1/rpc/anything', {}],

   ['auth settings', 'GET', '/auth/v1/settings'],
   ['auth signup', 'POST', '/auth/v1/signup', { email: 'snap@b.co', password: 'password123' }],
   ['auth bad password', 'POST', '/auth/v1/token?grant_type=password', { email: 'snap@b.co', password: 'wrong' }],
   ['auth bad grant', 'POST', '/auth/v1/token?grant_type=bogus', {}],
   ['auth user anonymous', 'GET', '/auth/v1/user'],
   ['auth unknown provider', 'GET', '/auth/v1/authorize?provider=apple'],

   ['storage buckets', 'GET', '/storage/v1/bucket'],
   ['storage missing object', 'GET', '/storage/v1/object/none/none.png'],
]

async function capture(): Promise<Record<string, unknown>> {
   const { app } = await newApp()
   const shot: Record<string, unknown> = {}
   for (const [name, method, path, body, headers] of CASES) {
      let r
      try {
         r = await req(app, method, path, body, headers)
      } catch (e) {
         shot[name] = { threw: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e) }
         continue
      }
      shot[name] = JSON.parse(
         redact(
            JSON.stringify(
               stable({ status: r.status, contentType: r.contentType, contentRange: r.contentRange, body: r.body }),
            ),
         ),
      )
   }
   return shot
}

if (process.argv.includes('--update')) {
   const shot = await capture()
   mkdirSync(dirname(SNAP), { recursive: true })
   writeFileSync(SNAP, JSON.stringify(shot, null, 2) + '\n')
   console.log(`wrote ${Object.keys(shot).length} snapshots -> ${SNAP}`)
} else {
   let actual: Record<string, unknown>
   let expected: Record<string, unknown> | null
   before(async () => {
      actual = await capture()
      expected = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : null
   })

   describe('response snapshots match the published build', () => {
      test('the baseline exists', () => {
         assert.ok(expected, 'no baseline; run: node test/snapshot.test.mjs --update against the published build')
      })
      for (const [name] of CASES) {
         test(name, () => {
            assert.deepEqual(actual[name], expected?.[name])
         })
      }
   })
}
