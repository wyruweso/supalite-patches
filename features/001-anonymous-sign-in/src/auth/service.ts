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

/**
 * SQLite has no boolean: the column round-trips as 0/1 while `createUser` is handed `true`. Only
 * those two count — guessing at anything else invites the silent failure, since `!!'false'` is true.
 */
function isAnonymous(value: unknown): boolean {
   return value === true || value === 1
}

/**
 * Sign-up. supabase-js makes an anonymous sign-in with the same request as an ordinary sign-up:
 * POST /auth/v1/signup with no email and no password.
 */
export async function signUp(
   this: AuthService,
   email: string | undefined,
   password: string | undefined,
   data: Record<string, unknown>,
): Promise<unknown> {
   // Anonymous means no credentials at all; half a pair stays an error the original reports.
   //
   // Deliberately stricter than upstream, which looks only for a missing email or phone and so sends
   // `{email: "", password: "x"}` down the anonymous path. A request carrying a password is not
   // `signInAnonymously()`, whatever else is missing from it.
   if (email || password) return this.signUpOriginal(email, password, data)

   // Supabase gates this behind `enable_anonymous_sign_ins`, which defaults to off: allowing
   // sign-ups does not allow anonymous ones.
   //
   // Checked before the sign-up flag, as upstream does, and that order is why the refusal is raised
   // here rather than delegated: with both switched off the answer should be
   // `anonymous_provider_disabled`, the specific reason, not `signup_disabled`. The error is the
   // library's own, called by the name the patcher recovered.
   if (this.config.enable_anonymous_sign_ins !== true) throw anonymousProviderDisabled()

   // Sign-ups off refuses it too, and there the original's answer is the right one.
   if (this.config.enable_signup === false) return this.signUpOriginal(email, password, data)

   const user = await this.repo.createUser({
      id: crypto.randomUUID(),
      email: null,
      is_anonymous: true,
      raw_user_meta_data: JSON.stringify(data ?? {}),
      // Empty rather than `{provider: 'anonymous'}`: an anonymous user has no identity, so upstream
      // records no provider. `identities` comes back `[]` for the same reason.
      raw_app_meta_data: JSON.stringify({}),
   })

   // Role `authenticated`, as in hosted Supabase: an anonymous user is signed in, just without
   // credentials. Policies tell them apart by the `is_anonymous` claim, not by role.
   //
   // Row and session are not one transaction — the seam left here. A failure issuing the session
   // strands an anonymous user with no credential to sign back in with, but closing it would mean
   // owning session creation rather than wrapping it.
   const session = await this.createSessionForUser(user, [], 'session')
   return { user: session.user, session }
}

/**
 * The user in its API response shape. `is_anonymous` was pinned to `false`, true enough while there
 * was no anonymous sign-in; it has to follow the row now for a client to tell the two apart.
 */
export function mapUserToResponse(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context: string,
): Record<string, unknown> {
   return { ...this.mapUserToResponseOriginal(user, identities, context), is_anonymous: isAnonymous(user.is_anonymous) }
}

/**
 * The session, with `is_anonymous` in the access token — the half that matters, since Supabase's
 * documented check is `auth.jwt() ->> 'is_anonymous'` in a policy, which a row-only flag never reaches.
 *
 * The original assembles the claims inline, so there is nothing to hook and the token is re-signed.
 * Its header is carried over rather than rebuilt, or anything the library adds later would be
 * dropped — a `kid` for key rotation, or the header another patch wrapping this method preserved.
 */
export async function createSessionForUser(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context?: string,
   options?: unknown,
): Promise<Session> {
   const promoted = await promoteIfClaimed(this, user, context)
   return withAnonymousClaim(
      await this.createSessionForUserOriginal(promoted, identities, context, options),
      promoted,
      this.config.jwt_secret,
   )
}

/**
 * A refreshed session. Two places mint an access token, each assembling the same claims inline, and
 * stamping only one gives a nasty bug: the first token says what the user is and no later one does.
 */
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
 * An anonymous user who has just proved an address is no longer anonymous.
 *
 * The documented way out of an anonymous account is `updateUser({ email })`, then verify — and most
 * of it already worked, because `completeVerifyOtp` predates anonymous users without knowing it. By
 * the time this runs it has applied the pending `email_change`, created or updated the email
 * identity, rebuilt `raw_app_meta_data`, and reloaded both the user and the identities.
 *
 * The flag this feature introduced is the one thing it cannot know to clear, so that is all this
 * does: a single write, nothing to make transactional.
 *
 * `user.email` rather than "email or phone" because the email change is the only conversion this
 * build carries — nothing in `completeVerifyOtp` ever assigns `phone`.
 *
 * Done at session creation rather than during verification because that is where the token is
 * minted: the row is promoted before the claims are read off it.
 */
async function promoteIfClaimed(service: AuthService, user: UserRow, context?: string): Promise<UserRow> {
   if (context !== 'verify' || !isAnonymous(user.is_anonymous) || !user.email) return user

   await service.repo.updateUser(user.id, { is_anonymous: false })
   return { ...user, is_anonymous: false }
}

/**
 * Re-signs the access token with `is_anonymous`, on every token rather than only anonymous ones.
 * Upstream's claim has no `omitempty`, and the difference matters: the documented policy
 * `(auth.jwt() ->> 'is_anonymous')::boolean is false` reads an absent claim as NULL, admitting nobody.
 */
async function withAnonymousClaim(session: Session, user: UserRow, secret: string): Promise<Session> {
   const [header, payload] = session.access_token.split('.')
   const claims = JSON.parse(fromBase64Url(payload))
   // Re-signed from the decoded claims, so `iat`, `exp` and `session_id` are the original's.
   return {
      ...session,
      access_token: await resign(header, { ...claims, is_anonymous: isAnonymous(user.is_anonymous) }, secret),
   }
}

function fromBase64Url(value: string): string {
   return atob(value.replace(/-/g, '+').replace(/_/g, '/'))
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
