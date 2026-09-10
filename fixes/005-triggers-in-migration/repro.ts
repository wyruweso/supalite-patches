// The translator emits triggers, but the migrator ignores standalone trigger changes.
// Run: npm run repro -- triggers-in-migration
import { newApp, type LiteConnection } from '../../test/harness.ts'

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)

console.log('\nFIX-005 — triggers never reach the database through the migrator\n')

const SCHEMA = [
   'CREATE TABLE src (id int primary key, name text);',
   'CREATE TABLE dst (id int primary key, name text);',
   'CREATE FUNCTION copy_row() RETURNS trigger AS $$ BEGIN INSERT INTO public.dst (id, name) VALUES (NEW.id, NEW.name); RETURN NEW; END; $$ LANGUAGE plpgsql;',
   'CREATE TRIGGER on_src_insert AFTER INSERT ON src FOR EACH ROW EXECUTE FUNCTION copy_row();',
].join('\n')

const triggers = async (c: LiteConnection) =>
   ((await c.exec("SELECT name FROM sqlite_master WHERE type='trigger'")).rows as { name: string }[]).map((r) => r.name)

const a: { connection: LiteConnection } = await newApp({ seed: false })
const translated = (await a.connection.translateDdl(SCHEMA)).ddl
show('translateDdl contains it', String(translated.includes('CREATE TRIGGER on_src_insert')))
await a.connection.exec(translated)
show('after exec of that DDL', JSON.stringify(await triggers(a.connection)))

const b: { connection: LiteConnection } = await newApp({ seed: false })
await (await b.connection.createMigrator(SCHEMA)).migrate()
const migrated = await triggers(b.connection)
show('after migrate of the same', JSON.stringify(migrated))
await (await b.connection.createMigrator(SCHEMA)).migrate()
show('after migrate a second time', JSON.stringify(await triggers(b.connection)))

const diff = (await (await b.connection.createMigrator(SCHEMA)).diff()) as { diff: Record<string, unknown> }
show('keys of the diff', Object.keys(diff.diff).join(', '))

console.log(
   migrated.length
      ? '\n  DIFFERS: the trigger reaches the database through the migrator — this is the patched build\n'
      : '\n  AS DESCRIBED: the migration reports success and the tables are there, so handle_new_user() and updated_at recipes fail silently\n',
)
