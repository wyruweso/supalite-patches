# FIX-003: return arrays, objects, and booleans as their declared types

A column declared as an array should reach the application as an array. In the pinned `0.9.0`
build, the API often returned the JSON text instead:

```jsonc
// Before:
[{ "tags": "[\"a\",\"b\"]", "meta": "{\"x\":1}", "ok": 1 }]
// After:
[{ "tags": ["a", "b"], "meta": { "x": 1 }, "ok": true }]
```

The stored values were intact, but ordinary application code broke: `row.tags.map(...)` throws
when `tags` is a string, and `1 === true` is false.

## Why did this happen?

SQLite stores these values differently from PostgreSQL. The package already records the declared
PostgreSQL types and knows how to convert stored values back for the API.

Those paths run only when `ddlDialect === 'postgres'`. **Dialect** here means the SQL language used
to describe the schema; the database itself remains SQLite.

The constructor left this setting undefined when the caller omitted it, so type information and
response conversion were skipped.

## How the fix works

[`defaultDialect`](src/db/sqlite/SqliteConnection.ts) sets the missing value:

```ts
connection.config.ddlDialect ??= 'postgres'
```

`??=` supplies a default only when the value is null or undefined. An explicitly chosen dialect
is preserved.

The patch calls this before `introspect` reads the schema and before `deserializeRow` converts a
stored row into response values. It then runs the original methods. The existing conversion code
does the work; the fix does not guess types from column names or CHECK expressions.

## Scope and checks

**Fixed upstream in `0.9.1-next.2` and later.** This patch remains useful for the project's `0.9.0`
baseline.

`boolean[]` still returns numeric elements such as `[1, 0]`. This fix restores the outer array,
but the package needs a separate change to convert its elements.

[Tests](test.ts) cover arrays, JSON, booleans, and integers that must stay integers.
[patch.ts](patch.ts) wraps the two methods; the patcher cannot wrap the constructor.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- value-types
```

[How to compare the published and patched builds](../../README.md#run-the-project).
