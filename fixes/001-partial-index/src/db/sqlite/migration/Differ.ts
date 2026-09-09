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

/** Include the predicate without treating formatting changes as index changes. */
export function makeIndexKey(index: IndexModel): string {
   const predicate = index.where ? normalisePredicate(index.where) : ''
   return `${index.table}:${index.name}:${index.unique}:${index.columns.join(',')}:${predicate}`
}

/**
 * `CREATE INDEX` is assembled in three branches — creating, altering and rebuilding a table — all of
 * which produce an `add_index` step passing through here, so appending the predicate to the finished
 * statement keeps the change in one place instead of three.
 */
export function plan(
   this: Planner,
   diff: { has_changes: boolean },
   current: Schema,
   desired: Schema,
   options?: unknown,
): Plan {
   const originalPlan = this.planOriginal(diff, current, desired, options)

   const predicateByIndexName = new Map<string, string>()
   for (const index of desired.indexes ?? []) {
      if (index.where) predicateByIndexName.set(index.name, index.where)
   }
   if (predicateByIndexName.size === 0) return originalPlan

   return {
      ...originalPlan,
      steps: originalPlan.steps.map((step) => {
         if (step.type !== 'add_index') return step
         const predicate = predicateByIndexName.get(readIndexNameFromCreateSql(step.sql))
         if (!predicate) return step
         return { ...step, sql: `${step.sql.replace(/;\s*$/, '')} WHERE ${predicate};` }
      }),
   }
}

/** Keep token boundaries: removing spaces must not turn `a - -1` into the comment in `a--1`. */
function normalisePredicate(predicate: string): string {
   const parts = predicate.match(SQLITE_PREDICATE_PARTS) ?? []
   return JSON.stringify(parts.filter((part) => !SQLITE_PREDICATE_SPACING.test(part)))
}

/**
 * The index name out of a generated `CREATE [UNIQUE] INDEX "name" …`, read rather than matched: a
 * quote inside an identifier is written by doubling it, and `"([^"]+)"` stops at the first half.
 */
function readIndexNameFromCreateSql(sql: string): string {
   const opening = sql.indexOf('"')
   if (opening < 0) return ''

   let name = ''
   for (let i = opening + 1; i < sql.length; i++) {
      if (sql[i] !== '"') {
         name += sql[i]
         continue
      }
      if (sql[i + 1] === '"') {
         name += '"'
         i++
         continue
      }
      return name
   }
   return ''
}

const SQLITE_PREDICATE_SPACING = /^(?:[ \t\r\n\f]|--|\/\*)/

// Only SQLite predicate text: comments, quoted values, numbers, names, and operators.
const SQLITE_PREDICATE_PARTS = new RegExp(
   [
      /[ \t\r\n\f]+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/.source,
      /[xX]?'(?:''|[^'])*'/.source,
      /"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/.source,
      /0[xX][\da-fA-F_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?/.source,
      /[A-Za-z_$\u0080-\uFFFF][\w$\u0080-\uFFFF]*/.source,
      /->>|->|<<|>>|<=|>=|==|!=|<>|\|\|/.source,
      /[\s\S]/.source,
   ].join('|'),
   'g',
)
