# Additional findings

Defects, limitations, and compatibility differences in the published `@supabase/lite` package,
ordered by practical impact: incorrect or partially completed writes first, blocked workflows next,
then performance, tooling, and helper behavior. Likelihood and the availability of a workaround
break ties.

The five independent fixes are documented in [FINDINGS.md](FINDINGS.md). Examples here describe the
unpatched package unless stated otherwise; `pins/` records the observed behavior rather than the
desired fix.

**Rechecked on 2026-09-09:** the open findings below reproduce on `0.9.0` and `0.10.0` using
`node:sqlite`. Storage checks on `0.10.0` use a service-role token and explicit bucket `id` and `name`
to account for its changed API requirements. Resolved or implemented items are kept at the end with
their version or feature status. The project's test baseline remains `0.9.0`.

## Data and account correctness

### 1. Large bigint values are rounded on REST writes and fail on reads

Values outside JavaScript's safe integer range are not preserved by the REST write path, even
when supplied as decimal strings. With a `bigint` column, the value `"9007199254740993"` gives:

| Operation                                         | Response | Stored value                               |
| ------------------------------------------------- | -------- | ------------------------------------------ |
| POST with the default minimal response            | `201`    | `9007199254740992`                         |
| POST with `Prefer: return=representation`         | `500`    | `9007199254740992`; the row remains stored |
| GET after inserting the exact integer through SQL | `500`    | The SQL-written value remains exact        |

The read error is `RangeError: Value is too large to be represented as a JavaScript number`.
A failed response does not guarantee that the write was rolled back, so retrying it can encounter
an already-created row. Both input conversion and result serialization need to preserve the integer.

The exported helper `parseBigInt('9007199254740993')` also returns `9007199254740992`. No internal
callers of that helper were found; fixing it alone would not establish a fix for REST.

Tests: [REST writes and stored values](pins/additional-findings.test.ts),
[numeric helpers](pins/utils.test.ts).

### 2. Adding a foreign key accepts existing orphan rows

A migration can report success while leaving data that violates the new constraint:

```sql
-- Initially parent_id has no foreign key; parent 999 does not exist.
CREATE TABLE parents (id int primary key);
CREATE TABLE children (id int primary key, parent_id int);
INSERT INTO children VALUES (1, 999);

-- Desired schema changes parent_id to:
-- parent_id int REFERENCES parents(id)
```

`migrate()` succeeds without `force`. The foreign key exists and rejects new invalid inserts, but
`SELECT * FROM pragma_foreign_key_check` still reports the original orphan row.

The rebuild copies data while foreign keys are disabled and does not validate it before committing.
Re-enabling enforcement does not validate existing rows. The
[SQLite rebuild procedure](https://sqlite.org/lang_altertable.html#making_other_kinds_of_table_schema_changes)
includes `foreign_key_check` before commit; violations should roll back the migration.

Test: [migration integrity](pins/additional-findings.test.ts).

### 3. CSV rows with extra fields are truncated

```text
POST /rest/v1/authors
Content-Type: text/csv

id,name
1,A,surplus
```

The response is `201`, and the inserted row is `{ "id": 1, "name": "A" }`. The extra field is
silently discarded.

This can make an incorrectly delimited import appear successful while losing data. The JSON batch
path already rejects objects with differing keys using `PGRST102`.

Test: [CSV requests](pins/postgrest-csv.test.ts).

### 4. Storage `PUT` writes multipart data without parsing it

`POST /storage/v1/object/:bucket/*` parses multipart data and stores the file part. `PUT` on the same
path stores the request body directly. Sending `FormData` to `PUT` therefore stores the multipart
boundaries and headers along with the file contents.

Raw-byte bodies work correctly with `PUT`.

Test: [storage object replacement](pins/storage.test.ts).

### 5. COLLATE is silently removed from index definitions

The translator accepts an index collation but drops it:

```sql
CREATE UNIQUE INDEX contact_email ON contacts(email COLLATE "NOCASE");
-- Translated: CREATE UNIQUE INDEX contact_email ON contacts(email);
```

The resulting index accepts both `Alice@example.test` and `alice@example.test`. A control index
created directly in SQLite with `COLLATE NOCASE` rejects the second value.

PostgreSQL and SQLite collations are not generally interchangeable. `NOCASE` here is a SQLite
control, not a built-in PostgreSQL collation. The issue is accepting the clause and silently changing
its meaning; unsupported collations should be rejected unless an equivalent is explicitly supported.
[SQLite index collations](https://sqlite.org/lang_createindex.html) affect uniqueness as well as ordering.

This occurs before migration planning and also affects ordinary indexes, independently of FIX-001.

Test: [translated index and SQLite control](pins/additional-findings.test.ts).

### 6. An email change sends confirmation only to the current address

For an account with an existing email address, `PUT /auth/v1/user {email}` stages the change and sends
the confirmation to the current address. Nothing is sent to the new address under the default
configuration tested here.

[GoTrue's secure email-change flow](https://github.com/supabase/auth/blob/master/internal/api/mail.go)
prepares confirmation tokens for both addresses. The observed flow does not verify that the user
can receive mail at the new address.

Test: [email changes](pins/auth-users.test.ts).

## Blocked requests and migrations

### 7. Storage writes and reads use different object versions

The adapter receives different version values for the same object:

| Operation      | Version argument                             |
| -------------- | -------------------------------------------- |
| `uploadObject` | `undefined`                                  |
| `getObject`    | The UUID stored in `storage.objects.version` |

An adapter that includes the version in its object key writes `b/a.txt@none` and later tries to read
`b/a.txt@<uuid>`. The read fails even though the uploaded object is still in the store. `copyObject`
has the same mismatch.

Adapters that ignore the version argument avoid this problem, but cannot use it for object versioning.

Tests: [storage adapter versions](pins/storage.test.ts).

### 8. Missing JWT claims cause RLS errors; issued tokens omit metadata

A policy can be accepted during migration and fail later when the caller's JWT lacks a referenced
claim:

```sql
CREATE POLICY p ON notes FOR ALL
  USING (team = auth.jwt() ->> 'team')
  WITH CHECK (true);
```

A read with no `team` claim returns `500`:

```json
{ "code": "SUP", "message": "Error: Unresolved variable: {{auth.jwt.team}}" }
```

The translator creates a placeholder for the claim, and the resolver throws when it cannot find
the value. PostgreSQL evaluates the missing claim as `NULL`, which causes this policy to filter out
the row. The problem is missing-claim handling, rather than every use of `auth.jwt()`.

There is a separate limitation in token generation. Signup metadata is stored and returned on the
user, but the access token omits both `user_metadata` and `app_metadata`:

```text
user.user_metadata:  { "team": "red", ... }
access token:        no user_metadata or app_metadata claims
```

Policies cannot read metadata that the token does not contain. Fixing the missing-claim error alone
would not make that metadata available. Signup metadata belongs under `user_metadata`; a top-level
`team` claim would need to be supplied separately.

Other unsupported policy expressions fail earlier, during migration:

| Expression          | Translation error                                    |
| ------------------- | ---------------------------------------------------- |
| `BETWEEN`           | `Unsupported expression: A_Expr kind: AEXPR_BETWEEN` |
| `current_setting()` | `Unsupported expression: FuncCall: current_setting`  |
| `COALESCE`          | `Unsupported expression: deparseValue: CoalesceExpr` |

Tests: [RLS expressions](pins/rls-expressions.test.ts), [JWT contents](pins/auth.test.ts).

### 9. A dependent view blocks a table rebuild

A table with a working view can become impossible to migrate:

```sql
CREATE TABLE items (id int primary key, name text);
CREATE VIEW item_names AS SELECT id, name FROM items;
-- Adding CREATE INDEX items_name_idx ON items(name) causes a rebuild.
```

The rename of the temporary table fails with:

```text
error in view item_names: no such table: main.items
```

The view survives the old table's removal and refers to a table that temporarily does not exist.
[SQLite validates these references during ALTER TABLE](https://sqlite.org/lang_altertable.html),
but the plan does not remove and recreate dependent views around the rebuild.

The failed migration rolls back: existing rows and the view remain usable, and foreign keys are
re-enabled. FIX-005 handles the corresponding trigger case; views need separate handling. An
index-only change can avoid this failure by creating the index without rebuilding the table.

Test: [view failure and rollback](pins/additional-findings.test.ts).

### 10. Migration planning loses index expressions

Expression indexes translate correctly and work when the translated DDL is executed directly. The
schema model loses the expression when the index is introspected:

```sql
CREATE UNIQUE INDEX k ON t (a, (nullif(n, '')));
```

```text
Introspected columns: ["a", null]
Planned SQL:          CREATE UNIQUE INDEX "k" ON "t" ("a", "null");
Execution error:      no such column: "null"
```

`pragma_index_info` reports a null column name for an expression, and the planner treats that value
as an identifier. `NULLIF`, `CASE`, and mixed column/expression indexes show the same problem.

The failure occurs when the migrator needs to generate an index-creation step. An unchanged index
that requires no such step does not exercise this path, which is why the expression index in
[FEAT-003](features/003-mfa-totp/)'s schema is unaffected.

Tests: [expression index migration](pins/migration-plan.test.ts).

### 11. `bytea` has no REST binary conversion

A `bytea` column translates to SQLite `BLOB`, and binary values can be written through the
connection. The tested JSON representations fail through REST:

| JSON value                                        | Result                                    |
| ------------------------------------------------- | ----------------------------------------- |
| `"\\x48656c6c6f"` (PostgreSQL hex representation) | `500`: cannot store TEXT in a BLOB column |
| `"Hello"`                                         | Same TEXT-to-BLOB error                   |
| `"SGVsbG8="` (base64)                             | Same TEXT-to-BLOB error                   |
| `[72, 101, 108]`                                  | `500`: unsupported parameter type         |
| `null`                                            | `201`                                     |

Reads also lack a binary encoding. Bytes inserted through the connection come back as a
numeric-keyed object:

```json
[{ "blob": { "0": 222, "1": 173 } }]
```

The REST interface needs conversion between its JSON representation and the stored bytes.

PostgreSQL accepts the hex representation, so the correct answer to the first row is a successful
insert rather than a different status code. [FIX-002](fixes/002-client-errors-as-500/) leaves
`SQLITE_CONSTRAINT_DATATYPE` unmapped for that reason: reporting a client error here would describe a
missing conversion as bad input.

Tests: [REST value handling](pins/postgrest-values.test.ts).

### 12. DDL through `exec()` leaves the schema cache stale

After the first REST request populates the schema cache, a table created through `connection.exec()`
is not visible to subsequent REST requests:

```text
PGRST205: Could not find the table 'docs' in the schema cache
```

The table exists in SQLite, but the cached schema has not been refreshed. Calling
`Connection.clearSchemaCache()` makes it visible. The migrator's `diff()` also re-reads the schema,
so that path refreshes the cache.

Test: [cache invalidation](pins/additional-findings.test.ts).

### 13. Cyrillic table names fail when a query string is present

A table named `книги` can be created and written to. A read succeeds until a query parameter is added:

```text
GET /rest/v1/книги            -> 200 [{"id":1,"name":"x"}]
GET /rest/v1/книги?select=id  -> 500 TypeError: Cannot convert argument to a ByteString
GET /rest/v1/книги?id=eq.1    -> 500, same error
```

For requests with a query string, the response sets `Content-Location` using the table name without
percent-encoding it. Characters such as `к` exceed the header's ByteString range, so the failure
occurs while building the response headers, after the query has run.

Unicode values in query parameters are percent-encoded correctly; this example concerns the table
name in the generated header.

Tests: [Content-Location handling](pins/postgrest-negotiation.test.ts).

### 14. `quote()` leaves embedded double quotes unescaped

```js
quote('tbl') // '"tbl"'
quote('we"ird') // '"we"ird"'
```

The second result should be `"we""ird"`. The migration planner uses this helper when generating DDL,
so an identifier containing a double quote can produce invalid SQL:

```sql
ALTER TABLE "we"ird" ADD COLUMN "extra" text;
```

The observed migration fails with `near "ird": syntax error`.

Tests: [SQL helpers](pins/utils.test.ts), [generated ALTER](pins/additional-findings.test.ts).

### 15. `trim()` is rejected as `btrim` during DDL translation

```sql
CREATE INDEX i ON t ((trim(note)));
```

The PostgreSQL parser normalizes `trim` to `btrim`. The translator does not recognize that name and
returns `Function call "btrim" not supported`, even though SQLite supports the intended operation.

Test: [DDL expression translation](pins/ddl-translation.test.ts).

## Performance, types, and API limitations

### 16. Adding only an index rebuilds the table

Adding only a `CREATE INDEX` statement produces a diff with no table or column changes. The plan
still creates a temporary table, copies the rows, drops the original, renames the copy, and finally
creates the index.

SQLite supports creating an index directly. The extra rebuild adds a full table copy, temporary
storage, and a period with foreign-key checks disabled.

With a dependent view, the rebuild can also fail; see the view finding above.

Test: [migration plans](pins/migration-plan.test.ts).

### 17. Array element types are not applied

Supplying `ddlDialect: 'postgres'`, or running `0.9.1-next.2` or later where it is defaulted, returns
arrays as arrays. Their elements are still returned as stored:

```jsonc
// written: { "flags": [true, false], "nums": [1, 2], "names": ["a"] }
[{ "flags": [1, 0], "nums": [1, 2], "names": ["a"] }]
```

The merged metadata records the element type as the scalar it is — `pg_type: "bool"` for a column
declared `boolean[]` — and nothing maps the elements through it. `int[]` and `text[]` are unaffected,
because their JSON representation already matches the stored values.

This is separate from [FIX-003](fixes/003-value-types/), which restores the declared types. It was
reproduced on `0.10.0` as well.

Test: [array elements with explicit Postgres metadata](pins/additional-findings.test.ts).

### 18. Every count mode executes an exact count on SQLite

On the SQLite backend, `count=exact`, `count=planned`, and `count=estimated` all execute an exact
count. Callers receive the correct total, but choosing an estimated mode does not reduce query cost.

The count dispatcher falls back to the exact query when the backend is not PostgreSQL. This is a
SQLite performance limitation; it is not a claim about the package's PostgreSQL backend.

Test: [count preferences](pins/postgrest-negotiation.test.ts).

### 19. The OpenAPI response contains no routes or models

`GET /rest/v1/` returns JSON with Swagger 2.0 metadata: `swagger`, `info`, `basePath`, `schemes`,
`consumes`, and `produces`. It omits `paths` and `definitions`, so it provides no table endpoints or
row models for documentation and client generation.

Test: [OpenAPI response](pins/system.test.ts).

### 20. Migration plans have no step type for removing a trigger

`PlanStepType` declares `create_trigger`, and both halves for every other object: `add_column` and
`drop_column`, `add_index` and `drop_index`, `create_table` and `drop_table`. There is no
`drop_trigger`.

The published planner can recreate triggers during a table rebuild, but it does not track
standalone trigger additions, removals, or redefinitions. [FIX-005](fixes/005-triggers-in-migration/)
adds that handling and emits `drop_trigger`, which the enumeration does not list.

The executor runs the SQL without consulting the type, so this affects consumers that render, filter,
or audit a plan by step type.

Test: [declared plan step types](pins/additional-findings.test.ts).

## Helper behavior and diagnostics

### 21. `mergeObject` merges arrays by index

```js
mergeObject({ a: [1, 2] }, { a: [3] }) // { a: [3, 2] }
```

A shorter incoming array leaves the remaining elements of the original array in place. Using this
helper for configuration overrides therefore cannot shorten a list by supplying a shorter array.

Test: [object helpers](pins/utils.test.ts).

### 22. `objectDiff` omits added keys

```js
objectDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }) // { b: 3 }
```

The helper iterates only the first object's keys, so it does not report `c`. It can compare values
within an existing shape, but does not describe every difference between two objects.

Test: [object helpers](pins/utils.test.ts).

### 23. String regex patterns retain their slash delimiters

```js
patternMatch('foobar', /^foo/) // true
patternMatch('foobar', '/^foo/') // false
patternMatch('foobar', '^foo', 'regex') // true
```

A leading `/` selects regex mode, but the whole string, including the delimiters, is passed to
`new RegExp`. Pass a `RegExp` object or select regex mode explicitly to avoid this behavior.

Test: [pattern matching](pins/utils.test.ts).

### 24. Unknown experimental flags can be enabled but are not listed

`setExperimental('anything', true)` stores the flag, and `isExperimentalEnabled('anything')` returns
`true`. However, `listEnabledExperimentals()` reports only a fixed set of known flags.

A misspelled flag can therefore read back as enabled without appearing in the listing or activating
any feature.

Test: [experimental flags](pins/utils.test.ts).

### 25. Relationship errors report a hardcoded schema name

```text
GET /rest/v1/books?select=title,nope(x)

Searched for a foreign key relationship between 'books' and 'nope'
 in the schema 'test', but no matches were found.
```

The request uses `public`, but the `PGRST200` message names `test`. The schema name in the error is
hardcoded, making relationship failures harder to diagnose.

Test: [relationship error details](pins/postgrest-select-syntax.test.ts).

## Fixed upstream or implemented here

### 26. Soft deletion is absent upstream and provided by FEAT-002

The unpatched package has a `deleted_at` column but no admin soft-delete path. Ordinary signup,
sign-in, and user updates leave the column unchanged.

[FEAT-002](features/002-admin-user-api/) implements soft deletion and rejects deleted users at
session creation. This item describes a gap in the published package, already addressed by a feature
in this repository; it is not an additional request to implement it again.

Tests: [published user lifecycle](pins/auth-users.test.ts),
[FEAT-002 deletion behavior](features/002-admin-user-api/test.ts).

### 27. Extension statements fail in 0.9.0 and are skipped in 0.10.0

In `0.9.0`, the translator passes `CREATE EXTENSION` through unchanged:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE t (id uuid primary key default gen_random_uuid(), name text);
```

Migration then fails with `near "EXTENSION": syntax error`. `DROP EXTENSION` is rejected during
translation.

In the rechecked `0.10.0`, both statements translate to no SQLite DDL. This removes the syntax
failure; it does not install or emulate the extension. Earlier comparison found the change already
present in `0.9.1-next.1`.

Test: [0.9.0 DDL translation](pins/ddl-translation.test.ts).

## Other compatibility observations

These cases are recorded for compatibility, without treating them as additional defects:

- `getPath()` throws when a path cannot be resolved.
- `isEmail('a@b')` accepts a domain without a dot.
- `isBooleanLike()` accepts `true`, `false`, `0`, and `1`; it rejects the string `'true'`.
- `/_system/*` is outside the API-key guard. Its config response redacts `jwt_secret`.
- The API-key guard is disabled unless `auth.publishable_key` or `auth.secret_key` is configured;
  unrecognized keys are ignored in that configuration.
- A configured secret key uses `service_role` and bypasses RLS.
- A signed storage URL works without an `Authorization` header; its JWT carries `sub`, `bucket`,
  `intent`, `iat`, and `exp`.
- A magic-link request for an unknown address still returns `200`.
- `0.10.0` adds a local admin mode, enabled by default for loopback listeners, in which keyless
  same-origin requests run as `service_role`. Recorded from its documentation; not reviewed further.

## Schema compatibility checks

| SQL pattern                                   | Observed result                                |
| --------------------------------------------- | ---------------------------------------------- |
| `REFERENCES auth.users(id) ON DELETE CASCADE` | Translates and enforces the constraint         |
| `USING (owner = (SELECT auth.uid()))`         | Works, as does the direct `auth.uid()` form    |
| `GRANT`, `COMMENT ON`                         | Produce no SQLite DDL; migration proceeds      |
| `(storage.foldername(name))[1]` in a policy   | Rejected during migration with `A_Indirection` |

Additional checks confirmed that failed rebuilds restore foreign-key enforcement, rebuilding a
parent table preserves its children, and `ON DELETE CASCADE` still works afterwards. With FIX-005,
a profile trigger on `auth.users` works with ordinary signup, FEAT-001 anonymous signup, and
FEAT-002 admin creation; a trigger failure rolls back user creation, and hard deletion removes the
profile through its foreign key. These are successful compatibility checks, not additional defects.
