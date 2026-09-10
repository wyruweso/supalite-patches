// Kept separate from routes because the patcher carries all helpers and bindings in a source file.

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

/** Reuse the library error factory so the response remains invalid_credentials/400. */
declare function invalidCredentials(): Error

/** All initial sign-in flows meet here; deleting sessions and refresh tokens already prevents refresh. */
export async function createSessionForUser(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context: string,
   options: unknown,
): Promise<unknown> {
   // Callers already load deleted_at with the user; no extra query is needed.
   if (user?.deleted_at) throw invalidCredentials()
   return this.createSessionForUserOriginal(user, identities, context, options)
}
