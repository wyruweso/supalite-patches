interface Connection {
   exec(query: string, ...params: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>
}

interface HonoContext {
   req: { param(name: string): string; json(): Promise<unknown>; text(): Promise<string> }
   var: { authService: AuthService }
   get(key: string): unknown
   json(body: unknown, status?: number): Response
}

interface UserRow {
   id: string
   email?: string | null
   is_anonymous?: boolean | number
   [key: string]: unknown
}

interface AuthService {
   repo: {
      findUserById(id: string): Promise<UserRow | null>
      /** Runs `fn` against a repository bound to one transaction. */
      transaction<T>(fn: (repo: any) => Promise<T>): Promise<T>
   }
   /** Mints a token pair for an EXISTING session; wrapped in src/auth/session.ts to stamp the level. */
   createRefreshResponse(user: UserRow, sessionId: string, refreshToken: string, timestamp: unknown): Promise<unknown>
}

const connectionOf = (c: HonoContext) => (c.get('app') as { connection: Connection }).connection

/** The `/auth/v1` router. Its name is gone; the patcher recovers it from the mounting call. */
declare const authRoutes: {
   post(path: string, handler: (c: HonoContext) => Promise<Response>): unknown
} & { mfaRoutesRegistered?: boolean }

declare function original(...args: unknown[]): unknown

const STEP_SECONDS = 30
/** Clock skew allowance: neighbouring steps are accepted in both directions. */
const SKEW_STEPS = 1
const CHALLENGE_SECONDS = 300
/** Attempts are limited per challenge; this does not rate-limit new challenges. */
const MAX_ATTEMPTS = 5

/** Register the MFA routes before the original app builder mounts authRoutes. */
export function createApp(options: unknown, extra: unknown): unknown {
   registerMfaRoutes()
   return original(options, extra)
}

/** Adds `/factors` to the auth router, after `requireAuth()`, so `c.get('userId')` is known. */
function registerMfaRoutes(): void {
   if (authRoutes.mfaRoutesRegistered) return
   authRoutes.mfaRoutesRegistered = true

   /** Check the stored user so this guard also works without the anonymous sign-in patch. */
   const requireNotAnonymous = async (c: HonoContext): Promise<Response | UserRow> => {
      const user = await c.var.authService.repo.findUserById(c.get('userId') as string)
      if (!user) return notFound(c)
      if (user.is_anonymous === true || user.is_anonymous === 1) {
         // The middleware's own refusal, which is where upstream puts this check.
         return c.json(
            { code: 403, error_code: 'no_authorization', msg: 'Anonymous user not allowed to perform these actions' },
            403,
         )
      }
      return user
   }

   authRoutes.post('/factors', async (c) => {
      const user = await requireNotAnonymous(c)
      if (user instanceof Response) return user

      const insufficient = await requireMfaForAdditionalFactor(c, user.id)
      if (insufficient) return insufficient

      const body = await readBody(c)
      if (!body) return invalid(c, 'Could not parse the request body as JSON', 'bad_json')
      if (body.factor_type !== undefined && body.factor_type !== 'totp') {
         return invalid(c, 'Only totp is supported', 'validation_failed', 422)
      }
      for (const field of ['friendly_name', 'issuer'] as const) {
         if (body[field] !== undefined && typeof body[field] !== 'string') {
            return invalid(c, `${field} must be a string`, 'validation_failed')
         }
      }

      const connection = connectionOf(c)
      const id = crypto.randomUUID()
      const secret = randomBase32Secret()
      const friendlyName = (body.friendly_name as string | undefined) ?? 'TOTP'

      // Built before the insert: anything that throws while assembling it would otherwise leave a
      // factor behind, holding its name against the retry.
      const issuer = (body.issuer as string | undefined) ?? 'Supabase'
      const label = typeof user.email === 'string' && user.email ? user.email : user.id
      const uri =
         `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
         `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`

      // Enforce name uniqueness in the database while retaining the original spelling.
      const now = new Date().toISOString()
      try {
         await connection.exec(
            'INSERT INTO "auth.mfa_factors"' +
               ' (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)' +
               " VALUES (?, ?, ?, 'totp', 'unverified', ?, ?, ?)",
            id,
            user.id,
            friendlyName,
            secret,
            now,
            now,
         )
      } catch (error) {
         if (!isUniqueViolation(error)) throw error
         return c.json(
            {
               code: 422,
               error_code: 'mfa_factor_name_conflict',
               msg: `A factor with the friendly name ${friendlyName} for this user already exists`,
            },
            422,
         )
      }

      // Return the otpauth URI for client-side QR generation; qr_code requires an SVG encoder.
      return c.json({ id, type: 'totp', friendly_name: friendlyName, totp: { secret, uri } }, 200)
   })

   authRoutes.post('/factors/:factorId/challenge', async (c) => {
      const user = await requireNotAnonymous(c)
      if (user instanceof Response) return user

      const connection = connectionOf(c)
      const factor = await findFactor(connection, c.req.param('factorId'), user.id)
      if (!factor) return notFound(c)

      const id = crypto.randomUUID()
      const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS
      await connection.exec(
         'UPDATE "auth.mfa_factors" SET challenge_id = ?, challenge_expires_at = ?, challenge_attempts = 0 WHERE id = ?',
         id,
         String(expiresAt),
         factor.id,
      )

      return c.json({ id, type: 'totp', factor_id: factor.id, expires_at: expiresAt }, 200)
   })

   /** Consume the challenge and OTP step atomically, then elevate the existing session. */
   authRoutes.post('/factors/:factorId/verify', async (c) => {
      const user = await requireNotAnonymous(c)
      if (user instanceof Response) return user

      const connection = connectionOf(c)
      const factor = await findFactor(connection, c.req.param('factorId'), user.id)
      if (!factor) return notFound(c)

      // Existing factors establish AAL2 at sign-in; confirming an additional factor requires it.
      if (factor.status !== 'verified') {
         const insufficient = await requireMfaForAdditionalFactor(c, user.id)
         if (insufficient) return insufficient
      }

      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { code?: string; challenge_id?: string }

      if (!factor.challenge_id || body.challenge_id !== factor.challenge_id) {
         return c.json({ code: 404, error_code: 'mfa_challenge_not_found', msg: 'Challenge not found' }, 404)
      }
      if (Number(factor.challenge_expires_at ?? 0) < Math.floor(Date.now() / 1000)) {
         return c.json({ code: 422, error_code: 'mfa_challenge_expired', msg: 'Challenge has expired' }, 422)
      }

      const step = await matchedStep(String(factor.secret), String(body.code ?? ''))
      if (step === null) {
         await recordFailedAttempt(connection, factor.id, String(factor.challenge_id))
         return c.json({ code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422)
      }

      const sessionId = (c.get('jwt') as { session_id?: string })?.session_id
      if (!sessionId) return c.json({ code: 401, error_code: 'no_authorization', msg: 'No session' }, 401)

      // Consume the challenge, elevate this session, and record the method in one transaction.
      // Issue the token after commit.
      let consumed = true
      await c.var.authService.repo.transaction(async (tx) => {
         const now = new Date().toISOString()

         consumed = await consumeChallenge(tx, factor.id, String(factor.challenge_id), step, now)
         if (!consumed) return

         await tx.update('sessions').set({ aal: 'aal2', factor_id: factor.id }).where('id', '=', sessionId).execute()

         // Keep one history entry per authentication method and session.
         await tx
            .insertInto('mfa_amr_claims')
            .values({
               id: crypto.randomUUID(),
               session_id: sessionId,
               authentication_method: 'totp',
               created_at: now,
               updated_at: now,
            })
            .onConflict((conflict: any) =>
               conflict.columns(['session_id', 'authentication_method']).doUpdateSet({ updated_at: now }),
            )
            .execute()

         // Preserve sessions that already passed MFA; revoke the other AAL1 sessions.
         const others = (await tx
            .table('sessions')
            .select(['id', 'aal'])
            .where('user_id', '=', user.id)
            .where('id', '!=', sessionId)
            .execute()) as { id: string; aal?: string | null }[]
         const weaker = others.filter((session) => session.aal !== 'aal2').map((session) => session.id)

         if (weaker.length) {
            await tx.deleteFrom('refresh_tokens').where('session_id', 'in', weaker).execute()
            await tx.deleteFrom('sessions').where('id', 'in', weaker).execute()
         }
      })

      // Distinguish a consumed challenge from an OTP step that was already used.
      if (!consumed) {
         const current = await findFactor(connection, factor.id, user.id)
         return current?.challenge_id === factor.challenge_id
            ? c.json({ code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422)
            : c.json({ code: 404, error_code: 'mfa_challenge_not_found', msg: 'Challenge not found' }, 404)
      }

      // Use the existing refresh path to issue tokens carrying the updated session claims.
      const held = await connection.exec(
         'SELECT token FROM "auth.refresh_tokens" WHERE session_id = ? AND revoked = 0 ORDER BY created_at DESC LIMIT 1',
         sessionId,
      )
      const refreshToken = (held.rows ?? [])[0]?.token
      if (!refreshToken) return c.json({ code: 401, error_code: 'no_authorization', msg: 'No session' }, 401)

      return c.json(
         await c.var.authService.createRefreshResponse(user, sessionId, String(refreshToken), new Date().toISOString()),
         200,
      )
   })
}

/** The SQLite constraint error may be nested in the driver's cause chain. */
function isUniqueViolation(error: unknown): boolean {
   for (let at = error as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
      if (/UNIQUE constraint failed/i.test(String(at.message ?? at))) return true
   }
   return false
}

// 404 rather than 403: a stranger should not learn that a factor exists.
const notFound = (c: HonoContext) =>
   c.json({ code: 404, error_code: 'mfa_factor_not_found', msg: 'Factor not found' }, 404)

/** Adding a factor requires AAL2 when the account already has a verified factor. */
async function requireMfaForAdditionalFactor(c: HonoContext, userId: string): Promise<Response | null> {
   const connection = connectionOf(c)
   const verified = await connection.exec(
      `SELECT id FROM "auth.mfa_factors" WHERE user_id = ? AND status = 'verified' LIMIT 1`,
      userId,
   )
   if (!verified.rows?.length) return null

   const sessionId = (c.get('jwt') as { session_id?: string })?.session_id
   const session = sessionId
      ? ((await connection.exec('SELECT aal FROM "auth.sessions" WHERE id = ?', sessionId)).rows ?? [])[0]
      : undefined
   if (session?.aal === 'aal2') return null

   return c.json(
      {
         code: 403,
         error_code: 'insufficient_aal',
         msg: 'AAL2 required to add or verify a further factor while one is already verified',
      },
      403,
   )
}

/** Match both challenge id and unused time step so concurrent requests cannot consume either twice. */
async function consumeChallenge(
   tx: any,
   factorId: string,
   challengeId: string,
   step: number,
   now: string,
): Promise<boolean> {
   const result = await tx
      .update('mfa_factors')
      .set({
         status: 'verified',
         challenge_id: null,
         challenge_expires_at: null,
         challenge_attempts: 0,
         last_verified_step: step,
         updated_at: now,
      })
      .where('id', '=', factorId)
      .where('challenge_id', '=', challengeId)
      // Defaulted to 0 rather than nullable, so this one comparison is the whole guard.
      .where('last_verified_step', '<', step)
      .execute()

   return updatedRows(result) > 0
}

/** The driver answers an update with an array of results, one per statement. */
function updatedRows(result: unknown): number {
   const first = Array.isArray(result) ? result[0] : result
   return Number((first as { numUpdatedRows?: unknown })?.numUpdatedRows ?? 0)
}

/** Increment in SQL to preserve concurrent attempts. Invalidate only the exhausted challenge. */
async function recordFailedAttempt(connection: Connection, factorId: string, challengeId: string): Promise<void> {
   await connection.exec(
      'UPDATE "auth.mfa_factors" SET challenge_attempts = challenge_attempts + 1' +
         ' WHERE id = ? AND challenge_id = ?',
      factorId,
      challengeId,
   )
   await connection.exec(
      'UPDATE "auth.mfa_factors" SET challenge_id = NULL, challenge_expires_at = NULL, challenge_attempts = 0' +
         ' WHERE id = ? AND challenge_id = ? AND challenge_attempts >= ?',
      factorId,
      challengeId,
      MAX_ATTEMPTS,
   )
}

/** Read text to distinguish an absent body ({}) from malformed or non-object JSON (null). */
async function readBody(c: HonoContext): Promise<Record<string, unknown> | null> {
   const text = (await c.req.text().catch(() => '')).trim()
   if (!text) return {}
   try {
      const raw: unknown = JSON.parse(text)
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
      return raw as Record<string, unknown>
   } catch {
      return null
   }
}

const invalid = (c: HonoContext, msg: string, code: string, status = 400) =>
   c.json({ code: status, error_code: code, msg }, status)

async function findFactor(connection: Connection, id: string, userId: string) {
   const result = await connection.exec('SELECT * FROM "auth.mfa_factors" WHERE id = ? AND user_id = ?', id, userId)
   return (result.rows ?? [])[0] ?? null
}

// TOTP (RFC 6238), with dynamic truncation from RFC 4226.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** 160 bits, as the RFC advises, in the alphabet authenticator apps expect. */
function randomBase32Secret(): string {
   const bytes = crypto.getRandomValues(new Uint8Array(20))
   let bits = ''
   for (const byte of bytes) bits += byte.toString(2).padStart(8, '0')
   let secret = ''
   for (let i = 0; i + 5 <= bits.length; i += 5) secret += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)]
   return secret
}

function base32ToBytes(secret: string): Uint8Array {
   let bits = ''
   for (const char of secret.toUpperCase().replace(/=+$/, '')) {
      const index = BASE32_ALPHABET.indexOf(char)
      if (index < 0) continue
      bits += index.toString(2).padStart(5, '0')
   }
   const bytes = new Uint8Array(Math.floor(bits.length / 8))
   for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2)
   return bytes
}

async function codeForStep(secret: string, step: number): Promise<string> {
   const counter = new Uint8Array(8)
   let rest = step
   for (let i = 7; i >= 0; i--) {
      counter[i] = rest & 0xff
      rest = Math.floor(rest / 256)
   }

   const key = await crypto.subtle.importKey('raw', base32ToBytes(secret), { name: 'HMAC', hash: 'SHA-1' }, false, [
      'sign',
   ])
   const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter))

   const offset = mac[mac.length - 1] & 0x0f
   const binary =
      ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff)
   return String(binary % 1000000).padStart(6, '0')
}

/** Return the matching step within the clock-skew window so verification can reject its reuse. */
async function matchedStep(secret: string, code: string): Promise<number | null> {
   const cleaned = code.replace(/\s+/g, '')
   if (!/^\d{6}$/.test(cleaned)) return null

   const current = Math.floor(Date.now() / 1000 / STEP_SECONDS)
   for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset++) {
      if ((await codeForStep(secret, current + offset)) === cleaned) return current + offset
   }
   return null
}
