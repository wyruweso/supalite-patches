# FIX-002: return the right kind of error

An API should distinguish a rejected request from a broken server. For example, inserting an
already-used primary key is a conflict with existing data: the caller needs to change the request.

The package correctly rejected several such requests, but returned **HTTP 500**, meaning a server
error. This fix changes the error response; it does not allow the rejected write.

## What changes?

**RLS** means row-level security: database policies deciding which rows a caller may access.
**SQLSTATE** is the error code inside the response body. It is separate from the HTTP status.

| Rejected request                               | Before: HTTP / code | After: HTTP / SQLSTATE                          |
| ---------------------------------------------- | ------------------- | ----------------------------------------------- |
| Duplicate primary key or unique value          | `500 / SUP`         | `409 / 23505`                                   |
| Foreign key points to a missing row            | `500 / SUP`         | `409 / 23503`                                   |
| Required value is null                         | `500 / SUP`         | `400 / 23502`                                   |
| Inline CHECK or date-validity constraint fails | `500 / SUP`         | `400 / 23514`                                   |
| No RLS policy permits the command              | `500 / SUP`         | `403 / 42501`, or `401 / 42501` for role `anon` |

## Why are two changes needed?

First, the error normalizer expected a different SQLite driver. It looked for a string such as
`SQLITE_CONSTRAINT_PRIMARYKEY` in `code`. The shipped `node:sqlite` driver instead reports
`code: ERR_SQLITE_ERROR` and a numeric `errcode`, such as `1555`.

[`normalizeDbError`](src/db/sqlite/SqliteConnection.ts) lets the original normalizer handle errors
it recognizes, then maps remaining numeric constraint codes to SQLSTATE. The existing HTTP mapper
can now recognize most of them. Message wording does not determine the constraint type.

Second, two responses were missing from that mapper: an inline CHECK failure and a plain
`RLS policy violation` error. [`handlePostgrestError`](src/server/data.ts) handles those and delegates
other errors to the original function.

## Scope and checks

Named CHECK failures and the separate RLS `WITH CHECK` response retain their existing behavior.
The `anon` role above means an unauthenticated request; a guest signed in through FEAT-001 has
role `authenticated`.

The SQLite datatype error remains unmapped. It can also mean the package failed to convert valid
input, such as binary data. Calling every such failure a client mistake would hide that defect.

[Tests](test.ts) check statuses, codes, and unchanged neighboring responses.
[patch.ts](patch.ts) installs both wrappers.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- client-errors-as-500
```

[How to compare the published and patched builds](../../README.md#run-the-project).
