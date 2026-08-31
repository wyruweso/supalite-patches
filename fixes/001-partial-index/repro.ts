// FIX-001 — a partial index silently loses its WHERE clause.  FINDINGS #1
//
// SQLite has supported partial indexes since 3.8.0, so nothing forces this: the predicate is dropped
// during translation, and for a UNIQUE index that changes what the database accepts — in the
// direction that breaks the standard soft-delete idiom.
//
//   node repro.ts 001          on the published bundle, so the defect shows
//   npm run install:patches    then run it again
import { newApp, post, type LiteApp, type LiteConnection } from '../../test/harness.ts'

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)

console.log('\nFIX-001 — a partial index silently loses its WHERE clause\n')

const SCHEMA = `CREATE TABLE users (id int primary key, email text, deleted_at timestamptz);
CREATE UNIQUE INDEX u ON users (email) WHERE deleted_at IS NULL;`

const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
show('written', 'CREATE UNIQUE INDEX u ON users (email) WHERE deleted_at IS NULL')

const translated = String((await connection.translateDdl(SCHEMA)).ddl.match(/CREATE UNIQUE INDEX[^;]*/)?.[0])
show('translated', translated)

await (await connection.createMigrator(SCHEMA)).migrate()
show('in the database', String((await connection.exec("SELECT sql FROM sqlite_master WHERE name='u'")).rows[0]?.sql))

// The soft-delete idiom: an address is unique among live rows, so it may be re-registered once the
// row holding it is soft-deleted. Postgres accepts the second insert.
await post(app, '/rest/v1/users', { id: 1, email: 'a@b.co', deleted_at: '2020-01-01T00:00:00Z' })
const again = await post(app, '/rest/v1/users', { id: 2, email: 'a@b.co', deleted_at: null })
show('re-registering a deleted address', `${again.status} ${String(again.body?.message ?? '').slice(0, 48)}`)

console.log(
   translated.includes('WHERE')
      ? '\n  DIFFERS: the predicate survives and the soft-delete idiom works — this is the patched build\n'
      : '\n  AS DESCRIBED: the predicate is dropped in translation, so a constraint Postgres scopes to live rows becomes global\n',
)
