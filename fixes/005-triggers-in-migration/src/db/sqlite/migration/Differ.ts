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
   /** Added by this patch: triggers were not part of the diff at all. */
   triggers?: TriggerChange[]
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

interface Differ {
   diffOriginal(current: Schema, desired: Schema): SchemaDiff
}

interface Planner {
   planOriginal(diff: SchemaDiff, current: Schema, desired: Schema, options?: unknown): Plan
}

/**
 * Compares the actual schema with the desired one.
 *
 * The diff covered tables, columns, indexes and foreign keys, but not triggers, so a new trigger
 * never became a plan step — it translated and executed fine, it simply was never created. The
 * planner recreated triggers only as a side effect of rebuilding the table they hang off.
 *
 * The silence is the damage: the migration reports success, the tables are there, the trigger is
 * not. That breaks the canonical Supabase recipes, `handle_new_user()` and `updated_at`.
 */
export function diff(this: Differ, current: Schema, desired: Schema): SchemaDiff {
   const result = this.diffOriginal(current, desired)

   const before = new Map((current.triggers ?? []).map((t) => [t.name, t]))
   const after = new Map((desired.triggers ?? []).map((t) => [t.name, t]))

   const triggers: TriggerChange[] = []
   // By text, not just by name: a redefined trigger must be recreated, and after introspection the
   // text is all that is known about it.
   for (const [name, trigger] of after) {
      const existing = before.get(name)
      if (!existing) triggers.push({ ...trigger, type: 'added' })
      else if (statementOf(existing.sql) !== statementOf(trigger.sql)) {
         triggers.push({ ...existing, type: 'removed' }, { ...trigger, type: 'added' })
      }
   }
   for (const [name, trigger] of before) if (!after.has(name)) triggers.push({ ...trigger, type: 'removed' })

   if (triggers.length === 0) return result
   // Without this the plan comes back empty: it exits early when nothing changed, and triggers did
   // not count as a change.
   return { ...result, triggers, has_changes: true }
}

/**
 * Builds the migration plan. Two things decide where the trigger steps go, and appending them gets
 * both wrong.
 *
 * **Who owns a trigger during a table rebuild.** SQLite drops a table's triggers with the table, so
 * the original recreates the trigger it read — the one as it is now. A migration that changes a
 * column and redefines a trigger together therefore ended with no trigger at all: the original
 * recreated the old one, this patch dropped it, and the replacement was skipped as already planned.
 * The name alone cannot decide it; what the original plans is compared with what is wanted.
 *
 * **Where they run.** The original's plan ends `COMMIT;` then `PRAGMA foreign_keys=ON;`, so appended
 * steps run outside the transaction and a failed trigger leaves the schema half-applied. Before the
 * commit is still after every table step, which is what `CREATE TRIGGER` needs.
 */
export function plan(this: Planner, diff: SchemaDiff, current: Schema, desired: Schema, options?: unknown): Plan {
   const result = this.planOriginal(diff, current, desired, options)
   const changes = diff.triggers ?? []
   if (changes.length === 0) return result

   // What the original already plans to create, by name, with the text it plans to use.
   const planned = new Map<string, string>()
   for (const step of result.steps) {
      if (step.type === 'add_trigger' || /^\s*CREATE\s+TRIGGER/i.test(step.sql)) {
         planned.set(triggerNameOf(step.sql), statementOf(step.sql))
      }
   }

   // Names the original already brings to the wanted state. Both halves go: the create because
   // `CREATE TRIGGER` has no `IF NOT EXISTS`, the drop because it would remove what was just made.
   //
   // A name the original plans with different text is not settled — both steps stay, run after it in
   // the same transaction, and the desired definition has the last word.
   const settled = new Set<string>()
   for (const change of changes) {
      if (change.type !== 'added') continue
      if (planned.get(change.name) === statementOf(change.sql)) settled.add(change.name)
   }

   const steps: PlanStep[] = []
   for (const change of changes.filter((c) => c.type === 'removed')) {
      if (settled.has(change.name)) continue
      steps.push({
         sql: `DROP TRIGGER IF EXISTS ${quoteIdentifier(change.name)};`,
         description: `Drop trigger ${quoteIdentifier(change.name)}`,
         type: 'drop_trigger',
      })
   }
   for (const change of changes.filter((c) => c.type === 'added')) {
      if (settled.has(change.name) || !change.sql) continue
      steps.push({
         sql: `${statementOf(change.sql)};`,
         description: `Create trigger ${quoteIdentifier(change.name)} on ${quoteIdentifier(change.table)}`,
         type: 'add_trigger',
      })
   }

   return steps.length === 0 ? result : { ...result, steps: beforeCommit(result.steps, steps) }
}

/**
 * Puts the new steps inside the transaction the original opened, just before its commit. With no
 * commit step — a plan the original decided needed no transaction — the end is the only place.
 */
function beforeCommit(original: PlanStep[], added: PlanStep[]): PlanStep[] {
   const commit = original.findIndex((s) => s.type === 'commit_transaction')
   if (commit === -1) return [...original, ...added]
   return [...original.slice(0, commit), ...added, ...original.slice(commit)]
}

/**
 * The trigger name out of `CREATE TRIGGER …`, read rather than matched. A regex like `"?([^\s"]+)"?`
 * mishandles a name containing a space (the class stops there) or a quote (SQLite doubles it, so the
 * first half looks like the end) — and a misread name means a trigger recreated every migration or
 * never.
 *
 * Neither can reach here in this build, since the translator mangles such names before the database
 * refuses them; handling them costs nothing and will matter once that is fixed.
 */
function triggerNameOf(sql: string): string {
   const after = /^\s*CREATE\s+TRIGGER\s+/i.exec(sql)
   if (!after) return ''

   const rest = sql.slice(after[0].length)
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
 * only inside a string literal would never be recreated.
 *
 * Exact works because both sides come from the same generator — SQLite stores `CREATE TRIGGER`
 * verbatim, and what ran is what the translator emitted, so a schema migrated twice compares byte
 * for byte (asserted in the tests). The failure modes are also asymmetric: too strict recreates a
 * trigger needlessly, too loose leaves the old one in place for ever.
 */
function statementOf(sql: string): string {
   return (sql ?? '').trim().replace(/;+$/, '').trim()
}

/** SQLite doubles an embedded quote, and a trigger name may legally contain one. */
function quoteIdentifier(name: string): string {
   return `"${name.replace(/"/g, '""')}"`
}
