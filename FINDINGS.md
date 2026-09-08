# Findings

Eight defects in the published `@supabase/lite@0.9.0`, grouped by the patch that closes them —
several share a root cause, which is why five patches cover eight defects. Nothing is listed here
that is not also fixed, tested and reproducible.

Re-measured on `0.9.1-next.1`, `0.9.1-next.2`, `0.10.0` and `0.10.1-next.2`. All still present,
except FIX-003, which upstream fixed in `0.9.1-next.2` — its section below is kept and marked.

Each patch directory holds a `repro.ts` that demonstrates its findings on a real build:

```bash
npm run repro 002          # the defects below, on the package from npm
npm run install:patches
npm run repro 002          # the same script, on the patched build
```

The three additions under `features/` are capabilities the package lists as unimplemented, not
defects, so they are not findings. The README covers them.

---

## FIX-001 — a partial index silently loses its `WHERE` clause

```sql
CREATE UNIQUE INDEX u ON users (email) WHERE deleted_at IS NULL;
-- becomes
CREATE UNIQUE INDEX u ON users (email);
```

That is the standard soft-delete idiom — email unique among live rows. After translation the
constraint is global, so re-registering an address belonging to a soft-deleted row fails with a
uniqueness violation on a row Postgres would have accepted.

SQLite has supported partial indexes since 3.8.0, so nothing forces this. Direction (`DESC`),
uniqueness and expression forms are all preserved; only the `WHERE` is dropped, with no warning.

The predicate is lost in three separate places — translation, the schema model, and the migration
plan — so fixing only the first changes nothing for anyone applying a schema through the migrator.

---

## FIX-002 — client errors come back as server faults

Three refusals that are all the caller's fault, all answered `500` with the code `SUP` and a
stringified `Error` — both fingerprints of an exception that escaped rather than an error raised
deliberately. Callers cannot tell "you are not allowed" or "your data is wrong" from "the server
broke", so they retry a request that will never succeed.

### An RLS refusal with no matching policy

RLS denies by **command**. A table with only a `FOR SELECT` policy correctly refuses inserts and the
row is not written — but the two refusal paths are converted differently:

| refusal                                  | status    | body                                                                           |
| ---------------------------------------- | --------- | ------------------------------------------------------------------------------ |
| `WITH CHECK` fails on an existing policy | `403`     | `{"code":"PGRST301","message":"new row violates row-level security policy …"}` |
| no policy exists for the command at all  | **`500`** | `{"code":"SUP","message":"Error: RLS policy violation"}`                       |

The second path raises a bare `Error` that never reaches the PostgREST error mapper. Correct,
intentional behaviour reported as a server fault.

The fix answers `42501` — Postgres's `insufficient_privilege`, which is what PostgREST and hosted
Supabase return for a policy refusal — rather than copying the neighbour's `PGRST301`, a code
PostgREST reserves for a JWT it could not verify. So the two paths in this build no longer agree, and
that is the point: the rest of this patch maps constraint violations onto real SQLSTATEs for exactly
the same reason. The neighbour is left alone and pinned unchanged in the tests, because it answers a
client error with a client status and is therefore not this defect; bringing it to `42501` as well
would be its own change.

### An inline CHECK violation

The inconsistency is visible side by side in one table:

| violated constraint                                   | status    | body                                                                      |
| ----------------------------------------------------- | --------- | ------------------------------------------------------------------------- |
| named (`array_type`, generated for `int[]`)           | `400`     | `{"code":"23514","message":"check constraint \"array_type\" violated …"}` |
| inline and unnamed (`CHECK (quantity > 0)`, date validity) | **`500`** | `{"code":"SUP","message":"Error: CHECK constraint failed: …"}`       |

Writing `-1` to a column declared `int CHECK (quantity > 0)`, or `'not-a-date'` to a `date` column,
is a client error. Both are reported as a server fault, with the raw SQLite constraint text as the
message.

`23514` is also the one SQLSTATE the ladder has no branch for, so coding the error correctly is not
enough on its own — the mapper needs the case as well.

### Every other constraint violation, for a reason worth reading

The ladder that maps an error to a response **has** the right branches — `23505` and `23503` give
409, `23502` gives 400. Nothing reaches them. What converts a driver error into an SQLSTATE is
`SqliteConnection.normalizeDbError`, and it recognises the constraint by `err.code`:

```js
if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') → 23505
if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY')                                        → 23503
if (code === 'SQLITE_CONSTRAINT_NOTNULL')                                           → 23502
```

That is the better-sqlite3 error shape. The package's own driver is `node:sqlite`, which puts
`ERR_SQLITE_ERROR` in `code` and the constraint in a numeric `errcode`:

```
INSERT INTO t VALUES (1, 'b')   raw code=ERR_SQLITE_ERROR errcode=1555  → normalized code=ERR_SQLITE_ERROR
INSERT INTO t VALUES (2, NULL)  raw code=ERR_SQLITE_ERROR errcode=1299  → normalized code=ERR_SQLITE_ERROR
```

No condition matches, the error is returned unchanged, and everything falls through:

| violation               | expected      | actual      |
| ----------------------- | ------------- | ----------- |
| duplicate `PRIMARY KEY` | `409` `23505` | `500` `SUP` |
| `UNIQUE`                | `409` `23505` | `500` `SUP` |
| `FOREIGN KEY`           | `409` `23503` | `500` `SUP` |
| `NOT NULL`              | `400` `23502` | `500` `SUP` |

A duplicate primary key is the most common client error any API has. The named `CHECK` above is the
one case that works — it is raised as its own error class higher up, where `normalizeDbError` never
sees it — and that working neighbour is what makes this read as a single missing code rather than a
conversion step that never fires. It was first recorded here as exactly that mistake; writing the
reproduction is what corrected it.

**What this does not cover.** `SQLITE_CONSTRAINT_DATATYPE` — a value SQLite will not store in a
STRICT column, `{"age": "not-a-number"}` for an `int` — still answers `500`. The fix deliberately
leaves it: the same code is raised when the library fails to serialise a type it claims to support,
and for `bytea` the correct answer is neither `400` nor `500` but a successful insert, since Postgres
accepts `H656c6c6f`. Coding it `22P02` would dress a missing conversion as bad input, and telling
the two apart means reading the message, which is the habit this patch exists to end. The `bytea`
gap is its own entry in `ADDITIONAL_FINDINGS.md`.

---

## FIX-003 — values arrive in the wrong types

> **Fixed upstream in `0.9.1-next.2` and later, `0.10.0` included.** Kept here because it is a defect
> of `0.9.0`, the version under study. On those versions the published build passes this patch's
> assertions unchanged.

```jsonc
// GET /rest/v1/items?select=tags,meta,ok
[{ "tags": "[\"a\",\"b\"]", "meta": "{\"x\":{\"y\":1}}", "ok": 1 }]
// Postgres/PostgREST would return
[{ "tags": ["a", "b"], "meta": { "x": { "y": 1 } }, "ok": true }]
```

Values are stored correctly and the round trip is lossless, but the client receives the _characters_
of the JSON and has to parse them itself, and `row.ok === true` is never true.

**The declared types are not lost — they are unreachable.** They are collected while the Postgres DDL
is translated and merged back into the introspection by `mergeDeparseMetadata`, behind this guard:

```js
this.config.ddlDialect === "postgres" && e?.postprocess !== false && (r = this.mergeDeparseMetadata(r))
```

`SqliteConnection`'s constructor never defaults `ddlDialect`, so for every connection created without
one it is `undefined`, the merge is skipped, and `deserializeRow` — gated on the same field — is
skipped with it. Two lines below the guard, the very same value is reported with the default the
branch lacks:

```js
ddl_dialect: this.config.ddlDialect ?? "postgres"
```

So the introspection announces the dialect whose handling was just skipped. Nothing needs inferring;
the published build answers correctly if the field is supplied by hand:

```
createConnection({ url: ':memory:' })                            → { "tags": "[\"a\",\"b\"]", "ok": 1 }
createConnection({ url: ':memory:', ddlDialect: 'postgres' })     → { "tags": ["a","b"], "ok": true }
```

The fix supplies the default. Because it restores the metadata rather than guessing at it, an
integer column stays an integer whatever its CHECK constraints say and whatever it sits beside.

**Impact:** supabase-js hands the caller a string and an integer where the Postgres-backed service
hands it an array, an object and a boolean — so code written against hosted Supabase breaks at the
point of use (`row.tags.map(...)`), not at the query.

**What this does not cover.** An array's element type is not restored: `boolean[]` still reads back
as `[1, 0]`, because the merged metadata records the element type as `bool` and nothing maps the
elements through it. `int[]` and `text[]` are unaffected, their elements arriving from JSON already
in the right shape. Still true in `0.10.0`, and recorded separately in `ADDITIONAL_FINDINGS.md`.

---

## FIX-004 — publication statements kill the migration

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
-- becomes
ALTER PUBLICATION supabase_realtime ADD FOR TABLE TABLE messages
```

The deparser emits its own `FOR TABLE` and then keeps the original `TABLE`. The result is valid in
neither dialect and lands in DDL that is then executed:

```
migration failed: near "PUBLICATION": syntax error
```

`DROP PUBLICATION` fails differently and earlier. It has no node type of its own — it parses as an
ordinary `DropStmt` carrying `removeType: 'OBJECT_PUBLICATION'` — and that handler lets `TABLE`,
`VIEW`, `INDEX` and `TRIGGER` through, answers a dropped policy with an empty string, and raises on
everything else:

```
DROP with removeType OBJECT_PUBLICATION is not supported in SQLite
```

Which is the one most projects meet first. Supabase's own instructions for turning Realtime on are:

```sql
begin;
  drop publication if exists supabase_realtime;
  create publication supabase_realtime;
commit;

alter publication supabase_realtime add table messages;
```

So a schema exported from a project using Realtime dies on the first of its publication lines, before
reaching the mangled `ALTER` at all. The fix is the whole family rather than the one mangled form:
publication metadata never reaches SQLite DDL.

The family is five statements across five node types, and only two of them announce themselves by
type. The rest share theirs with every other kind of database object, so each has to be read by the
object it names:

| statement                   | node                    | recognised by                          |
| --------------------------- | ----------------------- | -------------------------------------- |
| `CREATE PUBLICATION`        | `CreatePublicationStmt` | the node type                          |
| `ALTER PUBLICATION` ADD/SET/DROP | `AlterPublicationStmt` | the node type                     |
| `DROP PUBLICATION`          | `DropStmt`              | `removeType: 'OBJECT_PUBLICATION'`     |
| `ALTER PUBLICATION … RENAME TO` | `RenameStmt`        | `renameType: 'OBJECT_PUBLICATION'`     |
| `ALTER PUBLICATION … OWNER TO`  | `AlterOwnerStmt`    | `objectType: 'OBJECT_PUBLICATION'`     |

The last two fail on the published build with `RenameStmt with renameType OBJECT_PUBLICATION is not
supported in SQLite` and `Unsupported node type: AlterOwnerStmt`. It does not implement Realtime — SQLite has no logical
replication for a publication to mean anything in — it stops publications taking the schema down with
them.

Neighbouring statements of the same family behave inconsistently: `GRANT` and `COMMENT ON` are
dropped silently, while `ALTER TABLE … REPLICA IDENTITY FULL` and `REVOKE` are refused by name at
translation time. The `GRANT`/`REVOKE` asymmetry is odd in particular — they are the same AST node.

---

## FIX-005 — triggers never reach the database through the migrator

Triggers translate correctly and execute correctly. They are simply never created when the schema is
applied by the migrator:

```
translateDdl                contains CREATE TRIGGER on_src_insert   ok
exec(the translated DDL)    triggers in the database: [on_src_insert]
migrate(the same DDL)       triggers in the database: []
migrate(again)              triggers in the database: []
```

`Differ.diff` returns `{ tables, columns, indexes, foreign_keys, has_changes }` — there is no
`triggers` key, so a new trigger never becomes a plan step. The planner can recreate them, but only
as a side effect of rebuilding the table they hang off.

**Impact:** the canonical Supabase recipes break — `handle_new_user()` on `auth.users`, which creates
a row in `public.profiles` on sign-up, and the `updated_at` trigger. They break silently: the
migration reports success and the tables are there.

**Order, not only presence.** Creating the triggers exposes a second problem that the empty database
hid. SQLite drops a table's own triggers with the table, but a trigger on *another* table that
mentions it survives — and the rebuild's `ALTER TABLE … RENAME` validates the whole schema and
refuses:

```
error in trigger on_src_insert: no such table: main.dst
```

The trigger is on `src`, the rebuilt table is `dst`, and nothing about the trigger changed, so there
is no trigger change for a diff to notice. The fix drops every trigger before tables are replaced and
creates the desired ones once they exist again — more work than the minimum, and the minimum is a
dependency graph over trigger bodies.

The plan's own `BEGIN`/`COMMIT` steps are not what makes this safe: `migratePlan` filters those
markers out and runs every remaining statement inside one transaction of its own. A migration that
fails after the drops therefore takes them back with it, which the tests assert by breaking one.
