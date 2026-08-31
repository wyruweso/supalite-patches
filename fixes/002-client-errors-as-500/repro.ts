// FIX-002 — client errors reported as server faults.  FINDINGS #2, #3, #4
//
// Refusals that are all the caller's fault, all answered `500 SUP` with a stringified Error — the
// fingerprint of an exception that escaped rather than an error raised deliberately.
//
//   node repro.ts 002          on the published bundle, so the defect shows
//   npm run install:patches    then run it again
import { newApp, post, pgrstCode, type LiteApp, type LiteConnection } from '../../test/harness.ts'

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)

console.log('\nFIX-002 — client errors come back as server faults\n')

// --- #2 — an RLS refusal with no matching policy --------------------------------------------------
//
// RLS denies per command. A table with only a FOR SELECT policy correctly refuses an insert and the
// row is not written; only the status is wrong. The WITH CHECK path beside it converts properly.
const rls: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
await (
   await rls.connection.createMigrator(`CREATE TABLE notes (id int primary key, body text);
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY readable ON notes FOR SELECT USING (true);
CREATE TABLE checked (id int primary key, body text);
ALTER TABLE checked ENABLE ROW LEVEL SECURITY;
CREATE POLICY mine ON checked FOR ALL USING (true) WITH CHECK (false);`)
).migrate()

const session = (await post(rls.app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })).body
const auth = { Authorization: `Bearer ${session.access_token}` }

let escaped = false
for (const [table, label] of [
   ['checked', '#2  WITH CHECK on a policy'],
   ['notes', '#2  no policy for INSERT at all'],
] as const) {
   const r = await post(rls.app, `/rest/v1/${table}`, { id: 1, body: 'x' }, auth)
   show(label, `${r.status} ${pgrstCode(r)} — ${r.body?.message}`)
   escaped ||= r.status >= 500
}

// --- #3 and #4 — constraint violations ------------------------------------------------------------
const db: { app: LiteApp; connection: LiteConnection } = await newApp({ seed: false })
await (
   await db.connection
      .createMigrator(`CREATE TABLE items (id int primary key, nums int[], price numeric(8,2), born date);
CREATE TABLE authors (id int primary key, name text not null);
CREATE TABLE books (id int primary key, author_id int references authors(id));`)
).migrate()
await post(db.app, '/rest/v1/authors', { id: 1, name: 'Ursula' })

console.log()
for (const [label, table, body] of [
   // A named CHECK is raised as its own error class and answers correctly — the working neighbour
   // that makes the rest read as one missing code rather than a conversion step that never runs.
   ['#3  named CHECK (int[] element)', 'items', { id: 1, nums: 'not-an-array' }],
   ['#3  unnamed CHECK (numeric(8,2))', 'items', { id: 2, price: 1.005 }],
   ['#3  unnamed CHECK (date validity)', 'items', { id: 3, born: 'not-a-date' }],
   ['#4  duplicate primary key', 'authors', { id: 1, name: 'Ursula' }],
   ['#4  NOT NULL violation', 'authors', { id: 2, name: null }],
   ['#4  dangling foreign key', 'books', { id: 1, author_id: 999 }],
] as [string, string, Record<string, unknown>][]) {
   const r = await post(db.app, `/rest/v1/${table}`, body, { Prefer: 'return=representation' })
   show(label, `${r.status} ${pgrstCode(r)} — ${String(r.body?.message ?? '').slice(0, 46)}`)
   escaped ||= r.status >= 500
}

// #4 is not a missing branch: the SQLSTATE branches are right, but the step before them never fires
// — normalizeDbError matches `err.code === 'SQLITE_CONSTRAINT_*'`, the better-sqlite3 shape, while
// the package's own driver is node:sqlite.
console.log()
const connection = db.connection as unknown as { normalizeDbError(e: unknown): { code?: string } }
try {
   await db.connection.exec("INSERT INTO authors (id, name) VALUES (1, 'again')")
} catch (e) {
   const raw = e as { code?: string; errcode?: number }
   show('raw driver error', `code=${raw.code} errcode=${raw.errcode}`)
   show('after normalizeDbError', `code=${connection.normalizeDbError(e)?.code}`)
}

console.log(
   escaped
      ? '\n  AS DESCRIBED: a caller cannot tell "you may not" or "your data is wrong" from "the server broke", so it retries what can never succeed\n'
      : '\n  DIFFERS: every refusal now answers with its own status and code — this is the patched build\n',
)
