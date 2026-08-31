// Resend, SES, Redis and Cloudflare KV, each driven through an injected collaborator — so what is pinned is the request built, not the network.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite } from '../test/harness.ts'

const MESSAGE = { to: 'a@b.co', subject: 'S', text: 'T', html: '<p>H</p>' }
const okResponse = () => new Response('{}', { status: 200 })

function recordingFetch(response: () => Response = okResponse) {
   const calls: { url: string; method: string; headers: Record<string, string>; body: any }[] = []
   const fetchFn = async (url: string, init: any) => {
      calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body })
      return response()
   }
   return { calls, fetchFn, last: () => calls[calls.length - 1] }
}

describe('resend email driver', () => {
   test('posts to the Resend endpoint with a bearer token', async () => {
      const { fetchFn, last } = recordingFetch()
      await new lite.ResendEmailDriver({ apiKey: 'k', from: 'f@x.co', fetch: fetchFn }).send(MESSAGE)
      assert.equal(last().url, 'https://api.resend.com/emails')
      assert.equal(last().method, 'POST')
      assert.equal(last().headers.authorization, 'Bearer k')
      assert.equal(last().headers['content-type'], 'application/json')
   })

   test('the payload carries from, to, subject and both bodies', async () => {
      const { fetchFn, last } = recordingFetch()
      await new lite.ResendEmailDriver({ apiKey: 'k', from: 'f@x.co', fetch: fetchFn }).send(MESSAGE)
      assert.deepEqual(JSON.parse(last().body), {
         from: 'f@x.co',
         to: 'a@b.co',
         subject: 'S',
         text: 'T',
         html: '<p>H</p>',
      })
   })

   test('a missing body part is omitted from the payload, not sent as undefined', async () => {
      const { fetchFn, last } = recordingFetch()
      await new lite.ResendEmailDriver({ apiKey: 'k', from: 'f@x.co', fetch: fetchFn }).send({
         to: 'a@b.co',
         subject: 'S',
         text: 'T',
      })
      assert.deepEqual(Object.keys(JSON.parse(last().body)).sort(), ['from', 'subject', 'text', 'to'])
   })

   test('the endpoint can be overridden', async () => {
      const { fetchFn, last } = recordingFetch()
      await new lite.ResendEmailDriver({
         apiKey: 'k',
         from: 'f@x.co',
         endpoint: 'https://x.test/send',
         fetch: fetchFn,
      }).send(MESSAGE)
      assert.equal(last().url, 'https://x.test/send')
   })

   test('a non-2xx response throws with the status and the body', async () => {
      const driver = new lite.ResendEmailDriver({
         apiKey: 'k',
         from: 'f@x.co',
         fetch: async () => new Response('nope', { status: 422 }),
      })
      await assert.rejects(() => driver.send(MESSAGE), /Resend email failed \(422\): nope/)
   })
})

describe('aws ses email driver', () => {
   const clientRecording = () => {
      const calls: any[] = []
      return {
         calls,
         client: { fetch: async (url: string, init: any) => (calls.push({ url, ...init }), okResponse()) },
         last: () => calls[calls.length - 1],
      }
   }

   test('the endpoint is derived from the region', async () => {
      const { client, last } = clientRecording()
      await new lite.AwsSesEmailDriver({ region: 'eu-west-1', from: 'f@x.co', client }).send(MESSAGE)
      assert.equal(last().url, 'https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails')
      assert.equal(last().method, 'POST')
   })

   test('the payload is the SES v2 Simple envelope', async () => {
      const { client, last } = clientRecording()
      await new lite.AwsSesEmailDriver({ region: 'us-east-1', from: 'f@x.co', client }).send(MESSAGE)
      assert.deepEqual(JSON.parse(last().body), {
         FromEmailAddress: 'f@x.co',
         Destination: { ToAddresses: ['a@b.co'] },
         Content: {
            Simple: {
               Subject: { Data: 'S', Charset: 'UTF-8' },
               Body: { Text: { Data: 'T', Charset: 'UTF-8' }, Html: { Data: '<p>H</p>', Charset: 'UTF-8' } },
            },
         },
      })
   })

   test('an html-only message omits the Text part', async () => {
      const { client, last } = clientRecording()
      await new lite.AwsSesEmailDriver({ region: 'us-east-1', from: 'f@x.co', client }).send({
         to: 'a@b.co',
         subject: 'S',
         html: '<p>H</p>',
      })
      assert.deepEqual(Object.keys(JSON.parse(last().body).Content.Simple.Body), ['Html'])
   })

   test('a non-2xx response throws with the status and the body', async () => {
      const driver = new lite.AwsSesEmailDriver({
         region: 'us-east-1',
         from: 'f@x.co',
         client: { fetch: async () => new Response('denied', { status: 403 }) },
      })
      await assert.rejects(() => driver.send(MESSAGE), /AWS SES email failed \(403\): denied/)
   })

   test('with no client supplied it builds a SigV4 signer from the credentials', async () => {
      const driver = new lite.AwsSesEmailDriver({
         region: 'us-east-1',
         from: 'f@x.co',
         accessKeyId: 'AKIA',
         secretAccessKey: 'sk',
      })
      const client = await driver.getClient()
      assert.equal(typeof client.fetch, 'function')
      assert.equal(typeof client.sign, 'function')
   })

   test('the signer is memoised', async () => {
      const driver = new lite.AwsSesEmailDriver({
         region: 'us-east-1',
         from: 'f@x.co',
         accessKeyId: 'AKIA',
         secretAccessKey: 'sk',
      })
      assert.equal(await driver.getClient(), await driver.getClient())
   })
})

describe('aws sigv4 signing', () => {
   const sign = async () => {
      const driver = new lite.AwsSesEmailDriver({
         region: 'us-east-1',
         from: 'f@x.co',
         accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
         secretAccessKey: 'wJalrXUtnFEMI/K7MDENG',
      })
      const client = await driver.getClient()
      return client.sign('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: '{"a":1}',
      })
   }

   test('it returns a request with the url and method intact', async () => {
      const signed = await sign()
      assert.equal(signed.url, 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails')
      assert.equal(signed.method, 'POST')
   })

   test('the authorization header is an AWS4-HMAC-SHA256 credential scoped to service and region', async () => {
      const authorization = (await sign()).headers.get('authorization')!
      assert.match(authorization, /^AWS4-HMAC-SHA256 /)
      assert.match(authorization, /Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request/)
   })

   test('it declares which headers were signed, and signs host and x-amz-date', async () => {
      const authorization = (await sign()).headers.get('authorization')!
      assert.match(authorization, /SignedHeaders=host;x-amz-date/)
      assert.match(authorization, /Signature=[0-9a-f]{64}/)
   })

   test('an x-amz-date header is added in the compact ISO form', async () => {
      assert.match((await sign()).headers.get('x-amz-date'), /^\d{8}T\d{6}Z$/)
   })

   test('two signatures of the same request agree', async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
         const [a, b] = await Promise.all([sign(), sign()])
         if (a.headers.get('x-amz-date') !== b.headers.get('x-amz-date')) continue
         assert.equal(a.headers.get('authorization'), b.headers.get('authorization'))
         return
      }
      assert.fail('five signing pairs in a row straddled a second boundary')
   })

   test('a different secret produces a different signature', async () => {
      const other = new lite.AwsSesEmailDriver({
         region: 'us-east-1',
         from: 'f@x.co',
         accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
         secretAccessKey: 'a-different-secret',
      })
      const otherSigned = await (
         await other.getClient()
      ).sign('https://email.us-east-1.amazonaws.com/v2/email/outbound-emails', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: '{"a":1}',
      })
      assert.notEqual((await sign()).headers.get('authorization'), otherSigned.headers.get('authorization'))
   })
})

describe('redis cache driver', () => {
   const recorder = (stored: string | null = null) => {
      const calls: any[][] = []
      return {
         calls,
         client: {
            get: async (key: string) => (calls.push(['get', key]), stored),
            set: async (...args: any[]) => void calls.push(['set', ...args]),
            del: async (key: string) => void calls.push(['del', key]),
         },
      }
   }

   test('set and get reach the client', async () => {
      const { calls, client } = recorder('v')
      const driver = new lite.RedisCacheDriver({ client })
      await driver.set('a', 'v')
      assert.equal(await driver.get('a'), 'v')
      assert.deepEqual(calls, [
         ['set', 'a', 'v'],
         ['get', 'a'],
      ])
   })

   test('a ttl is passed through as the redis EX argument, in seconds', async () => {
      const { calls, client } = recorder()
      await new lite.RedisCacheDriver({ client }).set('a', 'v', { ttl: 60 })
      assert.deepEqual(calls, [['set', 'a', 'v', 'EX', 60]])
   })

   test('a null reply becomes undefined rather than null', async () => {
      const { client } = recorder(null)
      assert.equal(await new lite.RedisCacheDriver({ client }).get('missing'), undefined)
   })

   test('delete prefers del', async () => {
      const { calls, client } = recorder()
      await new lite.RedisCacheDriver({ client }).delete('a')
      assert.deepEqual(calls, [['del', 'a']])
   })

   test('delete falls back to a delete method for clients that lack del', async () => {
      const calls: any[][] = []
      const client = {
         get: async () => null,
         set: async () => {},
         delete: async (key: string) => void calls.push(['delete', key]),
      }
      await new lite.RedisCacheDriver({ client }).delete('a')
      assert.deepEqual(calls, [['delete', 'a']])
   })
})

describe('cloudflare kv cache driver', () => {
   const recorder = (stored: string | null = null) => {
      const calls: any[][] = []
      return {
         calls,
         namespace: {
            get: async (key: string) => (calls.push(['get', key]), stored),
            put: async (...args: any[]) => void calls.push(['put', ...args]),
            delete: async (key: string) => void calls.push(['delete', key]),
         },
      }
   }

   test('set, get and delete reach the namespace', async () => {
      const { calls, namespace } = recorder('v')
      const driver = new lite.CloudflareKvCacheDriver({ namespace })
      await driver.set('a', 'v')
      assert.equal(await driver.get('a'), 'v')
      await driver.delete('a')
      assert.deepEqual(calls, [
         ['put', 'a', 'v', {}],
         ['get', 'a'],
         ['delete', 'a'],
      ])
   })

   test('with no ttl the options object is empty rather than absent', async () => {
      const { calls, namespace } = recorder()
      await new lite.CloudflareKvCacheDriver({ namespace }).set('a', 'v')
      assert.deepEqual(calls[0][3], {})
   })

   test('a ttl becomes expirationTtl, which is what the KV API expects', async () => {
      const { calls, namespace } = recorder()
      await new lite.CloudflareKvCacheDriver({ namespace }).set('a', 'v', { ttl: 60 })
      assert.deepEqual(calls[0][3], { expirationTtl: 60 })
   })

   test('a null reply becomes undefined', async () => {
      const { namespace } = recorder(null)
      assert.equal(await new lite.CloudflareKvCacheDriver({ namespace }).get('missing'), undefined)
   })
})

describe('sendmail email driver', () => {
   test('a binary that does not exist reports which path failed to start', async () => {
      const driver = new lite.SendmailEmailDriver({ from: 'f@x.co', sendmailPath: 'definitely-not-a-real-binary-xyz' })
      await assert.rejects(
         () => driver.send(MESSAGE),
         /SendmailEmailDriver failed to start definitely-not-a-real-binary-xyz/,
      )
   })

   test('it defaults to the conventional sendmail location', async () => {
      assert.equal(new lite.SendmailEmailDriver({ from: 'f@x.co' }).sendmailPath, '/usr/sbin/sendmail')
   })
})
