/** The original implementation, renamed by the patcher; handles every other error. */
declare function original(err: unknown, ctx: PostgrestErrorContext): Response

/** Builds a PostgREST response: `pgrstError(status, code, message, details, hint)`. */
declare function pgrstError(
   status: number,
   code: string,
   message: string,
   details: string | null,
   hint: string | null,
): Response

interface PostgrestErrorContext {
   vars?: { auth?: { role?: string } }
   ast?: { from?: string }
}

/** SQLITE_CONSTRAINT_CHECK. */
const CHECK_VIOLATION = 275

/**
 * Two refusals that never reach the right branch of the ladder below.
 *
 * The constraint violations are not handled here: they are given their SQLSTATE in
 * `SqliteConnection.normalizeDbError`, which this mapper calls, so the ladder's own `23505`, `23503`
 * and `23502` branches answer them. What is left is the two cases the ladder has no branch for.
 */
export function handlePostgrestError(err: unknown, ctx: PostgrestErrorContext): Response {
   const refusal = responseForMissingRlsPolicy(err, ctx)
   if (refusal) return refusal

   const check = responseForCheckViolation(err)
   if (check) return check

   return original(err, ctx)
}

/**
 * RLS denies by command, so a table with only a `FOR SELECT` policy correctly refuses an insert —
 * but that refusal raised a bare `Error('RLS policy violation')`, which is not a database error and
 * reaches no branch at all.
 *
 * `42501` is what Postgres raises for insufficient privilege and what PostgREST and hosted Supabase
 * return. The neighbouring `WITH CHECK` branch answers `PGRST301`, a code reserved for an
 * unverifiable JWT, so this deliberately does not match its neighbour: clients written against
 * Supabase read the real codes. The neighbour is left alone — it is not a 500, so not this patch's
 * defect, and the tests pin it unchanged.
 */
function responseForMissingRlsPolicy(err: unknown, ctx: PostgrestErrorContext): Response | null {
   if (!(err instanceof Error) || err.message !== 'RLS policy violation') return null

   // The PolicyViolation branch's rule, and PostgREST's own: 401 for an anonymous caller, who has
   // a reason to identify themselves, 403 for one who already has.
   const status = (ctx.vars?.auth?.role ?? 'anon') === 'anon' ? 401 : 403
   return pgrstError(
      status,
      '42501',
      `new row violates row-level security policy for table "${ctx.ast?.from ?? 'unknown'}"`,
      null,
      null,
   )
}

/**
 * An inline `CHECK` violation, which normalises to `23514` — a SQLSTATE the ladder has no branch
 * for, so it would fall through to the `500 SUP` tail. A *named* CHECK is raised as its own class
 * higher up and already answers 400, which is why this looked like one missing code rather than a
 * whole conversion step that never fired.
 *
 * Matched on SQLite's numeric code, not on the message, so an error someone else has already formed
 * cannot be captured by wording alone.
 */
function responseForCheckViolation(err: unknown): Response | null {
   if (errcodeOf(err) !== CHECK_VIOLATION) return null

   const message = messageOf(err)
   return pgrstError(400, '23514', message, message, null)
}

function errcodeOf(err: unknown): unknown {
   const error = err as { errcode?: unknown; cause?: { errcode?: unknown } }
   return error?.cause?.errcode ?? error?.errcode
}

function messageOf(err: unknown): string {
   const error = err as { message?: unknown; cause?: { message?: unknown } }
   const message = error?.cause?.message ?? error?.message ?? String(err)
   return typeof message === 'string' ? message : String(message)
}
