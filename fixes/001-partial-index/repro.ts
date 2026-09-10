// A partial UNIQUE index must allow reuse of a soft-deleted row's address.
// Run: npm run repro -- partial-index
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
const stored = String((await connection.exec("SELECT sql FROM sqlite_master WHERE name='u'")).rows[0]?.sql)
show('in the database', stored)

// The soft-delete idiom: an address is unique among live rows, so it may be re-registered once the
// row holding it is soft-deleted. Postgres accepts both inserts.
const first = await post(app, '/rest/v1/users', { id: 1, email: 'a@b.co', deleted_at: '2020-01-01T00:00:00Z' })
const again = await post(app, '/rest/v1/users', { id: 2, email: 'a@b.co', deleted_at: null })
show('re-registering a deleted address', `${again.status} ${String(again.body?.message ?? '').slice(0, 48)}`)

// Each half is asked separately, so a fix reaching only one of them cannot report success: the
// translation, the index the migration actually left behind, and what the database now accepts.
const translationPreservesPredicate = translated.includes('WHERE')
const storedIndexPreservesPredicate = stored.toUpperCase().includes('WHERE')
const allowsEmailReuse = first.status === 201 && again.status === 201

console.log(
   translationPreservesPredicate && storedIndexPreservesPredicate && allowsEmailReuse
      ? '\n  DIFFERS: the predicate survives translation and the migration, and the soft-delete idiom works\n'
      : `\n  AS DESCRIBED: translated=${translationPreservesPredicate} stored=${storedIndexPreservesPredicate} reusable=${allowsEmailReuse} — a constraint Postgres scopes to live rows is global here\n`,
)
