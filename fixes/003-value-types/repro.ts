// Arrays, objects, and booleans should arrive as their declared types.
// Run: npm run repro -- value-types
import { newApp, get, post, type LiteApp, type LiteConnection } from '../../test/harness.ts'

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)

console.log('\nFIX-003 — arrays, jsonb and boolean come back in the wrong types\n')

const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
await (
   await connection.createMigrator('CREATE TABLE items (id int primary key, tags text[], meta jsonb, ok boolean);')
).migrate()
await post(app, '/rest/v1/items', { id: 1, tags: ['a', 'b'], meta: { x: { y: 1 } }, ok: true })

const row = (await get(app, '/rest/v1/items?id=eq.1&select=tags,meta,ok')).body[0]
show('#5  tags', `${JSON.stringify(row.tags)}  (${typeof row.tags})`)
show('#5  meta', `${JSON.stringify(row.meta)}  (${typeof row.meta})`)
show('#5  row.tags.map is', String(typeof row.tags?.map))
show('#6  ok', `${JSON.stringify(row.ok)}  (${typeof row.ok})`)
show('#6  row.ok === true', String(row.ok === true))

// The cause, in two lines: the field the metadata merge is gated on has no default, while the
// introspection that merge would have enriched reports the very default the gate is missing.
console.log()
const config = (connection as unknown as { config: { ddlDialect?: string } }).config
show('config.ddlDialect', JSON.stringify(config.ddlDialect))
show('introspection.ddl_dialect', JSON.stringify((await connection.introspect()).ddl_dialect))

// DeserializeJsonPlugin exists for exactly this and does run — but only on the arrow path.
console.log()
show('selecting meta->x->>y', JSON.stringify((await get(app, '/rest/v1/items?id=eq.1&select=v:meta->x->>y')).body[0]))

// The other side of #6: input is coerced generously, so an unrecognised spelling becomes true.
let id = 10
for (const value of [true, 'yes', false, 'no'] as unknown[]) {
   const r = await post(app, '/rest/v1/items', { id: id++, ok: value }, { Prefer: 'return=representation' })
   show(`writing ok: ${JSON.stringify(value)}`, `stored ${JSON.stringify(r.body[0].ok)}`)
}

console.log(
   typeof row.tags === 'string' || typeof row.ok !== 'boolean'
      ? '\n  AS DESCRIBED: the client receives the characters of the JSON and an integer where supabase-js promises an array, an object and a boolean\n'
      : '\n  DIFFERS: the values arrive as an array, an object and a boolean — this is the patched build\n',
)
