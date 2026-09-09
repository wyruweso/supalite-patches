interface UserRow {
   id: string
   email: string | null
   is_anonymous?: boolean | number
   raw_user_meta_data?: string | null
   raw_app_meta_data?: string | null
   [key: string]: unknown
}

interface Session {
   access_token: string
   user: Record<string, unknown>
}

/** The library's own refusal, called rather than reproduced. The patcher supplies its minified name. */
declare function anonymousProviderDisabled(): Error

interface AuthService {
   config: { enable_signup?: boolean; enable_anonymous_sign_ins?: boolean; jwt_secret: string }
   repo: {
      createUser(user: Partial<UserRow> & { id: string; email: string | null }): Promise<UserRow>
      updateUser(id: string, updates: Record<string, unknown>): Promise<unknown>
   }

   signUpOriginal(
      email: string | undefined,
      password: string | undefined,
      data: Record<string, unknown>,
   ): Promise<unknown>
   mapUserToResponseOriginal(user: UserRow, identities: unknown[], context: string): Record<string, unknown>
   createSessionForUserOriginal(
      user: UserRow,
      identities: unknown[],
      context?: string,
      options?: unknown,
   ): Promise<Session>
   createSessionForUser(user: UserRow, identities: unknown[], context: string): Promise<Session>
   createRefreshResponseOriginal(
      user: UserRow,
      sessionId: string,
      refreshToken: string,
      timestamp: unknown,
   ): Promise<Session>
}

/** SQLite returns 0/1; newly created users carry booleans. */
function isAnonymous(value: unknown): boolean {
   return value === true || value === 1
}

/** supabase-js requests anonymous sign-in through POST /signup without credentials. */
export async function signUp(
   this: AuthService,
   email: string | undefined,
   password: string | undefined,
   data: Record<string, unknown>,
): Promise<unknown> {
   // Anonymous means no credentials at all; half a pair stays an error the original reports.
   if (email || password) return this.signUpOriginal(email, password, data)

   // Before the sign-up flag, as upstream checks it: with both switched off the answer should name
   // the anonymous provider, not sign-ups.
   if (this.config.enable_anonymous_sign_ins !== true) throw anonymousProviderDisabled()
   if (this.config.enable_signup === false) return this.signUpOriginal(email, password, data)

   const user = await this.repo.createUser({
      id: crypto.randomUUID(),
      email: null,
      is_anonymous: true,
      raw_user_meta_data: JSON.stringify(data ?? {}),
      // Anonymous users have no provider or identity.
      raw_app_meta_data: JSON.stringify({}),
   })

   // Anonymous users have the authenticated role; RLS distinguishes them by their claim.
   const session = await this.createSessionForUser(user, [], 'session')
   return { user: session.user, session }
}

/** Expose the stored anonymous flag instead of the original constant false. */
export function mapUserToResponse(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context: string,
): Record<string, unknown> {
   return { ...this.mapUserToResponseOriginal(user, identities, context), is_anonymous: isAnonymous(user.is_anonymous) }
}

/** The original builds JWT claims inline, so add the claim by re-signing its token. */
export async function createSessionForUser(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context?: string,
   options?: unknown,
): Promise<Session> {
   const promoted = await markVerifiedAnonymousUserAsPermanent(this, user, context)
   return withAnonymousClaim(
      await this.createSessionForUserOriginal(promoted, identities, context, options),
      promoted,
      this.config.jwt_secret,
   )
}

/** Refresh mints a separate access token and must include the same claim. */
export async function createRefreshResponse(
   this: AuthService,
   user: UserRow,
   sessionId: string,
   refreshToken: string,
   timestamp: unknown,
): Promise<Session> {
   return withAnonymousClaim(
      await this.createRefreshResponseOriginal(user, sessionId, refreshToken, timestamp),
      user,
      this.config.jwt_secret,
   )
}

/**
 * Email verification has already updated the identity and user metadata.
 * Clear the anonymous flag before creating the session. This build supports email conversion only.
 */
async function markVerifiedAnonymousUserAsPermanent(
   service: AuthService,
   user: UserRow,
   context?: string,
): Promise<UserRow> {
   if (context !== 'verify' || !isAnonymous(user.is_anonymous) || !user.email) return user

   await service.repo.updateUser(user.id, { is_anonymous: false })
   return { ...user, is_anonymous: false }
}

/** Include false on ordinary sessions too: RLS treats an absent claim as NULL. */
async function withAnonymousClaim(session: Session, user: UserRow, secret: string): Promise<Session> {
   const [header, payload] = session.access_token.split('.')
   const claims = JSON.parse(fromBase64Url(payload))

   // Mutate the session to preserve non-enumerable session_id/user_id used by Sb-Auth-* headers.
   session.access_token = await resign(header, { ...claims, is_anonymous: isAnonymous(user.is_anonymous) }, secret)
   return session
}

/** Decode the UTF-8 bytes returned by atob before parsing JSON. */
function fromBase64Url(value: string): string {
   const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
   return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
}

function toBase64Url(bytes: Uint8Array): string {
   let binary = ''
   for (const byte of bytes) binary += String.fromCharCode(byte)
   return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** HS256, the algorithm the library signs with, over the header the library wrote. */
async function resign(header: string, claims: Record<string, unknown>, secret: string): Promise<string> {
   const encoder = new TextEncoder()
   const signingInput = `${header}.${toBase64Url(encoder.encode(JSON.stringify(claims)))}`

   const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
   ])
   const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))
   return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`
}
