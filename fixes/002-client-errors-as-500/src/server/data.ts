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

/** SQLite's own wording for each constraint, and the PostgREST answer to it. */
const CONSTRAINT_VIOLATIONS: { starts: string; status: number; code: string }[] = [
   { starts: 'UNIQUE constraint failed:', status: 409, code: '23505' },
   { starts: 'FOREIGN KEY constraint failed', status: 409, code: '23503' },
   { starts: 'NOT NULL constraint failed:', status: 400, code: '23502' },
   { starts: 'CHECK constraint failed:', status: 400, code: '23514' },
]

/**
 * Turns a query failure into a PostgREST response.
 *
 * A wrapper rather than a replacement: `handlePostgrestError` is a long ladder of branches, one per
 * error class, and none needed changing. The defect is that two classes never reach it and fall
 * through to the `500 SUP` tail.
 *
 * The ladder does have branches for constraint violations. What converts a driver error into an
 * SQLSTATE is `SqliteConnection.normalizeDbError`, which recognises the constraint by `err.code`:
 *
 *   if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') → 23505
 *   if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY')                                        → 23503
 *   if (code === 'SQLITE_CONSTRAINT_NOTNULL')                                           → 23502
 *
 * That is the better-sqlite3 shape. This package's driver is `node:sqlite`, which puts
 * `ERR_SQLITE_ERROR` in `code` and the constraint in a numeric `errcode`. Nothing matches, the error
 * passes through unchanged, and every constraint violation becomes a `500 SUP` — a duplicate primary
 * key included, the most common client error any API has.
 *
 * So the violations are matched on message text here, as the neighbouring branches (`no such table`,
 * `no such column`) already do: the error is still raw at this point.
 */
export function handlePostgrestError(err: unknown, ctx: PostgrestErrorContext): Response {
   const refusal = rlsRefusalWithoutPolicy(err, ctx)
   if (refusal) return refusal

   const violation = constraintViolation(err)
   if (violation) return violation

   return original(err, ctx)
}

/**
 * RLS denies by command, so a table with only a `FOR SELECT` policy correctly refuses an insert —
 * but that refusal raised a bare `Error('RLS policy violation')` which never reached the error
 * mapper, where the same refusal from a failing `WITH CHECK` came back as a tidy 403.
 *
 * `42501` is what Postgres raises for insufficient privilege and what PostgREST and hosted Supabase
 * return for an RLS refusal. The neighbouring `WITH CHECK` branch answers `PGRST301` instead, a code
 * reserved for an unverifiable JWT — so this deliberately does not match its neighbour. Clients
 * written against Supabase read the real codes, and matching a wrong neighbour would cost them.
 *
 * The neighbour is left alone: it is not a 500, so not this patch's defect, and it is pinned
 * unchanged in the tests. Bringing it to `42501` is a separate change.
 */
function rlsRefusalWithoutPolicy(err: unknown, ctx: PostgrestErrorContext): Response | null {
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
 * A violated constraint is bad data, which is a client error.
 *
 * A named CHECK — `array_type`, generated for `int[]` — is raised as its own class higher up the
 * ladder and already answers 400/23514, so `normalizeDbError` never sees it. That working neighbour
 * is why this looks like one missing code rather than a conversion step that never fires.
 */
function constraintViolation(err: unknown): Response | null {
   const message = messageOf(err)
   const violation = CONSTRAINT_VIOLATIONS.find((v) => message.startsWith(v.starts))
   return violation ? pgrstError(violation.status, violation.code, message, message, null) : null
}

function messageOf(err: unknown): string {
   const cause = (err as { cause?: { message?: string } })?.cause
   const message = cause?.message ?? (err as Error)?.message ?? String(err)
   return typeof message === 'string' ? message : String(message)
}
