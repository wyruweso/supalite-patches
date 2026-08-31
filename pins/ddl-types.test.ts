// How each Postgres column type lands in SQLite, and the checks generated with it.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite } from '../test/harness.ts'

const translate = (sql: string): Promise<string> => lite.translatePostgresDdl(sql)

const columnFor = async (pgType: string) => {
   const out = await translate(`CREATE TABLE t (c ${pgType});`)
   return out.split('\n')[1].trim().replace(/,$/, '')
}

describe('numeric types', () => {
   for (const pgType of ['smallint', 'int', 'integer', 'bigint', 'int8'])
      test(`${pgType} becomes a plain INTEGER`, async () => {
         assert.equal(await columnFor(pgType), 'c INTEGER')
      })

   for (const pgType of ['real', 'double precision', 'numeric'])
      test(`${pgType} becomes a plain REAL`, async () => {
         assert.equal(await columnFor(pgType), 'c REAL')
      })

   test('an unqualified numeric gets no precision check, but a qualified one does', async () => {
      assert.equal(await columnFor('numeric'), 'c REAL')
      assert.equal(
         await columnFor('decimal(4,1)'),
         'c REAL CHECK (ABS(ROUND(c * 10) - c * 10) < 0.0001 AND ABS(c) < 1000)',
      )
   })

   test('bigserial becomes INTEGER, like every other serial', async () => {
      assert.equal(await columnFor('bigserial'), 'c INTEGER')
      assert.equal(await columnFor('serial8'), 'c INTEGER')
   })
})

describe('text and binary types', () => {
   test('text and bpchar are unconstrained TEXT', async () => {
      assert.equal(await columnFor('text'), 'c TEXT')
      assert.equal(await columnFor('bpchar'), 'c TEXT')
   })

   test('a declared length becomes a length CHECK', async () => {
      assert.equal(await columnFor('varchar(20)'), 'c TEXT CHECK (length(c) <= 20)')
      assert.equal(await columnFor('char(4)'), 'c TEXT CHECK (length(c) <= 4)')
   })

   test('char(n) is checked as a MAXIMUM, so it does not pad or require exactly n', async () => {
      assert.match(await columnFor('char(4)'), /length\(c\) <= 4/)
   })

   test('bytea becomes BLOB', async () => {
      assert.equal(await columnFor('bytea'), 'c BLOB')
   })
})

describe('temporal types', () => {
   test('date is checked with date()', async () => {
      assert.equal(await columnFor('date'), 'c TEXT CHECK (c IS NULL OR date(c) IS NOT NULL)')
   })

   test('time and timetz share one check, so the zone is not preserved', async () => {
      const expected = 'c TEXT CHECK (c IS NULL OR time(c) IS NOT NULL)'
      assert.equal(await columnFor('time'), expected)
      assert.equal(await columnFor('timetz'), expected)
   })

   test('timestamp and timestamptz share one check too', async () => {
      const expected = 'c TEXT CHECK (c IS NULL OR datetime(c) IS NOT NULL)'
      assert.equal(await columnFor('timestamp'), expected)
      assert.equal(await columnFor('timestamptz'), expected)
   })

   test('interval is the one temporal type with NO validation at all', async () => {
      assert.equal(await columnFor('interval'), 'c TEXT')
   })
})

describe('network and structured types', () => {
   test('inet is length-bounded and required to contain a dot or a colon', async () => {
      assert.equal(
         await columnFor('inet'),
         "c TEXT CHECK (c IS NULL OR (length(c) BETWEEN 3 AND 49 AND (instr(c, '.') > 0 OR instr(c, ':') > 0)))",
      )
   })

   test('json and jsonb are both validated with json_valid', async () => {
      const expected = 'c TEXT CHECK (c IS NULL OR json_valid(c))'
      assert.equal(await columnFor('json'), expected)
      assert.equal(await columnFor('jsonb'), expected)
   })

   test('every array element type produces the same untyped json-array check', async () => {
      const expected = "c TEXT CHECK (c IS NULL OR (json_valid(c) AND json_type(c) = 'array'))"
      for (const pgType of ['uuid[]', 'int[]', 'boolean[]', 'text[]'])
         assert.equal(await columnFor(pgType), expected, pgType)
   })
})

describe('types with no translation', () => {
   for (const pgType of ['money', 'cidr', 'macaddr', 'xml', 'point', 'tsvector', 'citext'])
      test(`${pgType} is refused with a named error`, async () => {
         await assert.rejects(
            () => translate(`CREATE TABLE t (c ${pgType});`),
            new RegExp(`Unsupported PostgreSQL type: "${pgType}"`),
         )
      })
})

describe('defaults', () => {
   test("now() becomes datetime('now')", async () => {
      assert.match(await columnFor('timestamptz default now()'), /DEFAULT \(datetime\('now'\)\)/)
   })

   test('gen_random_uuid() is emulated with randomblob, and is version-4 shaped', async () => {
      const column = await columnFor('uuid default gen_random_uuid()')
      assert.match(column, /randomblob\(4\)/)
      assert.match(column, /\|\| '-4' \|\|/)
      assert.match(column, /substr\('89ab',abs\(random\(\)\) % 4 \+ 1, 1\)/)
   })

   test('a literal default is passed through', async () => {
      assert.match(await columnFor("text default 'hi'"), /DEFAULT 'hi'/)
      assert.match(await columnFor('int default 7'), /DEFAULT 7/)
   })
})

describe('table-level constraints', () => {
   test('a composite primary key is emitted as a table constraint', async () => {
      assert.match(await translate('CREATE TABLE t (a int, b int, primary key (a,b));'), /PRIMARY KEY \(a, b\)/)
   })

   test('a composite unique constraint is kept', async () => {
      assert.match(await translate('CREATE TABLE t (a int, b int, unique (a,b));'), /UNIQUE \(a, b\)/)
   })

   test('a column CHECK is kept verbatim', async () => {
      assert.match(await translate('CREATE TABLE t (c int check (c > 0));'), /c INTEGER CHECK \(c > 0\)/)
   })

   test('GENERATED ALWAYS AS ... STORED survives', async () => {
      assert.match(
         await translate('CREATE TABLE t (a int, b int generated always as (a*2) stored);'),
         /b INTEGER GENERATED ALWAYS AS \(a \* 2\) STORED/,
      )
   })

   test('an identity column becomes the autoincrement primary key', async () => {
      assert.match(
         await translate('CREATE TABLE t (id int generated always as identity primary key);'),
         /id INTEGER PRIMARY KEY AUTOINCREMENT/,
      )
   })

   test('COMMENT ON produces no DDL', async () => {
      const out = await translate("CREATE TABLE t (a int); COMMENT ON TABLE t IS 'hi';")
      assert.ok(!/COMMENT/i.test(out))
   })
})

describe('indexes', () => {
   test('a unique index stays unique', async () => {
      assert.equal(await translate('CREATE UNIQUE INDEX u ON t (a);'), 'CREATE UNIQUE INDEX u ON t (a);')
   })

   test('a descending index keeps its direction', async () => {
      assert.equal(await translate('CREATE INDEX d ON t (a DESC);'), 'CREATE INDEX d ON t (a DESC);')
   })

   test('an expression index is wrapped in the parentheses SQLite requires', async () => {
      assert.equal(await translate('CREATE INDEX e ON t (lower(name));'), 'CREATE INDEX e ON t ((lower(name)));')
   })
})

describe('schema-level statements', () => {
   test('DROP TABLE passes through', async () => {
      assert.equal(await translate('DROP TABLE t;'), 'DROP TABLE t;')
   })

   test('ALTER TABLE RENAME passes through', async () => {
      assert.equal(await translate('ALTER TABLE t RENAME TO t2;'), 'ALTER TABLE t RENAME TO t2;')
   })

   test('ALTER TABLE DROP COLUMN is translated', async () => {
      assert.match(await translate('ALTER TABLE t DROP COLUMN a;'), /ALTER TABLE t\s*\n\s*DROP COLUMN a;/)
   })
})

describe('plpgsql functions become sqlite triggers', () => {
   const TRIGGER_DDL = `
      CREATE TABLE t (id int, updated_at timestamptz);
      CREATE FUNCTION touch() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER t_touch BEFORE UPDATE ON t FOR EACH ROW EXECUTE FUNCTION touch();
   `

   test('the function itself emits nothing - only the trigger that uses it does', async () => {
      const out = await translate(TRIGGER_DDL)
      assert.ok(!/CREATE FUNCTION/i.test(out))
      assert.match(out, /CREATE TRIGGER t_touch/)
   })

   test('the trigger keeps its timing, event and row scope', async () => {
      const out = await translate(TRIGGER_DDL)
      assert.match(out, /CREATE TRIGGER t_touch\nBEFORE UPDATE ON t\nFOR EACH ROW/)
   })

   test('the plpgsql body is rewritten into an UPDATE, because SQLite cannot assign to NEW', async () => {
      const out = await translate(TRIGGER_DDL)
      assert.match(out, /BEGIN\n\s*UPDATE t SET updated_at = datetime\('now'\) WHERE rowid = NEW\.rowid;\nEND;/)
   })

   test('an AFTER INSERT trigger is translated too', async () => {
      const out = await translate(`
         CREATE TABLE t (id int, seen_at timestamptz);
         CREATE FUNCTION mark() RETURNS trigger AS $$ BEGIN NEW.seen_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
         CREATE TRIGGER t_mark AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION mark();
      `)
      assert.match(out, /CREATE TRIGGER t_mark\nAFTER INSERT ON t/)
   })
})
