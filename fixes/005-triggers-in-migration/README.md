# FIX-005: include triggers in migrations

A **trigger** runs SQL automatically when a database event occurs. For example, inserting a user
can create their profile, or updating a row can set its `updated_at` value.

A **migration** brings an existing database into line with the desired schema.

## What was wrong?

The package could translate a trigger and create it by executing that SQL directly. But its schema
comparison did not track trigger changes. A migration could report success while leaving the
trigger missing.

For a profile-creation trigger, that means signup succeeds but the expected profile never appears.
The original planner could create the trigger later as a side effect of rebuilding its table,
which made the behavior inconsistent.

## How the fix works

Everything is in [Differ.ts](src/db/sqlite/migration/Differ.ts):

- `diff` compares current and desired triggers by name and SQL. A changed definition becomes a
  removal followed by an addition.
- `plan` places those changes around the existing migration steps and avoids duplicate creation.
- `withTriggerSteps` puts trigger removal before table replacement and trigger creation afterwards.

The order matters because some schema changes **rebuild a table**: create a replacement, copy rows,
drop the old table, and rename the replacement.

Suppose a trigger belongs to `orders` but writes to `audit_log`. Rebuilding `audit_log` leaves that
trigger referring to a temporarily missing table. SQLite checks the reference during the rename
and refuses the migration.

During a rebuild, the patch therefore drops all current triggers, rebuilds the tables, and creates
all desired triggers. Without a rebuild, it applies only the trigger changes. This keeps the code
small without needing to analyze every dependency inside trigger SQL.

## Scope and checks

The package executes the migration in a transaction: if a step fails, earlier changes are rolled
back too. [Tests](test.ts) deliberately fail a rebuild after dropping a trigger and check that it
is restored. They also check that triggers actually run, not just appear in the plan.

This works with trigger SQL the package already translates. Dependent views need separate handling;
they are recorded in [Additional findings](../../ADDITIONAL_FINDINGS.md).
[patch.ts](patch.ts) wraps the schema comparison and planner.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- triggers-in-migration
```

[How to compare the published and patched builds](../../README.md#run-the-project).
