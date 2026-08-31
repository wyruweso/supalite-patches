// The plan a schema change produces, step by step.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { lite, newApp, type LiteConnection } from '../test/harness.ts'

interface PlanStep {
   type: string
   description?: string
}

async function planFor(before: string, after: string) {
   const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
   await (await connection.createMigrator(before)).migrate()
   const result = await (await connection.createMigrator(after)).diff()
   return {
      diff: result.diff,
      steps: ((result.plan?.steps ?? []) as PlanStep[]).map((step) => step.type),
      descriptions: ((result.plan?.steps ?? []) as PlanStep[]).map((step) => step.description ?? ''),
   }
}

const REBUILD = ['create_table', 'copy_data', 'drop_table', 'rename_table']

describe('a schema that has not changed', () => {
   test('reports no changes and plans no steps', async () => {
      const { diff, steps } = await planFor(
         'CREATE TABLE t (a int primary key);',
         'CREATE TABLE t (a int primary key);',
      )
      assert.equal(diff.has_changes, false)
      assert.deepEqual(diff.tables, [])
      assert.deepEqual(steps, [])
   })
})

describe('changes SQLite can make in place', () => {
   test('adding a column is a single ALTER, with no table rewrite', async () => {
      const { diff, steps } = await planFor(
         'CREATE TABLE t (a int primary key);',
         'CREATE TABLE t (a int primary key, b text);',
      )
      assert.equal(diff.has_changes, true)
      assert.deepEqual(
         diff.columns.map((c: any) => [c.type, c.name]),
         [['added', 'b']],
      )
      assert.deepEqual(steps, [
         'disable_foreign_keys',
         'begin_transaction',
         'add_column',
         'commit_transaction',
         'enable_foreign_keys',
      ])
   })

   test('a new table is created outright', async () => {
      const { diff, steps } = await planFor(
         'CREATE TABLE t (a int primary key);',
         'CREATE TABLE t (a int primary key); CREATE TABLE u (x int primary key);',
      )
      assert.deepEqual(
         diff.tables.map((t: any) => [t.type, t.name]),
         [['added', 'u']],
      )
      assert.deepEqual(steps, [
         'disable_foreign_keys',
         'begin_transaction',
         'create_table',
         'commit_transaction',
         'enable_foreign_keys',
      ])
   })
})

describe('changes that force a table rebuild', () => {
   test('dropping a column rebuilds the table', async () => {
      const { diff, steps, descriptions } = await planFor(
         'CREATE TABLE t (a int primary key, b text);',
         'CREATE TABLE t (a int primary key);',
      )
      assert.deepEqual(
         diff.columns.map((c: any) => [c.type, c.name]),
         [['removed', 'b']],
      )
      assert.deepEqual(steps.slice(2, 6), REBUILD)
      assert.match(descriptions.join('\n'), /Create temporary table "_t_migrate_new"/)
      assert.match(descriptions.join('\n'), /Copy data from "t" to "_t_migrate_new"/)
      assert.match(descriptions.join('\n'), /Rename "_t_migrate_new" to "t"/)
   })

   test('changing a column type rebuilds the table, and the diff names both types', async () => {
      const { diff, steps } = await planFor(
         'CREATE TABLE t (a int primary key, b text);',
         'CREATE TABLE t (a int primary key, b int);',
      )
      assert.deepEqual(diff.columns[0].changes, { type: { from: 'text', to: 'integer' } })
      assert.deepEqual(steps.slice(2, 6), REBUILD)
   })

   test('adding an INDEX also rebuilds the whole table', async () => {
      const { diff, steps } = await planFor(
         'CREATE TABLE t (a int primary key, b text);',
         'CREATE TABLE t (a int primary key, b text); CREATE INDEX i ON t (b);',
      )
      assert.deepEqual(diff.tables, [])
      assert.deepEqual(diff.columns, [])
      assert.deepEqual(
         diff.indexes.map((i: any) => [i.type, i.name, i.columns]),
         [['added', 'i', ['b']]],
      )
      assert.deepEqual(steps.slice(2, 6), REBUILD)
      assert.ok(steps.includes('add_index'))
   })
})

describe('the plan envelope', () => {
   test('every plan disables foreign keys first and re-enables them last', async () => {
      for (const [before, after] of [
         ['CREATE TABLE t (a int primary key);', 'CREATE TABLE t (a int primary key, b text);'],
         ['CREATE TABLE t (a int primary key, b text);', 'CREATE TABLE t (a int primary key);'],
      ] as const) {
         const { steps } = await planFor(before, after)
         assert.equal(steps[0], 'disable_foreign_keys')
         assert.equal(steps[steps.length - 1], 'enable_foreign_keys')
      }
   })

   test('the work happens inside a transaction', async () => {
      const { steps } = await planFor(
         'CREATE TABLE t (a int primary key, b text);',
         'CREATE TABLE t (a int primary key);',
      )
      assert.equal(steps[1], 'begin_transaction')
      assert.equal(steps[steps.length - 2], 'commit_transaction')
   })

   test('every step type used is one of the declared PlanStepType values', async () => {
      const { lite } = await import('../test/harness.ts')
      const declared = new Set(Object.values(lite.PlanStepType))
      const { steps } = await planFor(
         'CREATE TABLE t (a int primary key, b text);',
         'CREATE TABLE t (a int primary key);',
      )
      for (const step of steps) assert.ok(declared.has(step), `${step} is not in PlanStepType`)
   })
})

describe('the data-loss guard', () => {
   const populated = async () => {
      const { app, connection } = await newApp({ seed: false })
      await (await connection.createMigrator('CREATE TABLE t (a int primary key, b text);')).migrate()
      const { post } = await import('../test/harness.ts')
      await post(app, '/rest/v1/t', [
         { a: 1, b: 'keep' },
         { a: 2, b: 'me' },
      ])
      return { app, connection }
   }

   test('dropping a column is refused with a DataLossError', async () => {
      const { connection } = await populated()
      const migrator = await connection.createMigrator('CREATE TABLE t (a int primary key);')
      await assert.rejects(() => migrator.migrate(), /Migration would cause data loss/)
   })

   test('the refusal leaves the table untouched', async () => {
      const { app, connection } = await populated()
      const { get } = await import('../test/harness.ts')
      await (await connection.createMigrator('CREATE TABLE t (a int primary key);')).migrate().catch(() => {})
      assert.deepEqual((await get(app, '/rest/v1/t?select=a,b&order=a')).body, [
         { a: 1, b: 'keep' },
         { a: 2, b: 'me' },
      ])
   })

   test('force:true performs the drop and preserves the surviving columns', async () => {
      const { app, connection } = await populated()
      const { get } = await import('../test/harness.ts')
      await (await connection.createMigrator('CREATE TABLE t (a int primary key);')).migrate({ force: true })
      assert.deepEqual((await get(app, '/rest/v1/t?select=a&order=a')).body, [{ a: 1 }, { a: 2 }])
   })

   test('adding a column needs no force, because nothing is lost', async () => {
      const { app, connection } = await populated()
      const { get } = await import('../test/harness.ts')
      await (await connection.createMigrator('CREATE TABLE t (a int primary key, b text, c int);')).migrate()
      assert.deepEqual((await get(app, '/rest/v1/t?select=a,c&order=a')).body, [
         { a: 1, c: null },
         { a: 2, c: null },
      ])
   })
})

// An expression index is translated correctly and executes, but cannot survive the migrator: the
// expression introspects as a null column name, which the planner then emits quoted.
describe('an index over an expression', () => {
   const DDL = "CREATE TABLE t (a int primary key, n text); CREATE UNIQUE INDEX k ON t (a, (nullif(n, '')));"

   test('the translated DDL executes', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      await connection.exec(await lite.translatePostgresDdl(DDL))
   })

   test('the same DDL through the migrator fails', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      await assert.rejects(async () => (await connection.createMigrator(DDL)).migrate(), /no such column: "null"/)
   })

   test('the expression column is modelled as null and planned quoted', async () => {
      const { connection }: { connection: LiteConnection } = await newApp({ seed: false })
      await (await connection.createMigrator('CREATE TABLE t (a int primary key, n text);')).migrate()
      const { diff, plan } = await (await connection.createMigrator(DDL)).diff()

      assert.deepEqual(
         diff.indexes.map((i: { name: string; columns: unknown[] }) => [i.name, i.columns]),
         [['k', ['a', null]]],
      )
      const step = (plan?.steps ?? []).find((s: { type: string }) => s.type === 'add_index')
      assert.match(step.sql, /"null"/)
   })
})
