# FIX-001: keep the condition on a partial index

A **partial index** covers only rows matching its `WHERE` condition. A partial **unique** index
prevents duplicates within that group.

For example, a deleted account should not stop someone registering the same email again:

```sql
CREATE UNIQUE INDEX users_active_email
ON users(email)
WHERE deleted_at IS NULL;
```

Here, `deleted_at IS NULL` means the account is still active.

## What was wrong?

The package removed `WHERE` when translating the index to SQLite. The unique constraint then
covered deleted accounts too.

| Rows with the same email                   | Before   | After    |
| ------------------------------------------ | -------- | -------- |
| Two active accounts                        | Rejected | Rejected |
| One deleted account and one active account | Rejected | Allowed  |

## How the fix works

The condition must survive every step between the schema you write and the database that runs it.
Fixing only the SQL output would still leave it missing during later migrations.

| Step                        | Code                                                | What it does                                                  |
| --------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Translate the index         | [`IndexStmt`](src/db/translation/SqliteDeparser.ts) | Adds `WHERE` using the existing expression translator         |
| Read the database schema    | [`introspect`](src/db/sqlite/SqliteConnection.ts)   | Reads the condition from the stored `CREATE INDEX` statement  |
| Compare old and new schemas | [`makeIndexKey`](src/db/sqlite/migration/Differ.ts) | Includes the condition when deciding whether an index changed |
| Build migration SQL         | [`plan`](src/db/sqlite/migration/Differ.ts)         | Restores the condition on generated index-creation steps      |

The schema-reading code skips quoted text and comments before looking for `WHERE`. This avoids
mistaking an index name or string value for the condition.

Comparison ignores spacing and comments, but preserves meaningful differences. For example,
`'a  b'` and `'a b'` are different values; `a - -1` must not turn into the SQL comment in `a--1`.

## Scope and checks

This preserves predicates on ordinary and unique indexes, including table rebuilds. It does not
add support for SQL expressions the package cannot already translate.

[Tests](test.ts) check both sides of the example: deleted emails can be reused, while duplicate
active emails remain forbidden. They also cover changed conditions, quoting, and rebuilds.
[patch.ts](patch.ts) connects the four implementations to the bundled package.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- partial-index
```

[How to compare the published and patched builds](../../README.md#run-the-project).
