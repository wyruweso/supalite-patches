// The other half of the soft delete: a user marked deleted is refused a session.
//
// A file of its own rather than a second export beside the routes, because a patch file is spliced
// whole and its helpers travel with it. The routes need the router, this needs the error factory.

interface UserRow {
   id: string
   email: string | null
   deleted_at?: string | null
   [key: string]: unknown
}

interface AuthService {
   /** The method this patch wraps, renamed by the patcher. */
   createSessionForUserOriginal(
      user: UserRow,
      identities: unknown[],
      context: string,
      options: unknown,
   ): Promise<unknown>
}

/**
 * The library's own "Invalid login credentials" — a 400 the error mapper already knows, rather than
 * an exception escaping as a 500. The patcher recovers its name from the message text.
 */
declare function invalidCredentials(): Error

/**
 * Issuing a session, with a soft-deleted user refused.
 *
 * `deleted_at` occurs exactly once in the published bundle — in the DDL creating the column — so
 * nothing reads it. The delete replaces the identifiers with a digest, which already stops the
 * address reaching this row, but the row is still reachable by id and by whatever path is added next.
 *
 * So the check goes where the paths meet. Every flow creating an initial authenticated session —
 * password, signup, `verifyOtp`, magic link, recovery, OAuth, PKCE exchange — converges here: one
 * seam instead of five, and a flow added later is covered without being edited.
 *
 * Refresh is deliberately not guarded: the delete takes the refresh token and session row with it,
 * so `createRefreshResponse` fails on a missing token anyway. Tested alongside.
 *
 * A token already issued is out of reach from here. The auth API covers it anyway — the middleware
 * loads the session named by `session_id` and refuses when it is gone — but the Data API does not,
 * since PostgREST checks a signature and an expiry and asks nobody about sessions, exactly as
 * upstream Supabase does. Both are asserted in the tests.
 *
 * The library's own `invalid_credentials` rather than a new error: a caller holding a deleted account
 * learns exactly what a caller with a wrong password learns.
 */
export async function createSessionForUser(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context: string,
   options: unknown,
): Promise<unknown> {
   // Off the row passed in, which every call site loads with `selectAll`. Reading it by id again
   // would put a query on the hot path of every sign-in for a column already in hand.
   if (user?.deleted_at) throw invalidCredentials()
   return this.createSessionForUserOriginal(user, identities, context, options)
}
