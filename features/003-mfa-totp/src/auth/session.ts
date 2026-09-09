// supabase-js reads factors from the user object and aal/amr from the access token.
// Kept separate from routes because each splice carries its source file's helpers and bindings.

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

/** Record the authentication method supplied by the original sign-in flow. */
export async function createSessionForUser(
   this: AuthService,
   user: UserRow,
   identities: unknown[],
   context?: string,
   options?: SessionOptions,
): Promise<Session> {
   const session = await this.createSessionForUserOriginal(user, identities, context, options)
   // The original session and its method history are separate writes.
   await recordMethod(this, claimsOf(session.access_token).session_id as string, methodOf(user, options))
   return withSessionFactors(this, user.id, await withAssuranceLevel(session, this))
}

/** Read assurance level and method history from the session so they survive token refresh. */
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

/** Use the authentication method or OAuth provider supplied by the library. */
function methodOf(user: UserRow, options?: SessionOptions): string {
   if (options?.authenticationMethod) return options.authenticationMethod
   if (options?.provider) return 'oauth'
   return user.is_anonymous === true || user.is_anonymous === 1 ? 'anonymous' : 'password'
}

/** Keep one history row per method and session, updating its last verification time. */
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

/** A missing factors table means no enrollment; propagate other query errors. */
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

   // Mutate the session to preserve non-enumerable session_id/user_id response metadata.
   session.user = await withFactors(service, userId, session.user)
   return session
}

/** Include aal on every token; read it and amr from the persisted session. */
async function withAssuranceLevel(session: Session, service: AuthService): Promise<Session> {
   if (!session?.access_token) return session

   const claims = claimsOf(session.access_token)
   const row = await service.repo.table('sessions').select('aal').where('id', '=', claims.session_id).executeTakeFirst()

   const stamped: Record<string, unknown> = { ...claims, aal: String(row?.aal ?? 'aal1') }
   const amr = await methodsOf(service, claims.session_id as string)
   if (amr.length) stamped.amr = amr

   // Preserve the original session object and its non-enumerable metadata.
   session.access_token = await resign(session.access_token, stamped, service.config.jwt_secret)
   return session
}

async function methodsOf(service: AuthService, sessionId: string): Promise<{ method: string; timestamp: number }[]> {
   if (!sessionId) return []
   try {
      // Use updated_at: re-verification updates an existing method row.
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

/** Inspect the cause chain because the driver may wrap the SQLite error. */
function isMissingTable(error: unknown): boolean {
   for (let at = error as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
      if (/no such table/i.test(String(at.message ?? at))) return true
   }
   return false
}

/** Decode UTF-8 before parsing the token payload. */
function claimsOf(token: string): Record<string, unknown> {
   const [, payload] = token.split('.')
   const binary = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
   return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))))
}

function toBase64Url(bytes: Uint8Array): string {
   let binary = ''
   for (const byte of bytes) binary += String.fromCharCode(byte)
   return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Preserve the original JWT header, including any key id. */
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
