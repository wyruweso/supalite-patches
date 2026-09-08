# Additional findings

Additional defects, limitations, and compatibility differences observed in the published
`@supabase/lite@0.9.0` package. The five fixes are documented separately in [FINDINGS.md](FINDINGS.md).

Examples below describe the unpatched package. Version changes and related feature implementations
are noted where relevant. Links to `pins/` point to tests that record the observed behavior.

Everything here was re-measured on `0.10.0`, the current `latest`. Only `CREATE EXTENSION`
translation (item 2) is fixed there; the rest were reproduced unchanged.

## Request and migration failures

### 1. Missing JWT claims cause RLS errors; issued tokens omit metadata

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
access token claims: sub, aud, role, email, session_id, iat, exp
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

### 2. `CREATE EXTENSION` reaches SQLite unchanged

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE t (id uuid primary key default gen_random_uuid(), name text);
```

In `0.9.0`, the translator passes `CREATE EXTENSION` through unchanged. Executing the migration then
fails with `near "EXTENSION": syntax error`. `DROP EXTENSION` is rejected during translation.

**Version note:** the comparison with `0.9.1-next.1` found this fixed upstream: extension statements
translate to no SQLite DDL. The observation is retained here for the `0.9.0` baseline.

Test: [DDL translation](pins/ddl-translation.test.ts).

### 3. `bytea` has no REST binary conversion

A `bytea` column translates to SQLite `BLOB`, and binary values can be written through the
connection. The tested JSON representations fail through REST:

| JSON value                                       | Result                                    |
| ------------------------------------------------ | ----------------------------------------- |
| `"\x48656c6c6f"` (PostgreSQL hex representation) | `500`: cannot store TEXT in a BLOB column |
| `"Hello"`                                        | Same TEXT-to-BLOB error                   |
| `"SGVsbG8="` (base64)                            | Same TEXT-to-BLOB error                   |
| `[72, 101, 108]`                                 | `500`: unsupported parameter type         |
| `null`                                           | `201`                                     |

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

### 4. Cyrillic table names fail when a query string is present

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

### 5. Storage writes and reads use different object versions

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

### 6. `quote()` leaves embedded double quotes unescaped

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

Test: [SQL helpers](pins/utils.test.ts).

## Schema handling and API behavior

### 7. DDL through `exec()` leaves the schema cache stale

After the first REST request populates the schema cache, a table created through `connection.exec()`
is not visible to subsequent REST requests:

```text
PGRST205: Could not find the table 'docs' in the schema cache
```

The table exists in SQLite, but the cached schema has not been refreshed. Calling
`Connection.clearSchemaCache()` makes it visible. The migrator's `diff()` also re-reads the schema,
so that path refreshes the cache.

### 8. Adding an index rebuilds the table

Adding only a `CREATE INDEX` statement produces a diff with no table or column changes. The plan
still creates a temporary table, copies the rows, drops the original, renames the copy, and finally
creates the index.

SQLite supports creating an index directly. The extra rebuild adds a full table copy, temporary
storage, and a period with foreign-key checks disabled.

Test: [migration plans](pins/migration-plan.test.ts).

### 9. Migration planning loses index expressions

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

### 10. Array element types are not applied

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

### 11. Migration plans have no step type for removing a trigger

`PlanStepType` declares `create_trigger`, and both halves for every other object: `add_column` and
`drop_column`, `add_index` and `drop_index`, `create_table` and `drop_table`. There is no
`drop_trigger`.

The published package never plans trigger work, so it does not need one: a trigger is removed only
along with its table. [FIX-005](fixes/005-triggers-in-migration/) has to remove triggers before a
table is rebuilt, and emits a step type the enumeration does not list.

The executor runs the SQL without consulting the type, so this affects consumers that render, filter,
or audit a plan by step type.

### 12. CSV rows with extra fields are truncated

```text
POST /rest/v1/authors
Content-Type: text/csv

id,name
1,A,surplus
```

The response is `201`, and the inserted row is `{ "id": 1, "name": "A" }`. The extra field is
silently discarded. PostgREST rejects rows whose field count does not match the header.

This can make an incorrectly delimited import appear successful while losing data. The JSON batch
path already rejects objects with differing keys using `PGRST102`.

Test: [CSV requests](pins/postgrest-csv.test.ts).

### 13. String regex patterns retain their slash delimiters

```js
patternMatch('foobar', /^foo/) // true
patternMatch('foobar', '/^foo/') // false
patternMatch('foobar', '^foo', 'regex') // true
```

A leading `/` selects regex mode, but the whole string, including the delimiters, is passed to
`new RegExp`. Pass a `RegExp` object or select regex mode explicitly to avoid this behavior.

Test: [pattern matching](pins/utils.test.ts).

### 14. `trim()` is rejected as `btrim` during DDL translation

```sql
CREATE INDEX i ON t ((trim(note)));
```

The PostgreSQL parser normalizes `trim` to `btrim`. The translator does not recognize that name and
returns `Function call "btrim" not supported`, even though SQLite supports the intended operation.

Test: [DDL expression translation](pins/ddl-translation.test.ts).

### 15. Relationship errors report a hardcoded schema name

```text
GET /rest/v1/books?select=title,nope(x)

Searched for a foreign key relationship between 'books' and 'nope'
 in the schema 'test', but no matches were found.
```

The request uses `public`, but the `PGRST200` message names `test`. The schema name in the error is
hardcoded, making relationship failures harder to diagnose.

Test: [relationship error details](pins/postgrest-select-syntax.test.ts).

## API limitations and helper behavior

### 16. The OpenAPI response contains no routes or models

`GET /rest/v1/` returns JSON with Swagger 2.0 metadata: `swagger`, `info`, `basePath`, `schemes`,
`consumes`, and `produces`. It omits `paths` and `definitions`, so it provides no table endpoints or
row models for documentation and client generation.

Test: [OpenAPI response](pins/system.test.ts).

### 17. All count modes perform an exact count

`count=exact`, `count=planned`, and `count=estimated` all perform an exact count. Callers receive the
exact total, but choosing an estimated mode does not reduce the counting cost.

Test: [count preferences](pins/postgrest-negotiation.test.ts).

### 18. Storage `PUT` writes multipart data without parsing it

`POST /storage/v1/object/:bucket/*` parses multipart data and stores the file part. `PUT` on the same
path stores the request body directly. Sending `FormData` to `PUT` therefore stores the multipart
boundaries and headers along with the file contents.

Raw-byte bodies work correctly with `PUT`.

Test: [storage object replacement](pins/storage.test.ts).

### 19. An email change sends confirmation only to the current address

For an account with an existing email address, `PUT /auth/v1/user {email}` stages the change and sends
the confirmation to the current address. Nothing is sent to the new address under the default
configuration tested here.

GoTrue's secure email-change flow sends confirmation to both addresses. The observed flow does not
verify that the user can receive mail at the new address.

Test: [email changes](pins/auth-users.test.ts).

### 20. The published package does not implement soft deletion

`auth.users` has a `deleted_at` column, but the published bundle does not set or check it. Signup,
sign-in, and user updates leave it unchanged.

[FEAT-002](features/002-admin-user-api/) adds a soft-delete path; this finding describes the original
package.

Test: [user lifecycle](pins/auth-users.test.ts).

### 21. `objectDiff` omits added keys

```js
objectDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }) // { b: 3 }
```

The helper iterates only the first object's keys, so it does not report `c`. It can compare values
within an existing shape, but does not describe every difference between two objects.

Test: [object helpers](pins/utils.test.ts).

### 22. `mergeObject` merges arrays by index

```js
mergeObject({ a: [1, 2] }, { a: [3] }) // { a: [3, 2] }
```

A shorter incoming array leaves the remaining elements of the original array in place. Using this
helper for configuration overrides therefore cannot shorten a list by supplying a shorter array.

Test: [object helpers](pins/utils.test.ts).

### 23. Unknown experimental flags can be enabled but are not listed

`setExperimental('anything', true)` stores the flag, and `isExperimentalEnabled('anything')` returns
`true`. However, `listEnabledExperimentals()` reports only a fixed set of known flags.

A misspelled flag can therefore read back as enabled without appearing in the listing or activating
any feature.

Test: [experimental flags](pins/utils.test.ts).

### 24. `parseBigInt` loses integer precision

```js
parseBigInt('9007199254740993') // 9007199254740992
```

The helper converts through `Number`, losing precision beyond the safe integer range. No internal
callers were found in the reviewed bundle.

REST handling of oversized `bigint` values has a different failure mode: insert and read-back raise
`RangeError: Value is too large to be represented as a JavaScript number`.

Test: [numeric helpers](pins/utils.test.ts).

## Other observed behavior

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
