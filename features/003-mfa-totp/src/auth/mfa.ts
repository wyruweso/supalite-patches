interface Connection {
   exec(query: string, ...params: unknown[]): Promise<{ rows?: Record<string, unknown>[] }>
}

interface HonoContext {
   req: { param(name: string): string; json(): Promise<unknown> }
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
/**
 * Wrong codes allowed against one challenge before it is spent. Per-challenge hygiene, not a
 * brute-force control: nothing stops the caller raising a fresh challenge, and upstream rate-limits
 * the routes themselves, which is the control this does not have.
 */
const MAX_ATTEMPTS = 5

/**
 * Builds the app and mounts the routers.
 *
 * FEATURES.md marks MFA/TOTP planned, suggesting otplib. No library was needed: TOTP is an HMAC-SHA1
 * of a time step, and `crypto.subtle` exists in every runtime this package targets.
 *
 * What this covers, and what it does not:
 *
 *   enroll / challenge / verify        yes
 *   factors on the user object         yes — that is where supabase-js reads them from
 *   session elevated to aal2           yes, and the claim survives a refresh
 *   other sessions ended on verify     yes
 *   anonymous users refused            yes
 *   `qr_code`                          NO — see the enrol route
 *   unenroll, phone factors            no
 *   one challenge per factor           a simplification; upstream stores challenges separately
 *   the secret at rest                 plaintext in the local SQLite file; GoTrue can encrypt it
 */
export function createApp(options: unknown, extra: unknown): unknown {
   registerMfaRoutes()
   return original(options, extra)
}

/** Adds `/factors` to the auth router, after `requireAuth()`, so `c.get('userId')` is known. */
function registerMfaRoutes(): void {
   if (authRoutes.mfaRoutesRegistered) return
   authRoutes.mfaRoutesRegistered = true

   /**
    * An anonymous user may not enrol a second factor — there is no first one to add it to, and
    * upstream guards every one of these routes. The check reads the row rather than the token, so it
    * holds whether or not the anonymous sign-in patch is applied.
    */
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

      // A password-only session must not be able to add a factor to an account that already has one:
      // it could then verify a factor of its own making and reach aal2 without the existing one ever
      // being used. Upstream requires aal2 here for the same reason.
      const insufficient = await refuseUnlessAssured(c, user.id, null)
      if (insufficient) return insufficient

      const body = ((await c.req.json().catch(() => ({}))) ?? {}) as {
         factor_type?: string
         friendly_name?: string
         issuer?: string
      }
      if (body.factor_type && body.factor_type !== 'totp') {
         return c.json({ code: 422, error_code: 'validation_failed', msg: 'Only totp is supported' }, 422)
      }

      const connection = connectionOf(c)
      const id = crypto.randomUUID()
      const secret = randomBase32Secret()
      const friendlyName = body.friendly_name ?? 'TOTP'

      // The unique index carries the rule, the only place free of a race between asking and
      // inserting. It matches on an expression, so the name is stored as written.
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

      // The authenticator app shows `issuer` as the provider and the label as the identity within
      // it. The friendly name names the factor, not the account, so it is not the label. supabase-js
      // passes the issuer through from enroll().
      const issuer = body.issuer ?? 'Supabase'
      const label = typeof user.email === 'string' && user.email ? user.email : user.id
      const uri =
         `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
         `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`

      // No `qr_code`. GoTrue returns an SVG there, which would mean writing a QR encoder — a patch
      // is spliced into an already-built bundle and cannot pull in a dependency. Better absent than
      // wrong: a client doing `img.src = 'data:image/svg+xml,' + qr_code` fails silently on a URI.
      // The `uri` is here, and every QR library renders it in one call.
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

   /**
    * Verifying a factor, which raises the caller's own session.
    *
    * The invariants, each held by one thing rather than by the shape of the code:
    *
    *   a further factor needs the existing one   refuseUnlessAssured, on auth.sessions.aal
    *   one challenge, one verification           the challenge id is in the UPDATE's WHERE
    *   one OTP, one use                          so is the time step it was computed for
    *   sessions that passed MFA survive          only sessions below aal2 are ended
    *
    * The checks that answer with a status — an unknown factor, an expired challenge, a wrong code —
    * are outside the transaction, so a wrong answer there costs nothing. Everything that changes
    * state is inside it, and the token is minted after the commit.
    */
   authRoutes.post('/factors/:factorId/verify', async (c) => {
      const user = await requireNotAnonymous(c)
      if (user instanceof Response) return user

      const connection = connectionOf(c)
      const factor = await findFactor(connection, c.req.param('factorId'), user.id)
      if (!factor) return notFound(c)

      // Verifying a factor while a DIFFERENT one is already verified is the same escalation as
      // enrolling: it must come from a session that has already passed the existing factor. The
      // ordinary step-up login — one verified factor, proving it from an aal1 session — is untouched,
      // and so is re-verifying this same factor.
      const insufficient = await refuseUnlessAssured(c, user.id, factor.id)
      if (insufficient) return insufficient

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

      // The caller's own session is elevated rather than a new one issued. `auth.sessions` already
      // carries `aal` and `factor_id`, so the level lives in the database and every later token for
      // this session is minted at it. A fresh session would change `session_id` under the caller and
      // terminate the very token they are making this request with.
      //
      // Everything that changes state is in one transaction, and the challenge is consumed by the
      // first statement in it — matched on its id and on the time step, so two requests carrying the
      // same challenge or the same code cannot both succeed. The token is minted after the commit,
      // where a failure is harmless.
      let consumed = true
      await c.var.authService.repo.transaction(async (tx) => {
         const now = new Date().toISOString()

         consumed = await consumeChallenge(tx, factor.id, String(factor.challenge_id), step, now)
         if (!consumed) return

         await tx.update('sessions').set({ aal: 'aal2', factor_id: factor.id }).where('id', '=', sessionId).execute()

         // Appended, not replaced: `amr` is the history of both the password and this factor. Once
         // per session, or re-verifying would read ['password', 'totp', 'totp'].
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

         // The user's weaker sessions end here: established at aal1, they would let an older token
         // walk around the second factor. A session that has already passed MFA is left alone —
         // ending it would log the user's other devices out for authenticating properly.
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

      // Nothing was consumed: another request had this challenge, or this code was already used for
      // its time step. Which one is a question for the row, asked once, outside the transaction.
      if (!consumed) {
         const current = await findFactor(connection, factor.id, user.id)
         return current?.challenge_id === factor.challenge_id
            ? c.json({ code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }, 422)
            : c.json({ code: 404, error_code: 'mfa_challenge_not_found', msg: 'Challenge not found' }, 404)
      }

      // A fresh pair for that same session, through the library's refresh path, so the wrapper in
      // src/auth/session.ts stamps it from the row just raised to aal2.
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

/**
 * A unique-index violation, from anywhere in the cause chain: the driver wraps the SQLite error, so
 * the outer message says only "Failed to prepare statement".
 */
function isUniqueViolation(error: unknown): boolean {
   for (let at = error as { message?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) {
      if (/UNIQUE constraint failed/i.test(String(at.message ?? at))) return true
   }
   return false
}

// 404 rather than 403: a stranger should not learn that a factor exists.
const notFound = (c: HonoContext) =>
   c.json({ code: 404, error_code: 'mfa_factor_not_found', msg: 'Factor not found' }, 404)

/**
 * Refuses unless the caller's session has already passed MFA, when the account has a verified factor
 * other than `exceptFactorId`. Read from `auth.sessions`, not from the token: the level is a fact
 * about the session, and a token minted before this feature existed carries no claim at all.
 *
 * `null` when the request may proceed.
 */
async function refuseUnlessAssured(
   c: HonoContext,
   userId: string,
   exceptFactorId: string | null,
): Promise<Response | null> {
   const connection = connectionOf(c)
   const verified = await connection.exec(
      `SELECT id FROM "auth.mfa_factors" WHERE user_id = ? AND status = 'verified'`,
      userId,
   )
   const others = (verified.rows ?? []).filter((row) => row.id !== exceptFactorId)
   if (others.length === 0) return null

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

/**
 * Marks the factor verified and spends both the challenge and the time step, in one statement.
 *
 * The row is matched on the challenge it still holds and on a step it has not accepted before, so of
 * two requests carrying the same challenge — or the same code through two challenges — exactly one
 * updates a row. `false` means somebody else got there first.
 */
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

/**
 * Counts a wrong code against the challenge it was offered for, in SQL rather than by reading and
 * writing back — concurrent attempts would otherwise all store the same 1. The challenge is spent
 * once the count reaches the limit; the factor is left alone, since a wrong code is usually a typo
 * or a drifted clock and locking a factor needs an unlock route this feature does not have.
 */
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

async function findFactor(connection: Connection, id: string, userId: string) {
   const result = await connection.exec('SELECT * FROM "auth.mfa_factors" WHERE id = ? AND user_id = ?', id, userId)
   return (result.rows ?? [])[0] ?? null
}


// --- TOTP ----------------------------------------------------------------------------------------
//
// RFC 6238 in thirty lines: the code is an HMAC-SHA1 of the time step, truncated by the RFC 4226 rule.

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

/**
 * Neighbouring steps are accepted too: clocks drift between a code being read off a phone and
 * reaching the server, and without the allowance a user near a boundary could never sign in.
 */
/**
 * The time step this code is the OTP for, or null. The step rather than a boolean, because an OTP has
 * to be usable once and the step is what identifies it.
 */
async function matchedStep(secret: string, code: string): Promise<number | null> {
   const cleaned = code.replace(/\s+/g, '')
   if (!/^\d{6}$/.test(cleaned)) return null

   const current = Math.floor(Date.now() / 1000 / STEP_SECONDS)
   for (let offset = -SKEW_STEPS; offset <= SKEW_STEPS; offset++) {
      if ((await codeForStep(secret, current + offset)) === cleaned) return current + offset
   }
   return null
}
