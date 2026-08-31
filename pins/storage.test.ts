// The /storage/v1 surface, against a Map-backed adapter.
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { newStorageApp, filePart, req, get, post, type StorageApp } from '../test/harness.ts'

describe('buckets', () => {
   let s: StorageApp
   beforeEach(async () => {
      s = await newStorageApp()
   })

   test('the bucket list starts empty', async () => {
      const r = await get(s.app, '/storage/v1/bucket', s.auth)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [])
   })

   test('creating a bucket answers with its name', async () => {
      const r = await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos', public: false }, s.auth)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { name: 'photos' })
   })

   test('a created bucket is then listed and readable', async () => {
      await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
      const list = await get(s.app, '/storage/v1/bucket', s.auth)
      assert.equal(list.body.length, 1)
      assert.equal(list.body[0].id, 'photos')

      const one = await get(s.app, '/storage/v1/bucket/photos', s.auth)
      assert.equal(one.status, 200)
      assert.equal(one.body.name, 'photos')
      assert.equal(one.body.public, false)
      assert.deepEqual(one.body.allowed_mime_types, [])
   })

   test('creating the same bucket twice is a Duplicate', async () => {
      await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
      const again = await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
      assert.equal(again.status, 400)
      assert.equal(again.body.statusCode, '409')
      assert.equal(again.body.error, 'Duplicate')
   })

   test('an unknown bucket reports Bucket not found', async () => {
      const r = await get(s.app, '/storage/v1/bucket/nope', s.auth)
      assert.equal(r.status, 400)
      assert.equal(r.body.statusCode, '404')
      assert.equal(r.body.error, 'Bucket not found')
      assert.match(r.body.message, /nope/)
   })

   test('a bucket can be updated to public', async () => {
      await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
      const update = await req(s.app, 'PUT', '/storage/v1/bucket/photos', { public: true }, s.auth)
      assert.equal(update.status, 200)
      assert.deepEqual(update.body, { message: 'Successfully updated' })
      assert.equal((await get(s.app, '/storage/v1/bucket/photos', s.auth)).body.public, true)
   })

   test('emptying a bucket is acknowledged as queued', async () => {
      await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
      const r = await post(s.app, '/storage/v1/bucket/photos/empty', undefined, s.auth)
      assert.equal(r.status, 200)
      assert.match(r.body.message, /Empty bucket has been queued/)
   })

   test('a bucket can be deleted and is then gone', async () => {
      await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
      const del = await req(s.app, 'DELETE', '/storage/v1/bucket/photos', undefined, s.auth)
      assert.equal(del.status, 200)
      assert.deepEqual(del.body, { message: 'Successfully deleted' })
      assert.equal((await get(s.app, '/storage/v1/bucket/photos', s.auth)).status, 400)
   })
})

describe('objects', () => {
   let s: StorageApp
   beforeEach(async () => {
      s = await newStorageApp()
      await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
   })

   test('an upload answers with the fully qualified key and an id', async () => {
      const r = await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'hello world'), s.auth)
      assert.equal(r.status, 200)
      assert.equal(r.body.Key, 'photos/a.txt')
      assert.match(r.body.Id, /^[0-9a-f-]{36}$/)
   })

   test('the uploaded bytes reach the adapter', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'hello world'), s.auth)
      assert.deepEqual(s.stored(), ['photos/a.txt'])
   })

   test('downloading returns the bytes that went in', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'hello world'), s.auth)
      const r = await get(s.app, '/storage/v1/object/photos/a.txt', s.auth)
      assert.equal(r.status, 200)
      assert.equal(r.body, 'hello world')
   })

   test('a nested key keeps its path', async () => {
      await post(s.app, '/storage/v1/object/photos/nested/deep/a.txt', filePart('a.txt', 'deep'), s.auth)
      assert.deepEqual(s.stored(), ['photos/nested/deep/a.txt'])
      assert.equal((await get(s.app, '/storage/v1/object/photos/nested/deep/a.txt', s.auth)).body, 'deep')
   })

   test('object info reports the row, path tokens included', async () => {
      await post(s.app, '/storage/v1/object/photos/nested/a.txt', filePart('a.txt', 'x'), s.auth)
      const r = await get(s.app, '/storage/v1/object/info/photos/nested/a.txt', s.auth)
      assert.equal(r.status, 200)
      assert.equal(r.body.bucket_id, 'photos')
      assert.equal(r.body.name, 'nested/a.txt')
      assert.deepEqual(r.body.path_tokens, ['nested', 'a.txt'])
      assert.ok(r.body.owner_id)
   })

   test('listing reports the objects in a bucket', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'x'), s.auth)
      await post(s.app, '/storage/v1/object/photos/b.txt', filePart('b.txt', 'y'), s.auth)
      const r = await post(s.app, '/storage/v1/object/list/photos', { prefix: '' }, s.auth)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body.map((o: any) => o.name).sort(), ['a.txt', 'b.txt'])
   })

   test('an object can be replaced with PUT, whose body is raw bytes', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'first'), s.auth)
      const put = await req(s.app, 'PUT', '/storage/v1/object/photos/a.txt', 'second', s.auth)
      assert.equal(put.status, 200)
      assert.equal((await get(s.app, '/storage/v1/object/photos/a.txt', s.auth)).body, 'second')
   })

   test('PUT does not parse multipart, so a form upload is stored envelope and all', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'first'), s.auth)
      await req(s.app, 'PUT', '/storage/v1/object/photos/a.txt', filePart('a.txt', 'second'), s.auth)
      const round = await get(s.app, '/storage/v1/object/photos/a.txt', s.auth)
      assert.match(round.body, /Content-Disposition: form-data; name="file"/)
      assert.match(round.body, /\bsecond\b/)
   })

   test('copy leaves the source in place', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'x'), s.auth)
      const r = await post(
         s.app,
         '/storage/v1/object/copy',
         { bucketId: 'photos', sourceKey: 'a.txt', destinationKey: 'b.txt' },
         s.auth,
      )
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { key: 'b.txt' })
      assert.deepEqual(s.stored().sort(), ['photos/a.txt', 'photos/b.txt'])
   })

   test('move removes the source', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'x'), s.auth)
      const r = await post(
         s.app,
         '/storage/v1/object/move',
         { bucketId: 'photos', sourceKey: 'a.txt', destinationKey: 'c.txt' },
         s.auth,
      )
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, { message: 'Successfully moved' })
      const list = await post(s.app, '/storage/v1/object/list/photos', { prefix: '' }, s.auth)
      assert.deepEqual(
         list.body.map((o: any) => o.name),
         ['c.txt'],
      )
   })

   test('moving something that is not there reports Object not found', async () => {
      const r = await post(
         s.app,
         '/storage/v1/object/move',
         { bucketId: 'photos', sourceKey: 'ghost.txt', destinationKey: 'x.txt' },
         s.auth,
      )
      assert.equal(r.status, 400)
      assert.equal(r.body.statusCode, '404')
      assert.equal(r.body.error, 'Object not found')
   })

   test('delete takes a list of prefixes and returns the rows it removed', async () => {
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'x'), s.auth)
      const r = await req(s.app, 'DELETE', '/storage/v1/object/photos', { prefixes: ['a.txt'] }, s.auth)
      assert.equal(r.status, 200)
      assert.deepEqual(
         r.body.map((o: any) => o.name),
         ['a.txt'],
      )
      assert.deepEqual(s.stored(), [])
   })

   test('deleting something absent removes nothing and does not error', async () => {
      const r = await req(s.app, 'DELETE', '/storage/v1/object/photos', { prefixes: ['ghost.txt'] }, s.auth)
      assert.equal(r.status, 200)
      assert.deepEqual(r.body, [])
   })

   test('uploading to a bucket that does not exist is rejected', async () => {
      const r = await post(s.app, '/storage/v1/object/ghost/a.txt', filePart('a.txt', 'x'), s.auth)
      assert.equal(r.status, 400)
      assert.equal(r.body.statusCode, '404')
   })
})

describe('signed urls', () => {
   let s: StorageApp
   beforeEach(async () => {
      s = await newStorageApp()
      await post(s.app, '/storage/v1/bucket', { id: 'photos', name: 'photos' }, s.auth)
      await post(s.app, '/storage/v1/object/photos/a.txt', filePart('a.txt', 'hello world'), s.auth)
   })

   test('signing returns a relative url carrying a JWT', async () => {
      const r = await post(s.app, '/storage/v1/object/sign/photos/a.txt', { expiresIn: 60 }, s.auth)
      assert.equal(r.status, 200)
      assert.match(r.body.signedUrl, /^\/storage\/v1\/object\/sign\/photos\/a\.txt\?token=/)
      const token = new URL('http://x' + r.body.signedUrl).searchParams.get('token')!
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      assert.equal(claims.sub, 'a.txt')
      assert.equal(claims.bucket, 'photos')
      assert.equal(claims.intent, 'download')
      assert.equal(claims.exp - claims.iat, 60)
   })

   test('a signed url downloads without any Authorization header', async () => {
      const signed = await post(s.app, '/storage/v1/object/sign/photos/a.txt', { expiresIn: 60 }, s.auth)
      const r = await get(s.app, signed.body.signedUrl)
      assert.equal(r.status, 200)
      assert.equal(r.body, 'hello world')
   })

   test('a tampered token is refused', async () => {
      const signed = await post(s.app, '/storage/v1/object/sign/photos/a.txt', { expiresIn: 60 }, s.auth)
      const url = signed.body.signedUrl
      const token = new URL('http://x' + url).searchParams.get('token')!
      const [header, payload, signature] = token.split('.')

      const at = Math.floor(signature.length / 2)
      const tampered = signature.slice(0, at) + (signature[at] === 'A' ? 'B' : 'A') + signature.slice(at + 1)

      const r = await get(s.app, url.replace(token, [header, payload, tampered].join('.')))
      assert.ok(r.status >= 400)
   })

   test('a token re-signed with different claims is refused', async () => {
      const signed = await post(s.app, '/storage/v1/object/sign/photos/a.txt', { expiresIn: 60 }, s.auth)
      const url = signed.body.signedUrl
      const token = new URL('http://x' + url).searchParams.get('token')!
      const [header, payload, signature] = token.split('.')
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
      claims.sub = 'someone-elses-file.txt'
      const forged = [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.')

      const r = await get(s.app, url.replace(token, forged))
      assert.ok(r.status >= 400)
   })

   test('no token at all is refused', async () => {
      const r = await get(s.app, '/storage/v1/object/sign/photos/a.txt')
      assert.ok(r.status >= 400)
   })

   test('signing an absent object is rejected', async () => {
      const r = await post(s.app, '/storage/v1/object/sign/photos/ghost.txt', { expiresIn: 60 }, s.auth)
      assert.equal(r.status, 400)
      assert.equal(r.body.statusCode, '404')
   })
})

describe('public objects', () => {
   let s: StorageApp
   beforeEach(async () => {
      s = await newStorageApp()
   })

   test('a public bucket serves its objects with no credentials', async () => {
      await post(s.app, '/storage/v1/bucket', { id: 'pub', name: 'pub', public: true }, s.auth)
      await post(s.app, '/storage/v1/object/pub/a.txt', filePart('a.txt', 'open'), s.auth)
      const r = await get(s.app, '/storage/v1/object/public/pub/a.txt')
      assert.equal(r.status, 200)
      assert.equal(r.body, 'open')
   })

   test('the public route reports a missing bucket rather than serving it', async () => {
      const r = await get(s.app, '/storage/v1/object/public/ghost/a.txt')
      assert.equal(r.status, 400)
      assert.equal(r.body.error, 'Bucket not found')
   })
})

describe('authorization', () => {
   let s: StorageApp
   before(async () => {
      s = await newStorageApp()
   })

   for (const [method, path] of [
      ['GET', '/storage/v1/bucket'],
      ['POST', '/storage/v1/bucket'],
      ['GET', '/storage/v1/bucket/photos'],
      ['PUT', '/storage/v1/bucket/photos'],
      ['DELETE', '/storage/v1/bucket/photos'],
      ['POST', '/storage/v1/object/list/photos'],
      ['GET', '/storage/v1/object/photos/a.txt'],
      ['DELETE', '/storage/v1/object/photos'],
      ['POST', '/storage/v1/object/copy'],
      ['POST', '/storage/v1/object/move'],
   ] as const) {
      test(`${method} ${path} requires a bearer token`, async () => {
         const r = await req(s.app, method, path, method === 'GET' || method === 'DELETE' ? undefined : {})
         assert.equal(r.status, 401)
         assert.equal(r.body.error_code, 'no_authorization')
      })
   }
})

describe('the version argument the adapter is handed', () => {
   const versionKeyedAdapter = () => {
      const store = new Map<string, Uint8Array>()
      const seen: { call: string; version: unknown }[] = []
      const keyOf = (bucket: string, key: string, version: unknown) => `${bucket}/${key}@${String(version ?? 'none')}`
      const meta = (bytes: Uint8Array) => ({
         cacheControl: 'no-cache',
         size: bytes.byteLength,
         mimetype: 'text/plain',
         lastModified: new Date(0),
         eTag: '"v"',
         contentLength: bytes.byteLength,
         httpStatusCode: 200,
      })
      const missing = () => Object.assign(new Error('NoSuchKey'), { $metadata: { httpStatusCode: 404 } })
      return {
         seen,
         keys: () => [...store.keys()],
         adapter: {
            driver: 'version-keyed',
            async uploadObject(
               bucket: string,
               key: string,
               version: string | undefined,
               body: any,
               _contentType: string,
            ) {
               seen.push({ call: 'uploadObject', version })
               let bytes: Uint8Array
               if (body instanceof Uint8Array) bytes = body
               else if (body?.getReader) {
                  const chunks: number[] = []
                  const reader = body.getReader()
                  for (;;) {
                     const { done, value } = await reader.read()
                     if (done) break
                     chunks.push(...value)
                  }
                  bytes = new Uint8Array(chunks)
               } else bytes = new Uint8Array(body)
               store.set(keyOf(bucket, key, version), bytes)
               return meta(bytes)
            },
            async getObject(bucket: string, key: string, version: string | undefined) {
               seen.push({ call: 'getObject', version })
               const bytes = store.get(keyOf(bucket, key, version))
               if (!bytes) throw missing()
               return { metadata: meta(bytes), httpStatusCode: 200, body: new Blob([bytes as BlobPart]) }
            },
            async headObject(bucket: string, key: string, version: string | undefined) {
               const bytes = store.get(keyOf(bucket, key, version))
               if (!bytes) throw missing()
               return meta(bytes)
            },
            async deleteObject() {},
            async deleteObjects() {},
            async copyObject() {
               return { httpStatusCode: 200 }
            },
            async privateAssetUrl() {
               return 'memory://x'
            },
         },
      }
   }

   const withVersionKeyedAdapter = async () => {
      const { adapter, seen, keys } = versionKeyedAdapter()
      const s = await newStorageApp({ adapter, keys })
      await post(s.app, '/storage/v1/bucket', { id: 'b', name: 'b' }, s.auth)
      return { app: s.app, auth: s.auth, seen, keys }
   }

   test('the write is handed undefined, and the read a UUID', async () => {
      const { app, auth, seen } = await withVersionKeyedAdapter()
      await post(app, '/storage/v1/object/b/a.txt', filePart('a.txt', 'hello'), auth)
      await get(app, '/storage/v1/object/b/a.txt', auth)

      const upload = seen.find((c) => c.call === 'uploadObject')!
      const read = seen.find((c) => c.call === 'getObject')!
      assert.equal(upload.version, undefined, 'uploadObject should have been given the new version')
      assert.match(String(read.version), /^[0-9a-f-]{36}$/, 'getObject is given the row version')
   })

   test('so an adapter that keys on version cannot read back its own write', async () => {
      const { app, auth, keys } = await withVersionKeyedAdapter()
      const uploaded = await post(app, '/storage/v1/object/b/a.txt', filePart('a.txt', 'hello'), auth)
      assert.equal(uploaded.status, 200, 'the upload itself succeeds')

      const download = await get(app, '/storage/v1/object/b/a.txt', auth)
      assert.equal(download.status, 500)
      assert.deepEqual(keys(), ['b/a.txt@none'])
   })
})
