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
 * The key indexes are matched by. Without the predicate, `email UNIQUE WHERE deleted_at IS NULL` and
 * a global `email UNIQUE` are the same index; with it compared as raw text, `a>0` and `a > 0` are
 * two, and a migration rebuilds the table to replace an index with itself.
 */
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

/**
 * Whitespace outside quoted text carries no meaning, so `a>0` and `a > 0` are one predicate. Quoted
 * runs are copied verbatim — collapsing inside them would rewrite a literal.
 */
function normalisePredicate(predicate: string): string {
   let normalised = ''

   for (let i = 0; i < predicate.length; i++) {
      const char = predicate[i]

      if (char === "'" || char === '"' || char === '`') {
         const closing = closingQuote(predicate, i)
         normalised += predicate.slice(i, closing + 1)
         i = closing
         continue
      }
      if (char === '[') {
         const closing = predicate.indexOf(']', i + 1)
         const end = closing < 0 ? predicate.length - 1 : closing
         normalised += predicate.slice(i, end + 1)
         i = end
         continue
      }
      if (!WHITESPACE.test(char)) {
         normalised += char
         continue
      }

      // A run of whitespace separates two things only when both sides are word characters: `NOT NULL`
      // is two words, `a > 0` is one expression however it is spaced.
      let after = i
      while (after < predicate.length && WHITESPACE.test(predicate[after])) after++
      if (isWordCharacter(normalised[normalised.length - 1]) && isWordCharacter(predicate[after])) normalised += ' '
      i = after - 1
   }

   return normalised
}

/** The closing quote of the run opened at `opening`, skipping the doubling SQLite escapes with. */
function closingQuote(sql: string, opening: number): number {
   const quote = sql[opening]
   for (let i = opening + 1; i < sql.length; i++) {
      if (sql[i] !== quote) continue
      if (sql[i + 1] === quote) {
         i++
         continue
      }
      return i
   }
   return sql.length - 1
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

// Declared once rather than inside the test below: the patcher moves top-level declarations into the
// function it splices, so a literal here is built per call rather than per character.
const WORD_CHARACTER = /[\p{L}\p{N}_$]/u
const WHITESPACE = /\s/

function isWordCharacter(char: string | undefined): boolean {
   return char !== undefined && WORD_CHARACTER.test(char)
}
