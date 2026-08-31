// Surfaces the package answers by refusing, and how.
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { newApp, get, post } from '../test/harness.ts'
import type { LiteApp } from '../test/harness.ts'

let app: LiteApp
before(async () => ({ app } = await newApp()))

type Attempt = { threw?: string; status?: number; body?: any }

const attempt = async (path: string): Promise<Attempt> => {
   try {
      return await get(app, path)
   } catch (e) {
      return { threw: e instanceof Error ? e.message : String(e) }
   }
}

describe('full-text search: silently matches nothing', () => {
   for (const op of ['fts', 'plfts', 'phfts', 'wfts']) {
      test(`${op} returns no rows rather than erroring`, async () => {
         const r = await get(app, `/rest/v1/books?select=id&title=${op}.wizard`)
         assert.equal(r.status, 200)
         assert.deepEqual(r.body, [])
      })
   }
})

describe('regex: GLOB-translatable patterns work, the rest are refused', () => {
   test('an anchored literal pattern DOES filter', async () => {
      const r = await get(app, '/rest/v1/books?select=id&title=match.^A')
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [{ id: 2 }])
   })

   test('a bare substring pattern DOES filter', async () => {
      const r = await get(app, '/rest/v1/books?select=id&title=match.Wiz')
      assert.deepEqual(r.body, [{ id: 2 }])
   })

   test('imatch is case-insensitive and works', async () => {
      const r = await get(app, '/rest/v1/books?select=id&title=imatch.^a')
      assert.deepEqual(r.body, [{ id: 2 }])
   })

   test('alternation is refused as an unsupported operator', async () => {
      const r = await attempt('/rest/v1/books?select=id&title=match.^(A|T)')
      assert.ok(r.threw || (r.status ?? 0) >= 400, 'metacharacter regex unexpectedly succeeded')
      if (r.threw) assert.match(r.threw, /Unsupported operator/)
   })

   test('a character class is refused', async () => {
      const r = await attempt('/rest/v1/books?select=id&title=match.W[ai]z')
      assert.ok(r.threw || (r.status ?? 0) >= 400)
   })
})

describe('rpc() is not supported on the SQLite path', () => {
   test('calling any function fails', async () => {
      const r = await post(app, '/rest/v1/rpc/anything', {})
      assert.ok(r.status >= 400)
   })
})

describe('range and quantified operators are not implemented', () => {
   for (const op of ['sl', 'sr', 'nxl', 'nxr', 'adj']) {
      test(`range operator ${op} does not filter`, async () => {
         const r = await attempt(`/rest/v1/books?select=id&pages=${op}.(1,500)`)
         assert.ok(r.threw || (r.status ?? 0) >= 400 || r.body?.length === 0)
      })
   }

   test('quantified eq(any) does not filter', async () => {
      const r = await attempt('/rest/v1/books?select=id&id=eq(any).{1,2}')
      assert.ok(r.threw || (r.status ?? 0) >= 400 || r.body?.length === 0)
   })
})

describe('aggregate functions are refused', () => {
   test('sum() is PGRST123', async () => {
      const r = await get(app, '/rest/v1/books?select=author_id,pages.sum()')
      assert.ok(r.status >= 400)
      assert.equal(r.body.code, 'PGRST123')
   })
})

describe('SQLite is single-schema', () => {
   test('an unknown Accept-Profile is refused', async () => {
      const r = await get(app, '/rest/v1/books', { 'Accept-Profile': 'other' })
      assert.ok(r.status >= 400)
   })
})

describe('only github and google OAuth providers exist', () => {
   for (const provider of ['apple', 'azure', 'discord', 'twitter']) {
      test(`${provider} is not implemented`, async () => {
         const r = await get(app, `/auth/v1/authorize?provider=${provider}`)
         assert.ok(r.status >= 400, `${provider} unexpectedly authorized`)
      })
   }
})

describe('auth features listed as planned are absent', () => {
   test('MFA enrollment is not available', async () => {
      const r = await post(app, '/auth/v1/factors', { factor_type: 'totp' })
      assert.ok(r.status >= 400)
   })
})
