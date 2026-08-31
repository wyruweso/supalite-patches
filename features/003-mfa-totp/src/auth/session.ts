// Where MFA shows up in the rest of the API.
//
// supabase-js has no GET /factors: `mfa.listFactors()` reads `user.factors` out of getUser(), and
// `getAuthenticatorAssuranceLevel()` pairs that with the `aal` and `amr` claims in the token. All
// three go where the SDK looks for them — an invented route would be unreachable from it.
//
// Separate from the routes file because the patcher carries a file's other top-level declarations
// into whichever function it splices, and that file's `createApp` names an original only its own
// wrapper defines.

interface UserRow {
   id: string
   is_anonymous?: boolean | number
   [key: string]: unknown
}

interface Session {
   access_token: string
   user?: Record<string, unknown>
   [key: string]: unknown
}

interface SessionOptions {
   /** The library's own name for how the session was established: `otp` or `password`. */
   authenticationMethod?: string
   /** Set on the OAuth path, where it names the provider. */
   provider?: string
}

interface AuthService {
   config: { jwt_secret: string }
   repo: {
      /** kysely, already bound to the auth schema. */
      table(name: string): any
      insertInto(name: string): any
   }

   getUserOriginal(userId: string): Promise<Record<string, unknown>>
   createSessionForUserOriginal(
      user: UserRow,
      identities: unknown[],
      context?: string,
      options?: SessionOptions,
   ): Promise<Session>
   createRefreshResponseOriginal(
      user: UserRow,
      sessionId: string,
      refreshToken: string,
      timestamp: unknown,
   ): Promise<Session>
}

/** `GET /auth/v1/user`, with the user's factors attached. */
export async function getUser(this: AuthService, userId: string): Promise<Record<string, unknown>> {
   return withFactors(this, userId, await this.getUserOriginal(userId))
}

/**
 * A new session: the factors on its user, and the assurance level and method history in its token.
 *
 * The method is recorded here because this is the only place that knows it, and it is not guessed —
 * the library computes it for its own use and hands it over in the options. OAuth names its provider
 * there instead, an anonymous sign-in is visible on the row, and the rest default to `password`.
 */
export async function createSessionForUser(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context?: string,
   options?: SessionOptions,
): Promise<Session> {
   const session = await this.createSessionForUserOriginal(user, identities, context, options)
   await recordMethod(this, claimsOf(session.access_token).session_id as string, methodOf(user, options))
   return withSessionFactors(this, user.id, await withAssuranceLevel(session, this))
}

/**
 * A refreshed session — an ordinary refresh, and also the token pair the verify route hands back.
 *
 * Level and method history are read from the database, not carried in the request: both are facts
 * about the session, not one token. Stamping only the other minting path would give a token that
 * quietly drops back to aal1 an hour in.
 */
export async function createRefreshResponse(
   this: AuthService,
   user: UserRow,
   sessionId: string,
   refreshToken: string,
   timestamp: unknown,
): Promise<Session> {
   const session = await this.createRefreshResponseOriginal(user, sessionId, refreshToken, timestamp)
   return withSessionFactors(this, user.id, await withAssuranceLevel(session, this))
}

/**
 * How the session was established, from what the library itself knows.
 *
 * Recorded after the original created the session — the last seam here: a failure writing the method
 * answers the sign-in with an error while the session exists. The table is part of the schema now,
 * so the realistic failures are gone, but closing the seam would mean owning session creation.
 */
function methodOf(user: UserRow, options?: SessionOptions): string {
   if (options?.authenticationMethod) return options.authenticationMethod
   if (options?.provider) return 'oauth'
   return user.is_anonymous === true || user.is_anonymous === 1 ? 'anonymous' : 'password'
}

/**
 * Appends one authentication method to a session's history.
 *
 * Upstream keeps one row per method per session in `auth.mfa_amr_claims`, and verifying a factor adds
 * to that rather than replacing it. After a password sign-in and a TOTP verification the session was
 * authenticated by both, so overwriting would tell the caller they never entered a password.
 */
async function recordMethod(service: AuthService, sessionId: string, method: string): Promise<void> {
   if (!sessionId) return

   const now = new Date().toISOString()
   await service.repo
      .insertInto('mfa_amr_claims')
      .values({
         id: crypto.randomUUID(),
         session_id: sessionId,
         authentication_method: method,
         created_at: now,
         updated_at: now,
      })
      // Once per method per session, as upstream's constraint says.
      .onConflict((conflict: any) =>
         conflict.columns(['session_id', 'authentication_method']).doUpdateSet({ updated_at: now }),
      )
      .execute()
}

/**
 * The user's factors, in the shape supabase-js expects on the user object. A missing table means
 * nobody has enrolled here, which is not an error — but only that one error is swallowed: reporting
 * a broken query as "this user has no second factor" is the wrong answer to give about MFA.
 */
async function factorsOf(service: AuthService, userId: string): Promise<Record<string, unknown>[]> {
   try {
      return await service.repo
         .table('mfa_factors')
         .select(['id', 'friendly_name', 'factor_type', 'status', 'created_at', 'updated_at'])
         .where('user_id', '=', userId)
         .orderBy('created_at')
         .execute()
   } catch (error) {
      if (isMissingTable(error)) return []
      throw error
   }
}

async function withFactors(
   service: AuthService,
   userId: string,
   user: Record<string, unknown>,
): Promise<Record<string, unknown>> {
   const factors = await factorsOf(service, userId)
   return factors.length ? { ...user, factors } : user
}

async function withSessionFactors(service: AuthService, userId: string, session: Session): Promise<Session> {
   if (!session?.user) return session
   return { ...session, user: await withFactors(service, userId, session.user) }
}

/**
 * Stamps the token with the assurance level and method history recorded for its session.
 *
 * `aal` goes on every token, as upstream does: `getAuthenticatorAssuranceLevel()` reads it straight
 * out of the JWT, where a missing claim means "unknown" rather than "aal1".
 *
 * The session row is not optional, so that read is unguarded — failing to read it is a fault, not an
 * assurance level of one. The method history is younger than some sessions, so a missing table there
 * means no history.
 */
async function withAssuranceLevel(session: Session, service: AuthService): Promise<Session> {
   if (!session?.access_token) return session

   const claims = claimsOf(session.access_token)
   const row = await service.repo.table('sessions').select('aal').where('id', '=', claims.session_id).executeTakeFirst()

   const stamped: Record<string, unknown> = { ...claims, aal: String(row?.aal ?? 'aal1') }
   const amr = await methodsOf(service, claims.session_id as string)
   if (amr.length) stamped.amr = amr

   return { ...session, access_token: await resign(session.access_token, stamped, service.config.jwt_secret) }
}

async function methodsOf(service: AuthService, sessionId: string): Promise<{ method: string; timestamp: number }[]> {
   if (!sessionId) return []
   try {
      // Most recent first, the order Supabase documents: a policy reading `amr[0]` asks what the
      // caller did last. By `updated_at`, since re-verifying a factor touches only that column.
      const rows = await service.repo
         .table('mfa_amr_claims')
         .select(['authentication_method', 'updated_at'])
         .where('session_id', '=', sessionId)
         .orderBy('updated_at', 'desc')
         .execute()
      return rows.map((row: { authentication_method: string; updated_at: string }) => ({
         method: row.authentication_method,
         timestamp: Math.floor(Date.parse(row.updated_at) / 1000),
      }))
   } catch (error) {
      if (isMissingTable(error)) return []
      throw error
   }
}

/**
 * Whether a query failed because its table is not there yet. The cause chain matters: the driver
 * wraps the SQLite error, so the outer message reads "Failed to prepare statement: …" and only the
 * cause says "no such table". Testing the outer one alone treats a missing table as a fault.
 */
function isMissingTable(error: unknown): boolean {
   for (let at = error as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
      if (/no such table/i.test(String(at.message ?? at))) return true
   }
   return false
}

function claimsOf(token: string): Record<string, unknown> {
   const [, payload] = token.split('.')
   return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
}

function toBase64Url(bytes: Uint8Array): string {
   let binary = ''
   for (const byte of bytes) binary += String.fromCharCode(byte)
   return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Re-signs a token with new claims, keeping its original header — rebuilding it would quietly drop
 * anything the library adds later, a `kid` for key rotation being the obvious one.
 */
async function resign(token: string, claims: Record<string, unknown>, secret: string): Promise<string> {
   const encoder = new TextEncoder()
   const [header] = token.split('.')
   const signingInput = `${header}.${toBase64Url(encoder.encode(JSON.stringify(claims)))}`

   const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
   ])
   const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput))
   return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`
}
