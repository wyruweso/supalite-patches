# Additional findings

Defects in the published `@supabase/lite@0.9.0` that these patches do **not** fix. `FINDINGS.md`
lists the eight that are fixed; these are the rest of what the survey turned up, ordered by how much
damage they do rather than by where they live.

Order inside each group is reach times severity, not severity alone: a total failure that only a
few schemas can reach ranks below a partial one that almost every project walks into.

Everything here was measured against the package from npm. Nothing is repaired, so nothing here has
a reproduction beside a patch — the commands quoted are what was run to establish each one.

---

## Severe — a whole capability is unusable, or data is refused that should not be

### 1. Claim-based RLS cannot work, in two halves

The idiom Supabase's own documentation gives for reading a custom claim:

```sql
CREATE POLICY p ON notes FOR ALL USING (team = auth.jwt() ->> 'team') WITH CHECK (true);
```

**The first half.** It is accepted by the migrator, the table is created, and then every read of that
table returns `{"code":"SUP","message":"Error: Unresolved variable: {{auth.jwt.team}}"}`. The
translator turns the accessor into a placeholder and `resolvePlaceholder` raises when the path is
missing. Postgres evaluates `auth.jwt() ->> 'team'` to NULL, `team = NULL` is NULL, and the row is
filtered out — so an anonymous caller, or any user whose token happens not to carry that claim, gets
a 500 rather than an empty result.

What makes this costly is the timing. Every other unsupported policy construct is refused during
migration, by name, while the deployment can still stop:

| construct           | refused at | message                                              |
| ------------------- | ---------- | ---------------------------------------------------- |
| `BETWEEN`           | migration  | `Unsupported expression: A_Expr kind: AEXPR_BETWEEN` |
| `current_setting()` | migration  | `Unsupported expression: FuncCall: current_setting`  |
| `COALESCE`          | migration  | `Unsupported expression: deparseValue: CoalesceExpr` |
| `auth.jwt() ->> …`  | **never**  | migrates, then 500s whenever the claim is absent     |

**The second half.** The claim can never be present. A signup that supplies metadata stores it and
returns it, but the access token holds seven claims and none of them is the metadata:

```jsonc
user.user_metadata   // { "team": "red", … }  — stored and returned
access_token payload // { sub, aud, role, email, session_id, iat, exp }
```

Hosted Supabase puts both metadata objects into the token; that is the mechanism the idiom depends
on. So repairing the 500 alone would turn every such policy into one that admits nobody.

### 2. `CREATE EXTENSION` is passed through verbatim and kills the migration

A statement with no SQLite equivalent was emitted word for word into DDL that is then executed:

```
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE t (id uuid primary key default gen_random_uuid(), name text);

0.9.0          migration FAILED: near "EXTENSION": syntax error
0.9.1-next.1   migration succeeded
```

That line opens very nearly every Supabase migration. `DROP EXTENSION` was refused *at translation*
in the same version — loudly, and while the deployment could still stop — so the asymmetry is what
made this silent.

**Not ours.** Found by comparing against `0.9.1-next.1`, where it is already fixed: extension
statements now translate to nothing. Recorded because `0.9.0` is the version under study, and because
of the 754 assertions describing it, this is the one that changed.

### 3. `bytea` columns cannot be written through REST at all

The translation is correct — the column really is a SQLite `BLOB`, and binary written straight
through the connection is stored properly. What is missing is any serialisation from a JSON request
body to bytes, so every spelling a client could send is refused:

| sent as                                       | result                                                       |
| --------------------------------------------- | ------------------------------------------------------------ |
| `"\x48656c6c6f"` (Postgres's own hex literal) | `500` — `cannot store TEXT value in BLOB column files.blob`  |
| `"Hello"`                                     | `500` — same                                                 |
| `"SGVsbG8="` (base64)                         | `500` — same                                                 |
| `[72, 101, 108]`                              | `500` — `Cannot bind value at parameter …: unsupported type` |
| `null`                                        | `201` — the only value that works                            |

Reading does not round-trip either: bytes inserted through the connection come back as a
numeric-keyed object, a `Uint8Array` that went through `JSON.stringify` — `[{"blob":{"0":222,"1":173}}]`.

**Impact:** from a REST client a `bytea` column is write-only-as-null and read-only-as-noise.

### 4. A non-ASCII table name makes every filtered request a 500

Postgres accepts Unicode identifiers and so does PostgREST, so `CREATE TABLE книги (…)` is an
ordinary schema. It translates, it accepts writes, and a bare read works. Add any query parameter and
the same request fails:

```
GET /rest/v1/книги            → 200  [{"id":1,"name":"x"}]
GET /rest/v1/книги?select=id  → 500  TypeError: Cannot convert argument to a ByteString
                                     because the character at index 1 has a value of 1082
GET /rest/v1/книги?id=eq.1    → 500  the same
```

1082 is `к`. The response carries `Content-Location: /<table>?<query>`, header values are ByteStrings,
and the table name in the path is never percent-encoded — while the query string is, so a Cyrillic
*value* is handled correctly. The header is only set when there is a query string, which is why the
bare read escapes.

**How often this is reached** is the reason it sits here and not higher: most schemas are written in
ASCII, and a project that never names a table in its own language never meets this. When it is met,
nothing works and nothing suggests a cause.

**Impact:** any schema whose identifiers are not English breaks on its first filtered request, and
breaks late — the rows are fetched and the failure happens while the response headers are assembled,
so the error names a ByteString conversion rather than anything the caller did.

### 5. A storage adapter is written at one version and read at another

Every `StorageAdapter` method takes `version` as its third argument and `storage.objects` carries a
`version` column re-rolled on each write. The pairing invites an adapter to key on it — which is what
immutable object versioning is for, and how an S3-backed adapter stops a CDN serving stale bytes.

The two sides disagree:

```js
await this.adapter.uploadObject(bucketId, path, void 0, body, …)   // always undefined
await this.adapter.getObject(bucketId, path, obj.version ?? void 0) // the UUID from the row
```

```
uploadObject   version = undefined         → key  b/a.txt@none
getObject      version = "a97eb2c5-…"      → key  b/a.txt@a97eb2c5-…   → 500
still in the store: [ 'b/a.txt@none' ]
```

`copyObject` has the same shape. **Impact:** only adapters that ignore `version` work — that is, only
adapters that do not version. Easy to misdiagnose as a key-derivation mistake in your own adapter,
which is how it was first written off here.
### 6. `quote()` does not escape embedded quotes

```js
quote('tbl') // '"tbl"'
quote('we"ird') // '"we"ird"'   ← malformed
```

Correct SQL escaping doubles the inner quote. This is not only an exported helper: the differ uses it
to build `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE … ADD COLUMN` and `DROP INDEX` from identifiers
that came out of the user's Postgres DDL. Reachable end to end:

```
ALTER TABLE "we"ird" ADD COLUMN "extra" text;   →   near "ird": syntax error
```

**Impact:** identifier names containing a double quote produce malformed — and in principle
attacker-shaped — DDL. It also blocks two things a patch would otherwise reach: an index whose name
contains a quote cannot be created at all, so the readers that handle doubled quotes correctly are
right for inputs this build cannot yet produce.

---

## Moderate — correct results, wrong cost; or a silent wrong answer in a narrow case

### 7. DDL applied through `exec()` leaves the schema cache stale

The PostgREST schema cache is populated on the first request. A table created afterwards through
`connection.exec()` is invisible for the lifetime of the app:

```
PGRST205  Could not find the table 'docs' in the schema cache
          Perhaps you meant the table 'public.books'
```

The error reads as "no such table" rather than "stale cache", and the hint points elsewhere. Two
mitigations exist and are easy to miss: `diff()` re-reads the schema, so the **migrator** path
refreshes the cache by itself, and `Connection.clearSchemaCache()` is exported and works.

### 8. Adding an index rewrites the entire table

Migrating from a schema to the same schema plus one `CREATE INDEX` produces a diff in which nothing
about the table changed — `tables: []`, `columns: []`, only `indexes: [{type:"added"}]` — and then a
plan that copies every row through a temporary table anyway:

```
disable_foreign_keys → begin_transaction → create_table "_t_migrate_new" → copy_data
→ drop_table "t" → rename_table → add_index → commit_transaction → enable_foreign_keys
```

The rebuild is the right answer for a dropped column or a changed type. `CREATE INDEX` is a single
statement SQLite has always supported, and the `add_index` step at the end is the only one needed.

**Impact:** adding an index to a large table costs a full copy of it, the disk for a second copy, and
a window with foreign keys disabled. The result is correct; the cost is not.

### 9. An expression index cannot survive the migrator

`pragma_index_info` reports NULL for a column that is an expression, and nothing puts anything else
there, so the schema model records the column as `null` — and the planner then quotes it:

```
CREATE UNIQUE INDEX k ON t (a, (nullif(n, '')))     ← what was asked for
model:   {"name":"k","columns":["a",null], …}
planned: CREATE UNIQUE INDEX "k" ON "t" ("a","null");
         no such column: "null"
```

The spelling does not matter — `nullif(...)`, a `CASE` expression, a mixed index of one plain column
and one expression all fail the same way. Translation is not at fault: the DDL that comes out is
correct, and executing it directly through `exec()` works. Only the plan-and-rebuild path is broken.

It bites when an expression index is a **change to be planned**. A schema applied outside that path,
or one where both sides already carry the index, never emits the step — which is why the MFA schema
added by `FEAT-003` can use `(NULLIF(friendly_name, ''))` safely.

### 10. A CSV row with too many fields is silently truncated

```
POST /rest/v1/authors    Content-Type: text/csv

id,name
1,A,surplus            → inserted as {id: 1, name: "A"}, 201
```

Real PostgREST rejects a ragged row. Note the contrast with the JSON path, which is strict about
exactly this: a batch whose objects have differing keys is refused with `PGRST102`.

**Impact:** a misaligned or wrongly-delimited import lands as partial data with a 201.

### 11. A `/regex/` pattern is compiled with its delimiters

```js
patternMatch('foobar', /^foo/) // true
patternMatch('foobar', '/^foo/') // false
```

The code switches into regex mode *because* the pattern starts with `/`, then hands the whole string,
slashes included, to `new RegExp` — so `/^foo/` searches for a literal forward slash. What makes it
worse than it looks: the default mode is not regex (`patternMatch('foobar', '^foo')` is `false`), and
the only implicit route into regex mode is the spelling that is broken. Explicit
`patternMatch(input, '^foo', 'regex')` works.

### 12. `trim()` in translated DDL is refused by the name the parser gives it

```
CREATE INDEX i ON t ((trim(note)))   →   Function call "btrim" not supported
```

The Postgres parser normalises `trim` to `btrim`, and the translator's allow-list does not carry that
name — so a function that exists in SQLite is refused under a name the author never wrote. Upstream
uses `trim(...) <> ''` in its own MFA schema, which is exactly the shape this blocks.

### 13. `PGRST200` names a schema called `test`, which does not exist

```
GET /rest/v1/books?select=title,nope(x)

"Searched for a foreign key relationship between 'books' and 'nope'
 in the schema 'test', but no matches were found."
```

The exposed schemas are `graphql_public`, `public` and `storage`, and tables resolve under `public`.
The value is not derived from the request — the same string appears whatever `Host` is used, so it is
a hardcoded literal. Cosmetic on its own, but it points the reader at a schema that is not there while
they are already debugging a relationship they cannot find.

---

## Minor — divergences worth knowing, and one dead helper

### 14. The OpenAPI document describes nothing

`GET /rest/v1/` returns a syntactically valid Swagger 2.0 document with exactly six keys — `swagger`,
`info`, `basePath`, `schemes`, `consumes`, `produces`. There is no `paths` and no `definitions`
member; they are absent rather than empty. Real PostgREST emits a path per table and a definition per
row shape. Client generators consume this and produce an empty API without erroring, because the
document is well formed.

### 15. `count=planned` and `count=estimated` perform an exact count

All three counting modes do the same exact count — SQLite has no planner estimate to read. The
answers are more accurate than PostgREST's and the performance characteristic callers chose them for
is gone.

### 16. `PUT` on a storage object does not parse multipart

`POST /storage/v1/object/:bucket/*` parses a multipart form and stores the file part. `PUT` on the
same path reads the body straight through, so sending it a `FormData` stores the MIME boundary
markers and headers as the file's content. Raw bytes on `PUT` work correctly. Whether this is a defect
depends on what clients send to that route; it is recorded because the asymmetry is invisible from the
route table.

### 17. An email change is confirmed only at the current address

`PUT /auth/v1/user {email}` stages the address as `new_email` and mails a confirmation to the address
already on file. Nothing is sent to the new address; real GoTrue with `secure_email_change_enabled`
mails both. Defensible — a stolen session cannot silently move an account to an attacker's inbox — but
an address is never proven to belong to the person claiming it.

### 18. `deleted_at` is written by nobody and read by nobody

The column exists on `auth.users`, and the string `deleted_at` occurs exactly **once** in the whole
published bundle: in the DDL that creates it. Nothing sets it and nothing checks it, so there is no
soft delete in this build — only a column shaped like one.

### 19. `objectDiff` cannot see added keys

```js
objectDiff({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }) // { b: 3 }
```

It iterates the keys of the *first* argument. Fine for "what changed in a known shape", wrong for
"diff these two objects".

### 20. `mergeObject` merges arrays element-wise

```js
mergeObject({ a: [1, 2] }, { a: [3] }) // { a: [3, 2] }
```

The shorter array does not truncate the longer one, so config merging with this function cannot
shorten a list.

### 21. `setExperimental` accepts any flag; the listing reports only known ones

`setExperimental('anything', true)` writes to the map unconditionally and `isExperimentalEnabled`
then returns `true`, but the flag never appears in `listEnabledExperimentals`, which filters a fixed
roster. A typo in a flag name is enabled, invisible and inert.

### 22. `parseBigInt` routes through `Number` and loses precision

```js
parseBigInt('9007199254740993') // 9007199254740992
```

A function with that name doing the one thing its name promises it will not. Listed last because the
impact is smaller than it looks: it has no callers inside the library, and a `bigint` column past 2^53
fails loudly rather than quietly — `RangeError: Value is too large to be represented as a JavaScript
number`, on insert through REST and on read-back even when SQLite stored the value correctly.

---

## Not defects — deliberate, and pinned so they are not "fixed" by mistake

- **`getPath` throws** on an unresolvable path rather than returning `undefined`.
- **`isEmail('a@b')` is `true`** — a bare domain with no dot is accepted.
- **`isBooleanLike`** tests the four boolean-ish _values_ (`true`, `false`, `0`, `1`); the string
  `'true'` is not boolean-like.
- **`/_system/*` sits outside the API-key guard** — `ping`, `config`, `info` and `introspect` are
  reachable with no credentials even when keys are configured. `config` redacts `jwt_secret`.
- **The API-key guard is off entirely** unless `auth.publishable_key` or `auth.secret_key` is set; an
  unrecognised key is then ignored rather than rejected.
- **The secret key is `service_role` and bypasses RLS.**
- **A signed storage URL's JWT** carries `{sub, bucket, intent, iat, exp}` and works with no
  `Authorization` header.
- **`magiclink` for an unknown address still returns 200**, so addresses cannot be enumerated.

## Idioms that were checked and do work

| idiom                                                    | result                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| `references auth.users(id) on delete cascade`            | translates, and the constraint is enforced                                |
| `USING (owner = (select auth.uid()))` — Supabase's form  | works as well as the direct spelling                                      |
| `GRANT`, `COMMENT ON` in a migration                     | dropped silently, the migration proceeds                                  |
| storage policy `(storage.foldername(name))[1]`           | refused by name at migration (`A_Indirection`) — loudly, and in good time |
