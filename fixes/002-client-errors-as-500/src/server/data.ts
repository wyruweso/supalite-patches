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
 * Handle RLS and inline CHECK refusals missing from the original mapper.
 * Other constraints use its existing SQLSTATE branches.
 */
export function handlePostgrestError(err: unknown, ctx: PostgrestErrorContext): Response {
   const refusal = responseForMissingRlsPolicy(err, ctx)
   if (refusal) return refusal

   const check = responseForCheckViolation(err)
   if (check) return check

   return original(err, ctx)
}

/**
 * A missing command policy raises a plain Error. Return SQLSTATE 42501.
 * The separate WITH CHECK branch keeps its existing PGRST301 response.
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

/** Match inline CHECK failures by numeric code. Named CHECK errors already have a response. */
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
