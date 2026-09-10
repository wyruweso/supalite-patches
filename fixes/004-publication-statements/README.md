# FIX-004: let schemas containing publications migrate to SQLite

A PostgreSQL **publication** selects changes to send through logical replication. Supabase Realtime
uses this mechanism to receive database changes. SQLite has no equivalent publication feature.

An exported Supabase schema can still contain publication commands beside ordinary table definitions:

```sql
CREATE TABLE messages (id int primary key, body text);
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
```

## What was wrong?

The package tried to translate publication commands into SQL for SQLite. Some produced invalid SQL;
others failed during translation. Either failure prevented the rest of the schema from migrating.

For example, `ALTER PUBLICATION ... ADD TABLE messages` became
`ALTER PUBLICATION ... ADD FOR TABLE TABLE messages`.

## How the fix works

The SQL parser first turns a statement into an **AST**, a structured description of its contents.
[`visit`](src/db/translation/SqliteDeparser.ts) checks that structure and returns an empty string
for publication statements. Other statements continue through the original translator.

It covers creation, membership changes, removal, renaming, and owner changes. Some of those use
AST types shared with other database objects. The code checks the object kind too, so dropping a
publication does not accidentally disable `DROP TABLE`.

In the example, SQLite receives the table definition and no publication SQL. A quoted string
containing the word `PUBLICATION` is still ordinary data. Malformed SQL still fails parsing.

## Scope and checks

**This enables schema import. Realtime is not implemented by this patch.** An application can create
and use the `messages` table, but this change does not make SQLite publish its changes.

[Tests](test.ts) cover all publication forms, unaffected statements, and a table migrating beside
the publication commands. Changing only a publication must leave the table's data and plan alone.
[patch.ts](patch.ts) wraps the translator's `visit` method.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- publication-statements
```

[How to compare the published and patched builds](../../README.md#run-the-project).
