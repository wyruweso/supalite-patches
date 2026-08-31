// The in-memory drivers: email, cache, queue.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite } from '../test/harness.ts'

describe('in-memory email driver', () => {
   test('a sent message is filed under its recipient', async () => {
      const driver = new lite.InMemoryEmailDriver({})
      await driver.send({ to: 'a@b.co', subject: 'Hi', text: 'body', html: '<p>b</p>' })
      assert.deepEqual([...driver.messages.keys()], ['a@b.co'])
      const [message] = driver.messages.get('a@b.co')
      assert.equal(message.subject, 'Hi')
      assert.equal(message.text, 'body')
      assert.equal(message.html, '<p>b</p>')
      assert.match(message.sentAt, /^\d{4}-\d{2}-\d{2}T/)
   })

   test('messages to one address accumulate in order', async () => {
      const driver = new lite.InMemoryEmailDriver({})
      await driver.send({ to: 'a@b.co', subject: 'first', text: '1', html: '' })
      await driver.send({ to: 'a@b.co', subject: 'second', text: '2', html: '' })
      assert.deepEqual(
         driver.messages.get('a@b.co').map((message: any) => message.subject),
         ['first', 'second'],
      )
   })

   test('different recipients are kept apart', async () => {
      const driver = new lite.InMemoryEmailDriver({})
      await driver.send({ to: 'a@b.co', subject: 'x', text: '1', html: '' })
      await driver.send({ to: 'c@d.co', subject: 'y', text: '2', html: '' })
      assert.deepEqual([...driver.messages.keys()].sort(), ['a@b.co', 'c@d.co'])
   })

   test('clear empties the mailbox', async () => {
      const driver = new lite.InMemoryEmailDriver({})
      await driver.send({ to: 'a@b.co', subject: 'x', text: '1', html: '' })
      driver.clear()
      assert.deepEqual([...driver.messages.keys()], [])
   })
})

describe('sms driver', () => {
   test('the noop driver accepts a send and resolves', async () => {
      assert.equal(await new lite.NoopSmsDriver({}).send({ to: '+123', message: 'hi' }), undefined)
   })
})

describe('driver defaults', () => {
   test('createAppDrivers fills in email, sms and cache', () => {
      const drivers = lite.createAppDrivers({})
      assert.deepEqual(Object.keys(drivers).sort(), ['cache', 'email', 'sms'])
      for (const name of ['email', 'sms', 'cache']) assert.equal(typeof drivers[name], 'object', name)
   })

   test('a supplied driver is used as-is rather than replaced', () => {
      const mine = new lite.InMemoryEmailDriver({})
      assert.equal(lite.createAppDrivers({ email: mine }).email, mine)
   })
})

describe('lru cache driver', () => {
   test('a value round trips', async () => {
      const cache = new lite.InMemoryLruCacheDriver({})
      await cache.set('a', 1)
      assert.equal(await cache.get('a'), 1)
   })

   test('a missing key reads as undefined', async () => {
      assert.equal(await new lite.InMemoryLruCacheDriver({}).get('nope'), undefined)
   })

   test('objects survive the round trip', async () => {
      const cache = new lite.InMemoryLruCacheDriver({})
      await cache.set('o', { x: 1 })
      assert.deepEqual(await cache.get('o'), { x: 1 })
   })

   test('delete removes a key', async () => {
      const cache = new lite.InMemoryLruCacheDriver({})
      await cache.set('a', 1)
      await cache.delete('a')
      assert.equal(await cache.get('a'), undefined)
   })

   test('setting a key twice replaces it rather than double-counting its bytes', async () => {
      const cache = new lite.InMemoryLruCacheDriver({ maxSizeBytes: 200 })
      await cache.set('keep', 'k')
      for (let i = 0; i < 20; i++) await cache.set('churn', 'v'.repeat(20))
      assert.equal(await cache.get('keep'), 'k')
   })

   test('the budget is a byte budget: oversized entries evict the oldest', async () => {
      const cache = new lite.InMemoryLruCacheDriver({ maxSizeBytes: 40 })
      await cache.set('a', 'x'.repeat(20))
      await cache.set('b', 'y'.repeat(20))
      await cache.set('c', 'z'.repeat(20))
      assert.equal(await cache.get('a'), undefined)
      assert.equal(await cache.get('b'), undefined)
      assert.equal((await cache.get('c')).length, 20)
   })

   test('a read promotes a key, so the one NOT read is evicted first', async () => {
      const cache = new lite.InMemoryLruCacheDriver({ maxSizeBytes: 60 })
      await cache.set('a', 'x'.repeat(15))
      await cache.set('b', 'y'.repeat(15))
      await cache.get('a')
      await cache.set('c', 'z'.repeat(15))
      assert.ok(await cache.get('a'))
      assert.ok(await cache.get('c'))
   })

   test('a ttl is in seconds and expires on a strictly later clock', async () => {
      let clock = 1000
      const cache = new lite.InMemoryLruCacheDriver({ now: () => clock })
      await cache.set('a', 1, { ttl: 5 })
      assert.equal(await cache.get('a'), 1)
      clock += 4000
      assert.equal(await cache.get('a'), 1, 'still inside the window')
      clock += 2000
      assert.equal(await cache.get('a'), undefined, 'past the window')
   })

   test('no ttl means no expiry', async () => {
      let clock = 1000
      const cache = new lite.InMemoryLruCacheDriver({ now: () => clock })
      await cache.set('a', 1)
      clock += 10 ** 9
      assert.equal(await cache.get('a'), 1)
   })
})

describe('smtp and sendmail message building', () => {
   test('buildSmtpMail takes the sender separately from the message', () => {
      assert.deepEqual(lite.buildSmtpMail('from@x.co', { to: 'c@d.co', subject: 'S', text: 'T', html: '<p>H</p>' }), {
         from: 'from@x.co',
         to: 'c@d.co',
         subject: 'S',
         text: 'T',
         html: '<p>H</p>',
      })
   })

   test('an absent body part is omitted rather than sent as undefined', () => {
      assert.deepEqual(lite.buildSmtpMail('from@x.co', { to: 'c@d.co', subject: 'S', text: 'T' }), {
         from: 'from@x.co',
         to: 'c@d.co',
         subject: 'S',
         text: 'T',
      })
   })

   test('buildSmtpTransportOptions requires TLS and sets the three timeouts', () => {
      assert.deepEqual(lite.buildSmtpTransportOptions({ host: 'smtp.x', port: 587, user: 'u', pass: 'p' }), {
         host: 'smtp.x',
         port: 587,
         secure: false,
         auth: { user: 'u', pass: 'p' },
         requireTLS: true,
         connectionTimeout: 30000,
         greetingTimeout: 30000,
         socketTimeout: 30000,
      })
   })

   test('formatSendmailMessage emits RFC-822 headers, text/plain by default', () => {
      assert.equal(
         lite.formatSendmailMessage('from@x.co', { to: 'c@d.co', subject: 'S', text: 'T' }),
         [
            'From: from@x.co',
            'To: c@d.co',
            'Subject: S',
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            '',
            'T',
         ].join('\n'),
      )
   })

   test('an html body switches the Content-Type and becomes the payload', () => {
      assert.equal(
         lite.formatSendmailMessage('from@x.co', { to: 'c@d.co', subject: 'S', html: '<p>H</p>' }),
         [
            'From: from@x.co',
            'To: c@d.co',
            'Subject: S',
            'MIME-Version: 1.0',
            'Content-Type: text/html; charset=UTF-8',
            '',
            '<p>H</p>',
         ].join('\n'),
      )
   })

   test('assertSmtpSupportedRuntime throws on a falsy argument and passes on a truthy one', () => {
      assert.throws(() => lite.assertSmtpSupportedRuntime(false), /SMTP email is not supported in this runtime/)
      assert.doesNotThrow(() => lite.assertSmtpSupportedRuntime(true))
   })
})

describe('the driver classes the package exports', () => {
   for (const name of [
      'ConsoleEmailDriver',
      'InMemoryEmailDriver',
      'ResendEmailDriver',
      'AwsSesEmailDriver',
      'SendmailEmailDriver',
      'SmtpEmailDriver',
      'NoopSmsDriver',
      'InMemoryLruCacheDriver',
      'RedisCacheDriver',
      'CloudflareKvCacheDriver',
   ])
      test(`${name} is exported and has a send or get`, () => {
         assert.equal(typeof lite[name], 'function', `${name} is not exported`)
         const proto = lite[name].prototype
         assert.ok(
            typeof proto.send === 'function' || typeof proto.get === 'function',
            `${name} has neither send nor get`,
         )
      })
})
