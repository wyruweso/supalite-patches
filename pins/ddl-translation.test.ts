// Postgres DDL translated to SQLite: statements, and what is refused.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite } from '../test/harness.ts'

const translate = (sql: string): Promise<string> => lite.translatePostgresDdl(sql)

describe('tables and columns', () => {
   test('a table is emitted STRICT, and the schema qualifier is dropped', async () => {
      assert.equal(
         await translate('CREATE TABLE public.users (id serial primary key, email text not null unique);'),
         [
            'CREATE TABLE users (',
            '  id INTEGER PRIMARY KEY AUTOINCREMENT,',
            '  email TEXT NOT NULL UNIQUE',
            ') STRICT;',
         ].join('\n'),
      )
   })

   test('serial becomes INTEGER PRIMARY KEY AUTOINCREMENT', async () => {
      assert.match(await translate('CREATE TABLE t (id serial primary key);'), /id INTEGER PRIMARY KEY AUTOINCREMENT/)
   })

   test('a non-public schema is folded into the table NAME rather than kept as a schema', async () => {
      assert.match(await translate('CREATE SCHEMA app; CREATE TABLE app.t (id int);'), /CREATE TABLE "app\.t" \(/)
   })

   test('several statements come back separated by a blank line', async () => {
      const out = await translate('CREATE TABLE a (id int); CREATE TABLE b (id int);')
      assert.ok(out.includes(') STRICT;\n\nCREATE TABLE b ('))
   })
})

describe('type emulation', () => {
   const columnFor = async (pgType: string) => {
      const out = await translate(`CREATE TABLE t (c ${pgType});`)
      return out.split('\n')[1].trim().replace(/,$/, '')
   }

   test('uuid becomes TEXT with a GLOB shape check', async () => {
      assert.equal(await columnFor('uuid'), "c TEXT CHECK (c IS NULL OR c GLOB '????????-????-????-????-????????????')")
   })

   test('jsonb becomes TEXT with json_valid', async () => {
      assert.equal(await columnFor('jsonb'), 'c TEXT CHECK (c IS NULL OR json_valid(c))')
   })

   test('timestamptz becomes TEXT with a datetime check', async () => {
      assert.equal(await columnFor('timestamptz'), 'c TEXT CHECK (c IS NULL OR datetime(c) IS NOT NULL)')
   })

   test('numeric(10,2) becomes REAL with a scale and magnitude bound', async () => {
      assert.equal(
         await columnFor('numeric(10,2)'),
         'c REAL CHECK (ABS(ROUND(c * 100) - c * 100) < 0.0001 AND ABS(c) < 100000000)',
      )
   })

   test('boolean becomes INTEGER constrained to 0 or 1', async () => {
      assert.equal(await columnFor('boolean'), 'c INTEGER CHECK (c IN (0, 1))')
   })

   test('an array becomes TEXT holding a json array', async () => {
      assert.equal(await columnFor('text[]'), "c TEXT CHECK (c IS NULL OR (json_valid(c) AND json_type(c) = 'array'))")
   })

   test('a boolean DEFAULT is passed through as the postgres spelling, not 0/1', async () => {
      assert.match(
         await translate('CREATE TABLE t (e boolean default true);'),
         /e INTEGER DEFAULT true CHECK \(e IN \(0, 1\)\)/,
      )
   })

   test('an enum type becomes TEXT constrained to its labels', async () => {
      assert.match(
         await translate("CREATE TYPE mood AS ENUM ('sad','ok'); CREATE TABLE t (m mood);"),
         /m TEXT CHECK \(m IN \('sad', 'ok'\)\)/,
      )
   })
})

describe('constraints, indexes and views', () => {
   test('a foreign key keeps its referential action', async () => {
      const out = await translate(
         'CREATE TABLE a (id int primary key); CREATE TABLE b (a_id int references a(id) on delete cascade);',
      )
      assert.match(out, /a_id INTEGER REFERENCES a \(id\)\s*\n\s*ON DELETE CASCADE/)
   })

   test('an index survives translation unchanged', async () => {
      assert.match(
         await translate('CREATE TABLE t (a int); CREATE INDEX idx_t_a ON t (a);'),
         /CREATE INDEX idx_t_a ON t \(a\);/,
      )
   })

   test('ALTER TABLE ADD COLUMN is translated', async () => {
      assert.match(
         await translate('CREATE TABLE t (a int); ALTER TABLE t ADD COLUMN b text;'),
         /ALTER TABLE t\s*\n\s*ADD COLUMN b TEXT;/,
      )
   })

   test('a view is translated with its select', async () => {
      assert.match(
         await translate('CREATE TABLE t (a int, b int); CREATE VIEW v AS SELECT a FROM t;'),
         /CREATE VIEW v AS SELECT a\nFROM t;/,
      )
   })

   test('RLS statements produce no SQLite DDL of their own', async () => {
      const out = await translate(
         'CREATE TABLE t (id int, owner uuid); ALTER TABLE t ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON t FOR SELECT USING (owner = auth.uid());',
      )
      assert.match(out, /CREATE TABLE t \(/)
      assert.ok(!/POLICY/i.test(out))
      assert.ok(!/ROW LEVEL SECURITY/i.test(out))
   })

   test('a statement with no SQLite equivalent is passed through verbatim', async () => {
      assert.equal(
         await translate('CREATE EXTENSION IF NOT EXISTS pgcrypto;'),
         'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
      )
   })

   test('GRANT is dropped silently while REVOKE is refused, though both are GrantStmt', async () => {
      assert.equal(await translate('GRANT SELECT ON TABLE messages TO anon;'), '')
      await assert.rejects(
         () => translate('REVOKE SELECT ON TABLE messages FROM anon;'),
         /Unsupported node type: GrantStmt/,
      )
   })
})

describe('parse failures', () => {
   test('input that is not SQL rejects with the parser error', async () => {
      await assert.rejects(() => translate('NOT SQL AT ALL ((('), /syntax error at or near "NOT"/)
   })
})

describe('expression indexes', () => {
   test('trim is refused under the name the parser normalises it to', async () => {
      await assert.rejects(
         () => translate("CREATE TABLE t (n text); CREATE INDEX i ON t ((trim(n)));"),
         /Function call "btrim" not supported/,
      )
   })

   test('NULLIF survives, and so does CASE with an ELSE NULL', async () => {
      assert.match(await translate("CREATE TABLE t (n text); CREATE INDEX i ON t ((nullif(n, '')));"), /NULLIF \(n, ''\)/)
      assert.match(
         await translate('CREATE TABLE t (a int, n text); CREATE INDEX i ON t ((CASE WHEN a > 0 THEN n ELSE NULL END));'),
         /ELSE NULL/,
      )
   })
})
