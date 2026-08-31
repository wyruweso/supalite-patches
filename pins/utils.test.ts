// The exported helpers.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite } from '../test/harness.ts'

describe('object helpers', () => {
   test('pick keeps the listed keys and ignores absent ones', () => {
      assert.deepEqual(lite.pick({ a: 1, b: 2, c: 3 }, ['a', 'c']), { a: 1, c: 3 })
      assert.deepEqual(lite.pick({ a: 1 }, ['a', 'z']), { a: 1 })
   })

   test('omit drops the listed keys', () => {
      assert.deepEqual(lite.omit({ a: 1, b: 2, c: 3 }, ['b']), { a: 1, c: 3 })
   })

   test('isEqual compares deeply', () => {
      assert.equal(lite.isEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true)
      assert.equal(lite.isEqual({ a: 1 }, { a: 2 }), false)
   })

   test('isEqual treats NaN as equal to itself', () => {
      assert.equal(lite.isEqual(NaN, NaN), true)
   })

   test('mergeObject recurses into nested objects', () => {
      assert.deepEqual(lite.mergeObject({ a: 1, n: { x: 1 } }, { b: 2, n: { y: 2 } }), {
         a: 1,
         n: { x: 1, y: 2 },
         b: 2,
      })
   })

   test('mergeObject overwrites scalars', () => {
      assert.deepEqual(lite.mergeObject({ a: 1 }, { a: 9 }), { a: 9 })
   })

   test('mergeObject merges arrays by index rather than replacing them', () => {
      assert.deepEqual(lite.mergeObject({ a: [1, 2] }, { a: [3] }), { a: [3, 2] })
   })

   test('objectDiff reports changed keys only, not added ones', () => {
      assert.deepEqual(lite.objectDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }), { b: 3 })
   })

   test('getPath reads a dotted path, array indices included', () => {
      assert.equal(lite.getPath({ a: { b: [{ c: 7 }] } }, 'a.b.0.c'), 7)
   })

   test('getPath throws on a path that does not resolve', () => {
      assert.throws(() => lite.getPath({ a: 1 }, 'a.b.c'), /Invalid path: a\.b\.c/)
   })

   test('setPath creates the intermediate objects', () => {
      const target = {}
      lite.setPath(target, 'a.b.c', 5)
      assert.deepEqual(target, { a: { b: { c: 5 } } })
   })
})

describe('type predicates', () => {
   test('isPlainObject accepts only plain objects', () => {
      assert.deepEqual(
         [lite.isPlainObject({}), lite.isPlainObject([]), lite.isPlainObject(null), lite.isPlainObject(new Date())],
         [true, false, false, false],
      )
   })

   test('isObject accepts arrays too', () => {
      assert.deepEqual([lite.isObject({}), lite.isObject([]), lite.isObject(null)], [true, true, false])
   })

   test('isPrimitive treats null as non-primitive', () => {
      assert.deepEqual(
         [lite.isPrimitive(1), lite.isPrimitive('a'), lite.isPrimitive(null), lite.isPrimitive({})],
         [true, true, false, false],
      )
   })

   test('isString', () => {
      assert.deepEqual([lite.isString('a'), lite.isString(1)], [true, false])
   })

   test('isBooleanLike accepts the four boolean-ish VALUES, not their spellings', () => {
      assert.deepEqual(
         [lite.isBooleanLike(true), lite.isBooleanLike(0), lite.isBooleanLike(1), lite.isBooleanLike('true')],
         [true, true, true, false],
      )
   })

   test('isEmail accepts a bare domain with no dot', () => {
      assert.deepEqual(
         [lite.isEmail('a@b.co'), lite.isEmail('nope'), lite.isEmail('a@b'), lite.isEmail('')],
         [true, false, true, false],
      )
   })
})

describe('string helpers', () => {
   test('slugify lowercases, strips accents and joins on hyphens', () => {
      assert.equal(lite.slugify('Hello World! Ünïcödé  --2'), 'hello-world-unicode-2')
   })

   test('slugify collapses input with nothing to keep to an empty string', () => {
      assert.deepEqual([lite.slugify(''), lite.slugify('___'), lite.slugify('a  b')], ['', '', 'a-b'])
   })

   test('truncate appends an ellipsis past the limit and leaves shorter input alone', () => {
      assert.equal(lite.truncate('abcdefghij', 5), 'abcde...')
      assert.equal(lite.truncate('abc', 10), 'abc')
   })

   test('ucFirst raises only the first character', () => {
      assert.equal(lite.ucFirst('hello world'), 'Hello world')
   })

   test('ucFirstAll raises every word', () => {
      assert.equal(lite.ucFirstAll('hello big world'), 'Hello Big World')
   })

   test('snakeToPascalWithSpaces', () => {
      assert.equal(lite.snakeToPascalWithSpaces('user_profile_id'), 'User Profile Id')
   })

   test('normalizeString strips accents but keeps whitespace as it found it', () => {
      assert.equal(lite.normalizeString('  Héllo   World  '), '  Hello   World  ')
   })

   test('replacePlaceholders substitutes {{name}}', () => {
      assert.equal(lite.replacePlaceholders('hi {{name}}', { name: 'bob' }), 'hi bob')
   })

   test('parseBigInt goes through Number and loses precision past 2^53', () => {
      assert.equal(String(lite.parseBigInt('123')), '123')
      assert.equal(String(lite.parseBigInt('9007199254740993')), '9007199254740992')
   })
})

describe('matching', () => {
   test('patternMatch defaults to a contains test', () => {
      assert.equal(lite.patternMatch('foobar', 'foo'), true)
   })

   test('patternMatch takes a named mode', () => {
      assert.equal(lite.patternMatch('foobar', 'foo', 'startsWith'), true)
   })

   test('patternMatch accepts a RegExp directly', () => {
      assert.equal(lite.patternMatch('foobar', /^foo/), true)
   })

   test('a /slash-delimited/ string is compiled with its slashes intact, so it does not match', () => {
      assert.equal(lite.patternMatch('foobar', '/^foo/'), false)
   })

   test('fuzzyMatch returns the closest candidate, or null when nothing is close enough', () => {
      assert.equal(lite.fuzzyMatch('selct', ['select', 'insert', 'delete']), 'select')
      assert.equal(lite.fuzzyMatch('zzzz', ['select']), null)
   })
})

describe('function helpers', () => {
   test('pipe applies left to right', () => {
      assert.equal(
         lite.pipe(
            (x: number) => x + 1,
            (x: number) => x * 2,
         )(3),
         8,
      )
   })

   test('pipeEach pipes every element of an array', () => {
      assert.deepEqual(
         lite.pipeEach(
            (x: number) => x + 1,
            (x: number) => x * 2,
         )([1, 2]),
         [4, 6],
      )
   })

   test('threw reports whether a callback threw', () => {
      assert.equal(
         lite.threw(() => {
            throw new Error('x')
         }),
         true,
      )
      assert.equal(
         lite.threw(() => 1),
         false,
      )
   })

   test('trySync returns the value, or undefined when it threw', () => {
      assert.equal(
         lite.trySync(() => 42),
         42,
      )
      assert.equal(
         lite.trySync(() => {
            throw new Error('boom')
         }),
         undefined,
      )
   })

   test('invariant throws only on a falsy condition', () => {
      assert.doesNotThrow(() => lite.invariant(true, 'fine'))
      assert.throws(() => lite.invariant(false, 'boom'), /boom/)
   })

   test('filterSearchParams keeps the entries its predicate accepts', () => {
      assert.deepEqual(
         lite.filterSearchParams(new URLSearchParams('a=1&select=x'), (k: string) => k !== 'select'),
         { a: '1' },
      )
   })
})

describe('identifiers and randomness', () => {
   test('uuid is well formed and does not repeat', () => {
      assert.match(lite.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      assert.notEqual(lite.uuid(), lite.uuid())
   })

   test('randomString honours its length and stays alphanumeric', () => {
      assert.equal(lite.randomString(16).length, 16)
      assert.match(lite.randomString(64), /^[A-Za-z0-9]+$/)
   })
})

describe('sql text helpers', () => {
   test('quote wraps in double quotes and does NOT escape embedded ones', () => {
      assert.equal(lite.quote('tbl'), '"tbl"')
      assert.equal(lite.quote('we"ird'), '"we"ird"')
   })

   test('normalizeSql collapses whitespace, drops quotes and lowercases', () => {
      assert.equal(lite.normalizeSql('  SELECT   "a"  FROM  t  '), 'select a from t')
   })

   test('cleanSql drops whole comment lines', () => {
      assert.equal(lite.cleanSql('SELECT 1\n-- comment\nFROM t'), 'SELECT 1\nFROM t')
   })

   test('splitSqlStatements splits on top-level semicolons and trims', () => {
      assert.deepEqual(lite.splitSqlStatements('CREATE TABLE a (id int); SELECT 1;'), [
         'CREATE TABLE a (id int)',
         'SELECT 1',
      ])
   })

   test('splitSqlStatements does not split inside a string literal', () => {
      assert.deepEqual(lite.splitSqlStatements("SELECT ';'; SELECT 2;"), ["SELECT ';'", 'SELECT 2'])
   })

   test('getStatementsArray strips comments first, then splits', () => {
      assert.deepEqual(lite.getStatementsArray('SELECT 1;\n-- c\nSELECT 2;'), ['SELECT 1', '\nSELECT 2'])
   })

   test('normalizeType lowercases and trims, and maps nullish to an empty string', () => {
      assert.equal(lite.normalizeType('  VARCHAR '), 'varchar')
      assert.equal(lite.normalizeType(null), '')
   })

   test('normalizeDefault unwraps a quoted literal but leaves keywords and calls alone', () => {
      assert.equal(lite.normalizeDefault("'abc'"), 'abc')
      assert.equal(lite.normalizeDefault('NULL'), 'NULL')
      assert.equal(lite.normalizeDefault("nextval('x')"), "nextval('x')")
      assert.equal(lite.normalizeDefault(null), null)
   })
})

describe('api keys', () => {
   test('apiKeyType reads the prefix, and returns null for a JWT', () => {
      assert.equal(lite.apiKeyType('sb_publishable_abc'), 'publishable')
      assert.equal(lite.apiKeyType('sb_secret_abc'), 'secret')
      assert.equal(lite.apiKeyType('eyJhbGciOi'), null)
   })

   test('generateApiKey returns key, hash, prefix and type', async () => {
      const generated = await lite.generateApiKey('publishable')
      assert.deepEqual(Object.keys(generated).sort(), ['hash', 'key', 'prefix', 'type'])
      assert.equal(generated.type, 'publishable')
      assert.ok(generated.key.startsWith('sb_publishable_'))
      assert.ok(generated.key.startsWith(generated.prefix))
      assert.equal(lite.apiKeyType(generated.key), 'publishable')
   })

   test('a secret key is generated under its own prefix', async () => {
      const generated = await lite.generateApiKey('secret')
      assert.equal(lite.apiKeyType(generated.key), 'secret')
   })

   test('two generated keys differ', async () => {
      const [a, b] = await Promise.all([lite.generateApiKey('secret'), lite.generateApiKey('secret')])
      assert.notEqual(a.key, b.key)
   })

   test('hashApiKey is base64url SHA-256 and is deterministic', async () => {
      assert.equal(await lite.hashApiKey('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
   })

   test('the recorded hash is the hash of the key', async () => {
      const generated = await lite.generateApiKey('secret')
      assert.equal(await lite.hashApiKey(generated.key), generated.hash)
   })
})

describe('passwords', () => {
   test('a long enough password passes', () => {
      assert.equal(lite.checkPasswordStrength('abcdefgh'), true)
   })

   test('a short password throws by default', () => {
      assert.throws(() => lite.checkPasswordStrength('abc'), /at least 8 characters/)
   })

   test('panic:false turns the throw into a false', () => {
      assert.equal(lite.checkPasswordStrength('abc', { panic: false }), false)
   })

   test('a digit requirement is enforced', () => {
      assert.equal(lite.checkPasswordStrength('abcdefgh', { panic: false, numbers: 2 }), false)
      assert.equal(lite.checkPasswordStrength('abcdef12', { panic: false, numbers: 2 }), true)
   })

   test('a special-character requirement is enforced', () => {
      assert.equal(lite.checkPasswordStrength('abcdefgh', { panic: false, special: 1 }), false)
      assert.equal(lite.checkPasswordStrength('abcdefg!', { panic: false, special: 1 }), true)
   })
})

describe('experimental flags', () => {
   test('a flag set by name reads back as enabled', () => {
      lite.setExperimental('some_flag', true)
      assert.equal(lite.isExperimentalEnabled('some_flag'), true)
      lite.setExperimental('some_flag', false)
      assert.equal(lite.isExperimentalEnabled('some_flag'), false)
   })

   test('listEnabledExperimentals reports only KNOWN flags, so an ad-hoc one never appears', () => {
      lite.setExperimental('not_a_real_flag', true)
      assert.ok(!lite.listEnabledExperimentals().includes('not_a_real_flag'))
      lite.setExperimental('not_a_real_flag', false)
   })
})

describe('errors and constants', () => {
   test('RelationNotFoundError carries the PostgREST schema-cache wording', () => {
      const err = new lite.RelationNotFoundError('books')
      assert.ok(err instanceof Error)
      assert.equal(err.message, "Could not find the table 'books' in the schema cache")
   })

   test('the error classes are all constructible types', () => {
      for (const name of [
         'DataLossError',
         'MigrationError',
         'RelationNotFoundError',
         'InvalidPostgresToSQLiteTranslation',
         'UnableToCreateRuntimeConnection',
      ])
         assert.equal(typeof lite[name], 'function', name)
   })

   test('PlanStepType enumerates the migration plan steps', () => {
      assert.equal(lite.PlanStepType.CREATE_TABLE, 'create_table')
      assert.equal(lite.PlanStepType.COPY_DATA, 'copy_data')
      assert.equal(lite.PlanStepType.DISABLE_FOREIGN_KEYS, 'disable_foreign_keys')
   })

   test('SELF_HOSTED_PROJECT_REF', () => {
      assert.equal(lite.SELF_HOSTED_PROJECT_REF, 'supabase-self-hosted')
   })

   test('the bundled schema SQL is emitted for auth and storage', () => {
      assert.match(lite.getAuthSchemaSql(), /CREATE SCHEMA IF NOT EXISTS auth;/)
      assert.match(lite.getStorageSchemaSql(), /CREATE SCHEMA IF NOT EXISTS storage;/)
   })
})

describe('runtime detection', () => {
   test('exactly one runtime reports true, and under node it is node', () => {
      assert.deepEqual([lite.isNode(), lite.isBun(), lite.isWorkerd()], [true, false, false])
   })
})
