interface Trigger {
   name: string
   table: string
   sql: string
}

interface TriggerChange extends Trigger {
   type: 'added' | 'removed'
}

interface Schema {
   triggers?: Trigger[]
}

interface SchemaDiff {
   has_changes: boolean
   triggers?: TriggerChange[]
}

interface PlanStep {
   sql: string
   description: string
   type: string
}

interface Plan {
   steps: PlanStep[]
   warnings: unknown[]
   unsafe: boolean
}

interface Differ {
   diffOriginal(current: Schema, desired: Schema): SchemaDiff
}

interface Planner {
   planOriginal(diff: SchemaDiff, current: Schema, desired: Schema, options?: unknown): Plan
}

/** `create_trigger` is the library's own PlanStepType. It declares no value for removing one. */
const CREATE_TRIGGER = 'create_trigger'
const DROP_TRIGGER = 'drop_trigger'

/** The steps a rebuild is made of; the presence of either means tables are being replaced. */
const REBUILD_STEPS = ['drop_table', 'rename_table']

/**
 * The diff had no `triggers` key at all, so a trigger was never a change to plan for.
 */
export function diff(this: Differ, current: Schema, desired: Schema): SchemaDiff {
   const result = this.diffOriginal(current, desired)

   const currentTriggersByName = new Map((current.triggers ?? []).map((t) => [t.name, t]))
   const desiredTriggersByName = new Map((desired.triggers ?? []).map((t) => [t.name, t]))

   const triggerChanges: TriggerChange[] = []
   for (const [name, trigger] of desiredTriggersByName) {
      const existing = currentTriggersByName.get(name)
      if (!existing) triggerChanges.push({ ...trigger, type: 'added' })
      // SQLite has no CREATE OR REPLACE TRIGGER, so a redefinition is a removal and an addition.
      else if (statementOf(existing.sql) !== statementOf(trigger.sql)) {
         triggerChanges.push({ ...existing, type: 'removed' }, { ...trigger, type: 'added' })
      }
   }
   for (const [name, trigger] of currentTriggersByName) {
      if (!desiredTriggersByName.has(name)) triggerChanges.push({ ...trigger, type: 'removed' })
   }

   if (triggerChanges.length === 0) return result
   return { ...result, triggers: triggerChanges, has_changes: true }
}

/**
 * Trigger steps, placed around the rest of the plan rather than appended to it.
 *
 * SQLite drops a table's own triggers with the table, but a trigger on another table that mentions
 * it survives — and the next `ALTER TABLE` validates the whole schema, finds the dangling reference
 * and fails the migration:
 *
 *    error in trigger on_src_insert: no such table: main.dst
 *
 * So whenever tables are rebuilt, every trigger is dropped before the rebuild and every desired one
 * recreated after it, and the original's own recreation steps are dropped to avoid doing it twice.
 * More work than the minimum, and the minimum is a dependency graph over trigger bodies.
 */
export function plan(this: Planner, diff: SchemaDiff, current: Schema, desired: Schema, options?: unknown): Plan {
   const originalPlan = this.planOriginal(diff, current, desired, options)
   const rebuilding = originalPlan.steps.some((step) => REBUILD_STEPS.includes(step.type))
   const changes = diff.triggers ?? []
   if (!rebuilding && changes.length === 0) return originalPlan

   // A rebuild invalidates every trigger, whichever table it sits on, so the whole set is replaced.
   // Otherwise only what the diff reported has to move.
   const dropped = rebuilding ? (current.triggers ?? []) : changes.filter((c) => c.type === 'removed')
   const created = rebuilding ? (desired.triggers ?? []) : changes.filter((c) => c.type === 'added')

   const steps = originalPlan.steps.filter((step) => !isTriggerCreation(step))
   if (!rebuilding) {
      // Without a rebuild the original may already have planned exactly what the diff asked for.
      const plannedTriggerSqlByName = new Map<string, string>()
      for (const step of originalPlan.steps) {
         if (isTriggerCreation(step)) plannedTriggerSqlByName.set(triggerNameOf(step.sql), statementOf(step.sql))
      }
      const satisfiedTriggerNames = new Set(
         created.filter((t) => plannedTriggerSqlByName.get(t.name) === statementOf(t.sql)).map((t) => t.name),
      )
      if (satisfiedTriggerNames.size > 0) {
         return withTriggerSteps(
            originalPlan,
            originalPlan.steps,
            dropped.filter((t) => !satisfiedTriggerNames.has(t.name)),
            created.filter((t) => !satisfiedTriggerNames.has(t.name)),
         )
      }
   }

   return withTriggerSteps(originalPlan, steps, dropped, created)
}

function withTriggerSteps(originalPlan: Plan, steps: PlanStep[], dropped: Trigger[], created: Trigger[]): Plan {
   if (dropped.length === 0 && created.length === 0) return { ...originalPlan, steps }

   const drops: PlanStep[] = dropped.map((trigger) => ({
      sql: `DROP TRIGGER IF EXISTS ${quoteIdentifier(trigger.name)};`,
      description: `Drop trigger ${quoteIdentifier(trigger.name)}`,
      type: DROP_TRIGGER,
   }))
   const creations: PlanStep[] = created
      .filter((trigger) => trigger.sql)
      .map((trigger) => ({
         sql: `${statementOf(trigger.sql)};`,
         description: `Create trigger ${quoteIdentifier(trigger.name)} on ${quoteIdentifier(trigger.table)}`,
         type: CREATE_TRIGGER,
      }))

   // Inside the transaction the plan opens, and around the work it does: the drops before anything is
   // replaced, the creations once every table exists again.
   const opening = steps.findIndex((step) => step.type === 'begin_transaction')
   const closing = steps.findIndex((step) => step.type === 'commit_transaction')
   const head = opening < 0 ? 0 : opening + 1
   const tail = closing < 0 ? steps.length : closing

   return {
      ...originalPlan,
      steps: [...steps.slice(0, head), ...drops, ...steps.slice(head, tail), ...creations, ...steps.slice(tail)],
   }
}

function isTriggerCreation(step: PlanStep): boolean {
   return step.type === CREATE_TRIGGER || /^\s*CREATE\s+TRIGGER/i.test(step.sql)
}

/**
 * The trigger name out of `CREATE TRIGGER [IF NOT EXISTS] name …`, read rather than matched: an
 * unquoted name ends at whitespace, and a quoted one may contain a doubled quote.
 */
function triggerNameOf(sql: string): string {
   const rest = sql.replace(/^\s*CREATE\s+TRIGGER\s+(IF\s+NOT\s+EXISTS\s+)?/i, '')
   if (rest[0] !== '"') return rest.split(/[\s(]/)[0] ?? ''

   let name = ''
   for (let i = 1; i < rest.length; i++) {
      if (rest[i] !== '"') {
         name += rest[i]
         continue
      }
      // A doubled quote is one quote in the name, not the end of it.
      if (rest[i + 1] === '"') {
         name += '"'
         i++
         continue
      }
      return name
   }
   return ''
}

/**
 * A statement, less the terminator that is not part of it. The comparison is exact, deliberately:
 * collapsing whitespace would equate `VALUES ('a  b')` with `VALUES ('a b')`, so a trigger differing
 * only inside a string literal would never be recreated. Exact works because both sides come from
 * the same generator, and the failure modes are asymmetric — too strict recreates a trigger
 * needlessly, too loose leaves the old one in place for ever.
 */
function statementOf(sql: string): string {
   return (sql ?? '').trim().replace(/;+$/, '').trim()
}

/** SQLite doubles an embedded quote, and a trigger name may legally contain one. */
function quoteIdentifier(name: string): string {
   return `"${name.replace(/"/g, '""')}"`
}
