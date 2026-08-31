interface IndexModel {
   name: string
   table: string
   unique: boolean
   columns: string[]
   where?: string | null
}

interface PlanStep {
   sql: string
   description: string
   type: string
}

interface Plan {
   steps: PlanStep[]
   warnings: string[]
   unsafe: boolean
}

interface Schema {
   indexes: IndexModel[]
}

interface Planner {
   planOriginal(diff: { has_changes: boolean }, current: Schema, desired: Schema, options?: unknown): Plan
}

/**
 * The key indexes are matched by between the actual and desired schema. Without the predicate in it,
 * changing only the `WHERE` would look like no change at all — `email UNIQUE WHERE deleted_at IS
 * NULL` and a global `email UNIQUE` are different indexes.
 */
export function makeIndexKey(index: IndexModel): string {
   return `${index.table}:${index.name}:${index.unique}:${index.columns.join(',')}:${index.where ?? ''}`
}

/**
 * Builds the migration plan.
 *
 * `CREATE INDEX` is assembled in three branches — creating, altering and rebuilding a table — all of
 * which produce an `add_index` step passing through here. Appending the predicate to the finished
 * statement keeps the change in one place instead of three identical edits. Factoring the assembly
 * out would be the better move in a source repository, but that is a refactor, not a fix.
 */
export function plan(
   this: Planner,
   diff: { has_changes: boolean },
   current: Schema,
   desired: Schema,
   options?: unknown,
): Plan {
   const result = this.planOriginal(diff, current, desired, options)

   const predicates = new Map<string, string>()
   for (const index of desired.indexes ?? []) if (index.where) predicates.set(index.name, index.where)
   if (predicates.size === 0) return result

   return {
      ...result,
      steps: result.steps.map((step) => {
         if (step.type !== 'add_index') return step
         const predicate = predicates.get(indexNameOf(step.sql))
         if (!predicate) return step
         return { ...step, sql: `${step.sql.replace(/;\s*$/, '')} WHERE ${predicate};` }
      }),
   }
}

/**
 * The index name out of a generated `CREATE [UNIQUE] INDEX "name" …`, read rather than matched: a
 * quote inside an identifier is written by doubling it, and `"([^"]+)"` stops at the first half, so
 * `"active""users"` would come back as `active` and lose its predicate.
 *
 * No such name can reach here today — the identifier quoting fails earlier — but this reads
 * correctly rather than being right by accident of a defect elsewhere.
 */
function indexNameOf(sql: string): string {
   const opening = sql.indexOf('"')
   if (opening < 0) return ''

   let name = ''
   for (let i = opening + 1; i < sql.length; i++) {
      if (sql[i] !== '"') {
         name += sql[i]
         continue
      }
      if (sql[i + 1] === '"') {
         // A doubled quote is one quote in the name, not the end of it.
         name += '"'
         i++
         continue
      }
      return name
   }
   return ''
}
