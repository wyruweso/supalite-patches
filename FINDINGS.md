# Findings

Eight observed defects in `@supabase/lite@0.9.0`, grouped into five fixes. Each fix includes an
implementation, API tests, and a reproduction against the published package.

Later reviews covered `0.9.1-next.1`, `0.9.1-next.2`, `0.10.0`, and `0.10.1-next.2`.
FIX-003 is fixed upstream from `0.9.1-next.2`; the other fixes still addressed defects in those reviews.

| Fix                                                              | Problem                                     |
| ---------------------------------------------------------------- | ------------------------------------------- |
| [FIX-001](#fix-001--partial-index-predicates-are-lost)           | Partial indexes lose `WHERE`                |
| [FIX-002](#fix-002--client-errors-return-500)                    | RLS and constraint refusals return `500`    |
| [FIX-003](#fix-003--rest-values-have-the-wrong-types)            | REST returns JSON text and numeric booleans |
| [FIX-004](#fix-004--publication-statements-block-schema-import)  | Publication statements block schema import  |
| [FIX-005](#fix-005--trigger-changes-are-missing-from-migrations) | Standalone trigger changes are ignored      |

To compare a reproduction:

```bash
npm run repro -- client-errors-as-500
npm run install:patches
npm run repro -- client-errors-as-500
npm run uninstall:patches
```

Feature scope is described in [README.md](README.md#features). Remaining defects and limitations
are in [ADDITIONAL_FINDINGS.md](ADDITIONAL_FINDINGS.md).

## FIX-001 — partial-index predicates are lost

```sql
CREATE UNIQUE INDEX u ON users (email) WHERE deleted_at IS NULL;
-- Translated:
CREATE UNIQUE INDEX u ON users (email);
```

The unique constraint now applies to every row. An address belonging to a soft-deleted user cannot
be registered again, even though the declared partial index should allow it.

**Cause.** The predicate is omitted from translation, introspection, index comparison, and migration
planning. Correcting translation alone does not fix schemas applied through the migrator.

**Change.** Preserve the predicate through all four stages:

| Stage                       | Implementation                                                       |
| --------------------------- | -------------------------------------------------------------------- |
| PostgreSQL AST → SQLite DDL | `IndexStmt` appends `WHERE` using the existing expression visitor    |
| SQLite DDL → schema model   | `introspect` reads the predicate from the stored index definition    |
| Schema comparison           | `makeIndexKey` includes the predicate, ignoring spacing and comments |
| Migration plan → SQLite DDL | `plan` appends the predicate to generated `add_index` steps          |

Quoted text and token boundaries remain significant: `'a  b'` differs from `'a b'`, and `a - -1`
must not become the comment in `a--1`. The comparison handles SQLite predicate text only.

[Implementation](fixes/001-partial-index/src/) · [Tests](fixes/001-partial-index/test.ts)

## FIX-002 — client errors return 500

The package rejects these requests correctly, but reports server faults. Clients receive `500 SUP`
for invalid input or a policy refusal and may retry a request that cannot succeed.

| Refusal                                  | Published response | Patched response                              |
| ---------------------------------------- | ------------------ | --------------------------------------------- |
| No RLS policy for the command            | `500 SUP`          | `403 42501`, or `401` for an anonymous caller |
| Inline CHECK or date validity constraint | `500 SUP`          | `400 23514`                                   |
| Duplicate PRIMARY KEY or UNIQUE          | `500 SUP`          | `409 23505`                                   |
| FOREIGN KEY                              | `500 SUP`          | `409 23503`                                   |
| NOT NULL                                 | `500 SUP`          | `400 23502`                                   |

### Driver constraint codes

The existing response mapper understands most SQLSTATE codes, but the normalizer reads
better-sqlite3's error shape. The shipped `node:sqlite` driver uses a different one:

| Driver         | Constraint information                                           |
| -------------- | ---------------------------------------------------------------- |
| better-sqlite3 | A string such as `SQLITE_CONSTRAINT_PRIMARYKEY` in `code`        |
| node:sqlite    | `code: ERR_SQLITE_ERROR` and a numeric `errcode`, such as `1555` |

**Change.** Map numeric SQLite constraint codes to SQLSTATE in `normalizeDbError`, then use the
package's existing response mapping. Error messages do not determine the constraint type.

### RLS and inline CHECK errors

A table with only a `FOR SELECT` policy correctly rejects an insert, but raises a plain
`Error('RLS policy violation')`. An inline CHECK violation normalizes to `23514`, which has no
response branch. Both need handling in `handlePostgrestError` as well.

**Change.** Return SQLSTATE `42501` for the missing-policy refusal and `400 23514` for inline CHECK
failures. Named CHECK failures already return `400 23514` with constraint details and stay unchanged.
The separate `WITH CHECK` path keeps its existing `403 PGRST301` response.

**Boundary.** `SQLITE_CONSTRAINT_DATATYPE` remains unmapped. It covers both invalid input and
missing conversions for supported types, including `bytea`. Valid PostgreSQL hex input such as
`"\\x48656c6c6f"` should be converted and inserted; returning a client error would hide the missing
conversion. [Additional findings](ADDITIONAL_FINDINGS.md) records that gap separately.

[Implementation](fixes/002-client-errors-as-500/src/) · [Tests](fixes/002-client-errors-as-500/test.ts)

## FIX-003 — REST values have the wrong types

**Fixed upstream in `0.9.1-next.2` and later.** Retained for the pinned `0.9.0` baseline.

```jsonc
// Published response:
[{ "tags": "[\"a\",\"b\"]", "meta": "{\"x\":1}", "ok": 1 }]
// Patched response:
[{ "tags": ["a", "b"], "meta": { "x": 1 }, "ok": true }]
```

Stored values survive the round trip, but their response types break callers expecting
`row.tags.map(...)` or `row.ok === true`.

**Cause.** Translation records the declared PostgreSQL types. Metadata merging and row
deserialization use them only when `config.ddlDialect === 'postgres'`, but the constructor leaves
that field undefined. Introspection still reports `ddl_dialect: 'postgres'` as its fallback.

**Change.** Set the missing default at both methods that read it. The existing metadata and
conversion paths then run. No type inference from SQLite CHECK expressions is needed.

**Boundary.** `boolean[]` elements still return as `[1, 0]`: metadata is restored, but the package
does not convert individual array elements. Integer and text arrays already have the expected
JSON element types. See [Additional findings](ADDITIONAL_FINDINGS.md).

[Implementation](fixes/003-value-types/src/) · [Tests](fixes/003-value-types/test.ts)

## FIX-004 — publication statements block schema import

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
-- Translated:
ALTER PUBLICATION supabase_realtime ADD FOR TABLE TABLE messages;
```

The generated statement is invalid, and SQLite cannot execute publication DDL in any case.
`DROP PUBLICATION` fails earlier with `DROP with removeType OBJECT_PUBLICATION is not supported in SQLite`.

An imported Supabase Realtime setup therefore blocks the migration:

```sql
BEGIN;
DROP PUBLICATION IF EXISTS supabase_realtime;
CREATE PUBLICATION supabase_realtime;
COMMIT;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
```

**Change.** Parse the statements, then omit publication nodes from SQLite DDL. Cover each AST form:

| Statement                        | Node                    | Discriminator                      |
| -------------------------------- | ----------------------- | ---------------------------------- |
| `CREATE PUBLICATION`             | `CreatePublicationStmt` | Node type                          |
| `ALTER PUBLICATION` ADD/SET/DROP | `AlterPublicationStmt`  | Node type                          |
| `DROP PUBLICATION`               | `DropStmt`              | `removeType: 'OBJECT_PUBLICATION'` |
| `ALTER PUBLICATION … RENAME TO`  | `RenameStmt`            | `renameType: 'OBJECT_PUBLICATION'` |
| `ALTER PUBLICATION … OWNER TO`   | `AlterOwnerStmt`        | `objectType: 'OBJECT_PUBLICATION'` |

Shared node types still handle other database objects as before. Malformed SQL still fails parsing;
`PUBLICATION` inside a quoted value does not identify a statement.

**Boundary.** This enables schema import, not Realtime or logical replication. Other statement
handling remains unchanged: `GRANT` and `COMMENT ON` are skipped; `REVOKE` and
`ALTER TABLE … REPLICA IDENTITY FULL` are rejected.

[Implementation](fixes/004-publication-statements/src/) · [Tests](fixes/004-publication-statements/test.ts)

## FIX-005 — trigger changes are missing from migrations

| Operation                                   | Published behavior                       |
| ------------------------------------------- | ---------------------------------------- |
| Translate trigger DDL                       | Emits CREATE TRIGGER                     |
| Execute translated DDL directly             | Creates a working trigger                |
| Migrate a new schema containing the trigger | Creates the tables but omits the trigger |
| Migrate the same schema again               | Still omits the trigger                  |

**Cause.** `Differ.diff` tracks tables, columns, indexes, and foreign keys, but no standalone trigger
changes. The planner can recreate triggers as a side effect of a table rebuild.

A successful migration can therefore leave profile-creation or `updated_at` triggers missing.

**Change.** Include trigger additions, removals, and redefinitions in the diff. When a table is
rebuilt, drop current triggers before replacing tables and create the desired triggers afterwards.

This order also handles a trigger on one table referencing another table that is being rebuilt.
Such a trigger survives the old table's removal and otherwise blocks its replacement's rename:

```text
error in trigger on_src_insert: no such table: main.dst
```

The patch recreates all triggers around a rebuild to avoid requiring a dependency graph of trigger
bodies. Without a rebuild, it applies only the reported trigger changes and avoids duplicate steps.

**Rollback.** `migratePlan` removes the plan's BEGIN/COMMIT markers and executes the statements in
its own transaction. A failed rebuild restores dropped triggers; the tests verify this by causing
a copy failure after the drop.

[Implementation](fixes/005-triggers-in-migration/src/) · [Tests](fixes/005-triggers-in-migration/test.ts)
