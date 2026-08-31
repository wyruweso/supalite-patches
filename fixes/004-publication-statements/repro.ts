// FIX-004 — publication statements kill the migration, in two different ways.  FINDINGS #7
//
// No SQLite equivalent, so these should be dropped (as GRANT and COMMENT ON are) or refused by name
// (as REVOKE and REPLICA IDENTITY are). Instead ALTER is mangled — the deparser prints its own
// `FOR TABLE` and keeps the original `TABLE` — and DROP PUBLICATION is refused outright, so the
// block Supabase documents for enabling Realtime fails on its first line.
//
//   node repro.ts 004          on the published bundle, so the defect shows
//   npm run install:patches    then run it again
import { newApp, type LiteConnection } from '../../test/harness.ts'

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)

console.log('\nFIX-004 — ALTER PUBLICATION is emitted mangled and kills the migration\n')

const SCHEMA = `CREATE TABLE messages (id int primary key, body text);
ALTER PUBLICATION supabase_realtime ADD TABLE messages;`

const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
show('written', 'ALTER PUBLICATION supabase_realtime ADD TABLE messages')
show('translated', String((await connection.translateDdl(SCHEMA)).ddl.match(/ALTER PUBLICATION.*/)?.[0] ?? '(dropped)'))

let broke = false
try {
   await (await connection.createMigrator(SCHEMA)).migrate()
   show('the migration', 'succeeded')
} catch (e) {
   broke = true
   show('the migration', `FAILED: ${(e as Error).message.slice(0, 60)}`)
}

// Supabase's own documented block for turning Realtime on. It opens with the DROP, which fails a
// different way — sharing a node type with DROP TABLE, it is refused by name rather than mangled —
// so this dies before ever reaching the ALTER above.
console.log()
const REALTIME = `CREATE TABLE messages (id int primary key, body text);
begin;
drop publication if exists supabase_realtime;
create publication supabase_realtime;
commit;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;`

const canonical: { connection: LiteConnection } = await newApp({ seed: false })
try {
   await (await canonical.connection.createMigrator(REALTIME)).migrate()
   show('the documented block', 'succeeded')
} catch (e) {
   broke = true
   show('the documented block', `FAILED: ${(e as Error).message.slice(0, 60)}`)
}

console.log()
for (const [name, stmt] of [
   ['GRANT', 'GRANT SELECT ON messages TO anon;'],
   ['REVOKE', 'REVOKE SELECT ON messages FROM anon;'],
   ['COMMENT ON', "COMMENT ON TABLE messages IS 'x';"],
   ['REPLICA IDENTITY', 'ALTER TABLE messages REPLICA IDENTITY FULL;'],
] as [string, string][]) {
   const fresh: { connection: LiteConnection } = await newApp({ seed: false })
   const sql = `CREATE TABLE messages (id int primary key, body text);\n${stmt}`
   try {
      await (await fresh.connection.createMigrator(sql)).migrate()
      show(name, 'dropped silently, the migration succeeds')
   } catch (e) {
      show(name, `refused: ${(e as Error).message.slice(0, 56)}`)
   }
}

console.log(
   broke
      ? `\n  AS DESCRIBED: ${'the publication statements are how Realtime is enabled, so they are in every project that uses it — and they are the neighbours that are neither dropped nor refused. The documented block dies on its DROP, before reaching the mangled ALTER'}\n`
      : `\n  DIFFERS: ${'the whole family is dropped like its GRANT and COMMENT ON neighbours — this is the patched build'}\n`,
)
