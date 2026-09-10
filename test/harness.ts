// HTTP fixtures for the installed bundle, or LITE_TARGET. Load the driver beside that bundle.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const TARGET =
   process.env.LITE_TARGET ?? fileURLToPath(new URL('../node_modules/@supabase/lite/dist/index.js', import.meta.url))

export const lite: any = await import(pathToFileURL(TARGET).href)
const { createConnection } = (await import(pathToFileURL(join(dirname(TARGET), 'db', 'node', 'index.js')).href)) as {
   createConnection: (opts: { url: string }) => Promise<LiteConnection>
}

export const JWT_SECRET = 'super-secret-jwt-token-with-at-least-32-characters'

// The bundle is loaded from a path at runtime, so there is no declaration file to import. These
// shapes cover only what the tests touch.
export interface LiteResponse {
   status: number
   headers: Headers
   contentType: string | null
   contentRange: string | null
   contentLocation: string | null
   body: any
}

export interface LiteApp {
   fetch(request: Request): Promise<Response>
   init(): Promise<void>
   ensureSystemSchema(): Promise<void>
}

export interface LiteConnection {
   config: { ddlDialect?: string }
   exec(sql: string, ...params: unknown[]): Promise<any>
   clearSchemaCache(): Promise<void>
   createMigrator(ddl: string): Promise<{ migrate(opts?: { force?: boolean }): Promise<any>; diff(): Promise<any> }>
   translateDdl(ddl: string): Promise<any>
   introspect(options?: { useCache?: boolean }): Promise<any>
}

/** A fresh in-memory database and app. Tests must not depend on each other's writes. */
export async function newApp({
   auth = true,
   seed = true,
   mailer,
}: { auth?: boolean; seed?: boolean; mailer?: unknown } = {}): Promise<{ app: LiteApp; connection: LiteConnection }> {
   const { app, connection } = await newRawApp({
      ...(auth ? { auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000' } } : {}),
      ...(mailer ? { options: { drivers: { email: mailer } } } : {}),
   })
   if (seed) await seedExampleData(app, connection)
   return { app, connection }
}

async function seedExampleData(app: LiteApp, connection: LiteConnection): Promise<void> {
   // Raw SQLite DDL: connection.exec does not translate Postgres types.
   for (const ddl of [
      `CREATE TABLE authors (id integer primary key, name text not null, bio text, rating real, active integer default 1)`,
      `CREATE TABLE books (id integer primary key, author_id integer references authors(id), title text not null, pages integer, price real, published text)`,
      `CREATE TABLE reviews (id integer primary key, book_id integer references books(id), stars integer, body text)`,
      `CREATE VIEW top_books AS SELECT id, title, pages FROM books`,
   ])
      await connection.exec(ddl)

   // Every row in one batch must carry the same keys, or PostgREST rejects it with PGRST102.
   await req(app, 'POST', '/rest/v1/authors', [
      { id: 1, name: 'Ursula', bio: 'sci-fi', rating: 4.8, active: 1 },
      { id: 2, name: 'Borges', bio: null, rating: 4.9, active: 0 },
      { id: 3, name: "O'Brien", bio: 'quotes', rating: 3.2, active: 1 },
   ])
   await req(app, 'POST', '/rest/v1/books', [
      { id: 1, author_id: 1, title: 'The Dispossessed', pages: 341, price: 9.99, published: '1974-01-01' },
      { id: 2, author_id: 1, title: 'A Wizard of Earthsea', pages: 183, price: 7.5, published: '1968-01-01' },
      { id: 3, author_id: 2, title: 'Ficciones', pages: null, price: 12, published: '1944-01-01' },
   ])
   await req(app, 'POST', '/rest/v1/reviews', [
      { id: 1, book_id: 1, stars: 5, body: 'great' },
      { id: 2, book_id: 1, stars: 4, body: 'good' },
      { id: 3, book_id: 3, stars: 5, body: 'perfect' },
   ])
}

/** A fresh in-memory app with explicit configuration. */
export async function newRawApp(
   config: Record<string, unknown>,
): Promise<{ app: LiteApp; connection: LiteConnection }> {
   const connection = await createConnection({ url: ':memory:' })
   const app = new lite.App({ connection, ...config })
   await app.init()
   await app.ensureSystemSchema()
   return { app, connection }
}

export interface Mailbox {
   to(address: string): { to: string; subject: string; text: string; html: string; sentAt: string }[]
   code(address: string): string | undefined
   token(address: string): string | undefined
}

/** Capture outgoing mail for OTP and verification-link assertions. */
export async function newAppWithMailbox(): Promise<{ app: LiteApp; connection: LiteConnection; mail: Mailbox }> {
   const driver = new lite.InMemoryEmailDriver({})
   const { app, connection } = await newApp({ mailer: driver })
   const messagesTo = (address: string) => {
      const messages = driver.messages.get(address)
      if (Array.isArray(messages)) return messages
      return messages ? [messages] : []
   }
   const latestMessageTo = (address: string) => messagesTo(address).at(-1)
   return {
      app,
      connection,
      mail: {
         to: messagesTo,
         code: (address) => latestMessageTo(address)?.text?.match(/(?<!\d)(\d{6})(?!\d)/)?.[1],
         token: (address) => latestMessageTo(address)?.text?.match(/[?&]token=([0-9a-f]+)/)?.[1],
      },
   }
}

export interface StorageApp {
   app: LiteApp
   connection: LiteConnection
   /** Bearer header for a signed-up user. */
   auth: Record<string, string>
   /** Object keys held by the adapter. */
   stored(): string[]
}

// Ignore object versions here: this build uploads with undefined but downloads with a UUID.
// pins/storage.test.ts tests that mismatch with a separate adapter.
function memoryStorageAdapter() {
   const store = new Map<string, { bytes: Uint8Array; meta: any }>()
   const keyOf = (bucket: string, key: string) => `${bucket}/${key}`
   const missing = () => Object.assign(new Error('NoSuchKey'), { $metadata: { httpStatusCode: 404 } })
   const metaFor = (bytes: Uint8Array, mimetype: string, cacheControl = 'no-cache') => ({
      cacheControl,
      size: bytes.byteLength,
      mimetype,
      lastModified: new Date(0),
      eTag: '"stub"',
      contentLength: bytes.byteLength,
      httpStatusCode: 200,
   })
   const read = (bucket: string, key: string) => {
      const entry = store.get(keyOf(bucket, key))
      if (!entry) throw missing()
      return entry
   }
   return {
      keys: () => [...store.keys()],
      adapter: {
         driver: 'memory',
         async uploadObject(
            bucket: string,
            key: string,
            _version: string | undefined,
            body: any,
            contentType: string,
            cacheControl: string,
         ) {
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
            const meta = metaFor(bytes, contentType, cacheControl)
            store.set(keyOf(bucket, key), { bytes, meta })
            return meta
         },
         async getObject(bucket: string, key: string) {
            const entry = read(bucket, key)
            return { metadata: entry.meta, httpStatusCode: 200, body: new Blob([entry.bytes as BlobPart]) }
         },
         async headObject(bucket: string, key: string) {
            return read(bucket, key).meta
         },
         async deleteObject(bucket: string, key: string) {
            store.delete(keyOf(bucket, key))
         },
         async deleteObjects(bucket: string, prefixes: string[]) {
            for (const prefix of prefixes) {
               for (const key of [...store.keys()]) {
                  if (key.startsWith(`${bucket}/${prefix}`)) store.delete(key)
               }
            }
         },
         async copyObject(bucket: string, source: string, _version: string | undefined, destination: string) {
            const entry = read(bucket, source)
            store.set(keyOf(bucket, destination), { ...entry })
            return { httpStatusCode: 200, eTag: entry.meta.eTag, lastModified: entry.meta.lastModified }
         },
         async privateAssetUrl(bucket: string, key: string) {
            return `memory://${keyOf(bucket, key)}`
         },
      },
   }
}

// Attach the adapter before schema setup, which creates tables only for enabled services.
export async function newStorageApp(custom?: { adapter: unknown; keys: () => string[] }): Promise<StorageApp> {
   lite.setExperimental('storage', true)
   const { adapter, keys } = custom ?? memoryStorageAdapter()
   const connection = await createConnection({ url: ':memory:' })
   const app = new lite.App({
      connection,
      auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000' },
      storage: { enabled: true },
   })
   app._storageAdapter = adapter
   await app.init()
   await app.ensureSystemSchema()
   const session = (await post(app, '/auth/v1/signup', { email: 'storage@b.co', password: 'password123' })).body
   return { app, connection, auth: { Authorization: `Bearer ${session.access_token}` }, stored: keys }
}

/** A multipart upload, the way supabase-js sends one. */
export function filePart(name: string, content: string, type = 'text/plain'): FormData {
   const form = new FormData()
   form.append('file', new Blob([content], { type }), name)
   return form
}

export async function req(
   app: LiteApp,
   method: string,
   path: string,
   body?: unknown,
   headers: Record<string, string> = {},
): Promise<LiteResponse> {
   const init: RequestInit & { headers: Record<string, string> } = { method, headers: { ...headers } }
   if (body instanceof FormData) {
      // Let Request set Content-Type with the matching multipart boundary.
      init.body = body
   } else if (body !== undefined) {
      init.headers['Content-Type'] = init.headers['Content-Type'] ?? 'application/json'
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
   }

   const res = await app.fetch(new Request('http://lite.test' + path, init))
   const text = await res.text()
   let parsed
   try {
      parsed = JSON.parse(text)
   } catch {
      parsed = text
   }
   return {
      status: res.status,
      headers: res.headers,
      contentType: res.headers.get('content-type'),
      contentRange: res.headers.get('content-range'),
      contentLocation: res.headers.get('content-location'),
      body: parsed,
   }
}

export function get(app: LiteApp, path: string, headers?: Record<string, string>): Promise<LiteResponse> {
   return req(app, 'GET', path, undefined, headers)
}
export function post(
   app: LiteApp,
   path: string,
   body?: unknown,
   headers?: Record<string, string>,
): Promise<LiteResponse> {
   return req(app, 'POST', path, body, headers)
}

export const pgrstCode = (response: LiteResponse): string | undefined =>
   response.body && typeof response.body === 'object' ? response.body.code : undefined
