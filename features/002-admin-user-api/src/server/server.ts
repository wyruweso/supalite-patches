interface HonoContext {
   req: {
      param(name: string): string
      query(name: string): string | undefined
      text(): Promise<string>
   }
   var: { authService: AuthService }
   get(key: string): unknown
   json(body: unknown, status?: number, headers?: Record<string, string>): Response
}

interface UserRow {
   id: string
   email: string | null
   [key: string]: unknown
}

interface Repo {
   table(name: string): any
   update(name: string): any
   deleteFrom(name: string): any
   findUserById(id: string): Promise<UserRow | null>
   findUserByEmail(email: string): Promise<UserRow | null>
   createUser(user: Partial<UserRow> & { id: string; email: string | null }): Promise<UserRow>
   createIdentity(identity: {
      id: string
      provider: string
      provider_id: string
      user_id: string
      identity_data: Record<string, unknown>
   }): Promise<unknown>
   findIdentitiesByUserId(userId: string): Promise<unknown[]>
   parseUserJson(user: UserRow): UserRow
   transaction<T>(fn: (repo: Repo) => Promise<T>): Promise<T>
}

interface AuthService {
   config: { minimum_password_length?: number }
   repo: Repo
   mapUserToResponse(user: UserRow, identities: unknown[], context: string): Record<string, unknown>
   /** The library's own password path: bcrypt hashing and the configured strength rules. */
   updateUser(id: string, updates: { password?: string }): Promise<unknown>
   assertPasswordStrong(password: string): void
}

/** The `/auth/v1` router. Its name is gone; the patcher recovers it from the mounting call. */
declare const authRoutes: {
   get(path: string, handler: (c: HonoContext) => Promise<Response>): unknown
   post(path: string, handler: (c: HonoContext) => Promise<Response>): unknown
   delete(path: string, handler: (c: HonoContext) => Promise<Response>): unknown
} & { adminRoutesRegistered?: boolean }

declare function original(...args: unknown[]): unknown

/** A bcrypt digest: prefix, two-digit cost, 22 characters of salt and 31 of hash — 60 in total. */
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Builds the app and mounts the routers. The admin routes go on before the original mounts
 * `authRoutes` — Hono copies a sub-app's routes at mount time, so anything later would be missed.
 */
export function createApp(options: unknown, extra: unknown): unknown {
   registerAdminRoutes()
   return original(options, extra)
}

/**
 * Adds `/admin/users` to the auth router: list, read, create and delete.
 *
 * `requireAuth()` is already in the chain, so an unauthenticated request never reaches these routes.
 * The role is checked in each handler: only `service_role` may administer.
 *
 * Deliberately not covered: `PUT /admin/users/:id`, `ban_duration`, the MFA admin routes and
 * `generate_link`.
 */
function registerAdminRoutes(): void {
   // The app may be built more than once per process, but the router is a module singleton.
   if (authRoutes.adminRoutesRegistered) return
   authRoutes.adminRoutesRegistered = true

   authRoutes.get('/admin/users', listUsers)
   authRoutes.get('/admin/users/:id', readUser)
   authRoutes.post('/admin/users', createUser)
   authRoutes.delete('/admin/users/:id', deleteUser)
}

// The line GoTrue draws: 403 for the wrong role, 404 for an unknown user, 400 for a malformed
// request, 422 for one understood but refused.
const forbidden = (c: HonoContext) => c.json({ code: 403, error_code: 'not_admin', msg: 'User not allowed' }, 403)
const notFound = (c: HonoContext) => c.json({ code: 404, error_code: 'user_not_found', msg: 'User not found' }, 404)
const invalid = (c: HonoContext, msg: string, code = 'validation_failed', status = 400) =>
   c.json({ code: status, error_code: code, msg }, status)
const refused = (c: HonoContext, msg: string, code: string) => invalid(c, msg, code, 422)
const isAdmin = (c: HonoContext) => (c.get('jwt') as { role?: string } | undefined)?.role === 'service_role'

/**
 * Identities are part of the response supabase-js types, so they are loaded rather than passed empty
 * — which made every admin response claim the user had none.
 */
async function toAdminUserResponse(c: HonoContext, user: UserRow): Promise<Record<string, unknown>> {
   const { authService } = c.var
   const identities = await authService.repo.findIdentitiesByUserId(user.id)
   return authService.mapUserToResponse(authService.repo.parseUserJson(user), identities, 'user')
}

/**
 * `{}` for an absent body, `null` for anything that is not a JSON object. GoTrue reports a missing
 * field and bad JSON differently, while `c.req.json()` throws the same way for both — and a body of
 * `[]` or `"x"` parses without being the record every field is then read off.
 */
async function readBody(c: HonoContext): Promise<Record<string, unknown> | null> {
   const text = (await c.req.text()).trim()
   if (!text) return {}
   try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed as Record<string, unknown>
   } catch {
      return null
   }
}

/**
 * GoTrue numbers pages from one, 50 per page by default. A page has to be a whole number: `Number()`
 * accepts `1.5` and `Infinity`, and an `OFFSET` of either is a database error rather than a refusal.
 */
function parsePagination(c: HonoContext): { page: number; perPage: number } | { msg: string } {
   const whole = (raw: string | undefined, fallback: number, max: number, name: string) => {
      if (raw === undefined || raw === '') return fallback
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value < 1) return { msg: `Invalid ${name}: ${raw}` }
      return Math.min(max, value)
   }

   const page = whole(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER, 'page')
   if (typeof page === 'object') return page
   const perPage = whole(c.req.query('per_page'), 50, 1000, 'per_page')
   if (typeof perPage === 'object') return perPage
   return { page, perPage }
}

/**
 * `should_soft_delete`, read strictly. Absent means a hard delete, as supabase-js and GoTrue default
 * it — but `"true"` is not `true`, and answering a request whose flag was mistyped by irreversibly
 * removing the user is the worst way to be lenient.
 */
function parseDeleteInput(body: Record<string, unknown>): { soft: boolean } | { msg: string } {
   const flag = body.should_soft_delete
   if (flag === undefined || flag === null) return { soft: false }
   if (typeof flag !== 'boolean') return { msg: 'should_soft_delete must be a boolean' }
   return { soft: flag }
}

async function listUsers(c: HonoContext): Promise<Response> {
   if (!isAdmin(c)) return forbidden(c)

   const paging = parsePagination(c)
   if ('msg' in paging) return invalid(c, paging.msg)
   const { page, perPage } = paging

   const { repo } = c.var.authService
   const counted = await repo
      .table('users')
      .select((eb: any) => eb.fn.countAll().as('count'))
      .executeTakeFirst()
   const total = Number(counted?.count ?? 0)

   const rows: UserRow[] = await repo
      .table('users')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(perPage)
      .offset((page - 1) * perPage)
      .execute()

   // supabase-js reads pagination from the headers, not the body: `total` from X-Total-Count,
   // `nextPage` and `lastPage` from Link. Without them the caller sees no pagination at all.
   return c.json(
      { users: await Promise.all(rows.map((row) => toAdminUserResponse(c, row))), aud: 'authenticated' },
      200,
      { 'X-Total-Count': String(total), Link: paginationLinks(page, perPage, total) },
   )
}

async function readUser(c: HonoContext): Promise<Response> {
   if (!isAdmin(c)) return forbidden(c)
   const user = await c.var.authService.repo.findUserById(c.req.param('id'))
   return user ? c.json(await toAdminUserResponse(c, user), 200) : notFound(c)
}

/**
 * Creating a user as an administrator — not the public sign-up path, which is the point of the route.
 * It works on an instance with sign-ups off, takes an address or a phone number with the password
 * optional, accepts a chosen id, role and metadata, and can mark either identifier confirmed. No
 * session is issued: the user is created, not signed in.
 */
async function createUser(c: HonoContext): Promise<Response> {
   if (!isAdmin(c)) return forbidden(c)

   const body = await readBody(c)
   if (!body) return invalid(c, 'Could not parse the request body as JSON', 'bad_json', 400)

   const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
   const phone = typeof body.phone === 'string' ? body.phone.trim() : undefined
   if (!email && !phone) return invalid(c, 'An email address or a phone number is required')
   if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) return invalid(c, `Unable to validate email address: ${email}`)
   if (phone && !/^\+?[0-9]{5,20}$/.test(phone)) return invalid(c, `Invalid phone number: ${phone}`)

   // Whether a password was offered and what it amounts to are separate questions that differ on the
   // empty string, so — like GoTrue — they are asked separately.
   const passwordProvided = typeof body.password === 'string'
   const requested = passwordProvided ? (body.password as string) : undefined
   // An empty `password_hash` counts as absent: treating it as present would store an empty
   // `encrypted_password` and skip the random password meant to prevent exactly that.
   const hashProvided = typeof body.password_hash === 'string' && body.password_hash !== ''
   const passwordHash = hashProvided ? (body.password_hash as string) : undefined

   // Both would mean the plaintext one overwriting the hash a moment later — a migration losing the
   // very thing it was moving. The conflict is in the fields sent, not their values.
   if (passwordProvided && hashProvided) {
      return invalid(c, 'Only a password or a password_hash should be provided')
   }
   // Validated before the row exists, because nothing downstream checks again: bcrypt's compare
   // simply answers "no" to a malformed digest, so an unvalidated hash creates a user who can never
   // sign in and is never told why. bcrypt only: upstream also takes Firebase scrypt.
   if (hashProvided && !BCRYPT_HASH.test(passwordHash as string)) {
      return invalid(c, 'password_hash must be a bcrypt hash ($2a$, $2b$ or $2y$)')
   }

   // From here a blank password is no password rather than a weak one, and neither given means a
   // random one, as in GoTrue, so the empty string is never itself a working credential.
   const chosen = requested ? requested : undefined
   const password = chosen ?? (hashProvided ? undefined : randomPassword(c.var.authService.config))

   // Every password that will be stored is checked here, the generated one included: hashing happens
   // after the row is written, so a refusal there would leave a user with no way in and an address
   // that now answers `email_exists`. A generator shorter than a configured minimum did exactly that.
   if (password !== undefined) c.var.authService.assertPasswordStrong(password)

   const id = body.id === undefined ? crypto.randomUUID() : String(body.id)
   // A chosen id must be a UUID and not the nil one: the column's CHECK would otherwise fail as a
   // database error, and `sub` in a token is expected to name somebody.
   if (!UUID.test(id)) return invalid(c, `Invalid user ID: ${id}`)
   if (id === NIL_UUID) return invalid(c, 'Invalid user ID: nil UUID')

   const { repo } = c.var.authService
   if (email && (await repo.findUserByEmail(email))) {
      return refused(c, 'A user with this email address has already been registered', 'email_exists')
   }
   if (phone && (await repo.table('users').select('id').where('phone', '=', phone).executeTakeFirst())) {
      return refused(c, 'A user with this phone number has already been registered', 'phone_exists')
   }
   if (await repo.findUserById(id)) return refused(c, 'A user with this ID has already been registered', 'user_exists')

   const now = new Date().toISOString()
   // Defaulted from the identities being created, then the caller's `app_metadata` applied over them
   // — GoTrue's order, so a caller who names the provider fields wins.
   const providers = [...(email ? ['email'] : []), ...(phone ? ['phone'] : [])]
   const appMetadata = {
      provider: providers[0],
      providers,
      ...((body.app_metadata as Record<string, unknown>) ?? {}),
   }

   // One identity per provider, each carrying only its own identifier: an email identity that also
   // recorded a phone number would claim the account is reachable by phone through email.
   const identityData = (provider: string) => (provider === 'email' ? { sub: id, email } : { sub: id, phone })
   const phoneConfirmedAt = body.phone_confirm === true && phone ? now : null

   // Row and identities together: a half-written user can sign in one way and not the other, which
   // is worse than no user at all.
   const user = await repo.transaction(async (tx) => {
      const created = await tx.createUser({
         id,
         email: email ?? null,
         phone: phone ?? null,
         role: typeof body.role === 'string' ? body.role : 'authenticated',
         // Passed straight through, so a migration moves passwords across without ever holding them
         // in plaintext here.
         encrypted_password: passwordHash ?? null,
         email_confirmed_at: body.email_confirm === true && email ? now : null,
         raw_app_meta_data: JSON.stringify(appMetadata),
         raw_user_meta_data: JSON.stringify(body.user_metadata ?? {}),
      })

      // `createUser` writes a fixed set of columns and `phone_confirmed_at` is not among them, so
      // `phone_confirm: true` was accepted and dropped. Written here, inside the same transaction.
      if (phoneConfirmedAt) {
         await tx.update('users').set({ phone_confirmed_at: phoneConfirmedAt }).where('id', '=', id).execute()
      }

      for (const provider of providers) {
         await tx.createIdentity({
            id: crypto.randomUUID(),
            provider,
            provider_id: id,
            user_id: id,
            identity_data: identityData(provider),
         })
      }
      return created
   })

   // Through the service, so the bcrypt cost stays the library's own. Outside the transaction — the
   // seam left in this route: the service hashes through its own repository and cannot be handed a
   // transactional one. The strength check has already run, so only a hashing or database failure
   // could now leave a user whose password was never set.
   if (password !== undefined) await c.var.authService.updateUser(user.id, { password })

   const created = await repo.findUserById(user.id)
   return c.json(await toAdminUserResponse(c, created ?? user), 200)
}

/**
 * Deleting a user. supabase-js sends `{ should_soft_delete }`; GoTrue answers `200 {}`, not 204.
 *
 * A soft delete keeps the row and its id so references still resolve, and takes away everything that
 * described or admitted the user — including the identifiers, which are replaced by a digest rather
 * than kept, as GoTrue does. Keeping them would mean the address stays registered for ever: creating
 * the user again answers `email_exists` for a user nobody can reach.
 *
 * One transaction throughout: separate statements can leave a user with sessions gone but the rest
 * intact.
 */
async function deleteUser(c: HonoContext): Promise<Response> {
   if (!isAdmin(c)) return forbidden(c)

   const body = await readBody(c)
   if (!body) return invalid(c, 'Could not parse the request body as JSON', 'bad_json', 400)

   const input = parseDeleteInput(body)
   if ('msg' in input) return invalid(c, input.msg)

   const id = c.req.param('id')
   const { repo } = c.var.authService
   const user = await repo.findUserById(id)
   if (!user) return notFound(c)

   // Asked before the transaction opens, and this is the point of doing it here: the factor table
   // belongs to another patch, and a query against a table that is not there throws — which inside
   // the transaction would roll the whole delete back. The driver wraps the cause into `Failed to
   // prepare statement`, so the reason cannot be recovered afterwards; a harmless read beforehand
   // answers the only question that matters.
   const factors = await tableIsQueryable(repo, 'mfa_factors')

   const identities = (await repo.findIdentitiesByUserId(id)) as { provider?: string; provider_id?: string }[]
   const obfuscated = input.soft ? await obfuscateIdentifiers(user, identities) : null

   await repo.transaction(async (tx) => {
      await tx.deleteFrom('refresh_tokens').where('user_id', '=', id).execute()
      await tx.deleteFrom('sessions').where('user_id', '=', id).execute()
      if (factors) await tx.deleteFrom('mfa_factors').where('user_id', '=', id).execute()

      if (!obfuscated) {
         await tx.deleteFrom('users').where('id', '=', id).execute()
         return
      }

      await tx
         .update('users')
         .set({
            deleted_at: new Date().toISOString(),
            email: obfuscated.email,
            phone: obfuscated.phone,
            encrypted_password: null,
            confirmation_token: null,
            recovery_token: null,
            email_change: null,
            email_change_token_new: null,
            email_change_token_current: null,
            phone_change: null,
            phone_change_token: null,
            reauthentication_token: null,
            raw_user_meta_data: '{}',
            raw_app_meta_data: '{}',
         })
         .where('id', '=', id)
         .execute()

      // Emptied and re-keyed rather than removed, so references to them still resolve while the
      // identifier they carried no longer names anybody.
      for (const identity of obfuscated.identities) {
         await tx
            .update('identities')
            .set({ identity_data: '{}', provider_id: identity.providerId })
            .where('user_id', '=', id)
            .where('provider', '=', identity.provider)
            .execute()
      }
   })

   // GoTrue answers an empty object, not the deleted user: supabase-js would run a user through its
   // transform and describe one that is gone.
   return c.json({}, 200)
}

/** Whether an optional table can be read at all. Any failure counts as absent; the read changes nothing. */
async function tableIsQueryable(repo: Repo, table: string): Promise<boolean> {
   try {
      await repo.table(table).select('user_id').limit(1).execute()
      return true
   } catch {
      return false
   }
}

/**
 * GoTrue replaces a soft-deleted user's identifiers with `base64url(sha256(id + value))`, the phone
 * truncated to fifteen characters, and does the same to each identity's `provider_id` over
 * `provider + ':' + provider_id`. The digest is stable for one user and reveals nothing.
 */
async function obfuscateIdentifiers(
   user: UserRow,
   identities: { provider?: string; provider_id?: string }[],
): Promise<{
   email: string | null
   phone: string | null
   identities: { provider: string; providerId: string }[]
}> {
   const digest = async (value: string) => {
      const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.id + value)))
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
   }

   const email = typeof user.email === 'string' && user.email ? await digest(user.email) : null
   const phone = typeof user.phone === 'string' && user.phone ? (await digest(user.phone)).slice(0, 15) : null

   const rekeyed: { provider: string; providerId: string }[] = []
   for (const identity of identities) {
      if (!identity.provider) continue
      rekeyed.push({
         provider: identity.provider,
         providerId: await digest(`${identity.provider}:${identity.provider_id ?? ''}`),
      })
   }

   return { email, phone, identities: rekeyed }
}

/**
 * A credential nobody knows, the administrator included. Sixty-four characters, GoTrue's length —
 * and never fewer than the configured minimum, or the strength check refuses the password this
 * route generated for itself. All four character classes are in the alphabet; over that many draws
 * one of each is near-certain but not guaranteed.
 */
function randomPassword(config: { minimum_password_length?: number }): string {
   const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*'
   const length = Math.max(64, Number(config.minimum_password_length) || 0)
   const bytes = crypto.getRandomValues(new Uint8Array(length))
   let password = ''
   for (const byte of bytes) password += alphabet[byte % alphabet.length]
   return password
}

/**
 * The `Link` header GoTrue emits, in the shape supabase-js parses. Two details are about that parser:
 * `last` is always present, since an empty header would parse as one malformed link; and the query is
 * rebuilt with `page` first, since the parser reads the page number from the first `=` it finds.
 */
function paginationLinks(page: number, perPage: number, total: number): string {
   const lastPage = total === 0 ? 0 : Math.ceil(total / perPage)
   const url = (n: number) => `</admin/users?page=${n}&per_page=${perPage}>`

   const links: string[] = []
   if (page > 1) links.push(`${url(page - 1)}; rel="prev"`, `${url(1)}; rel="first"`)
   if (page < lastPage) links.push(`${url(page + 1)}; rel="next"`)
   links.push(`${url(lastPage)}; rel="last"`)
   return links.join(', ')
}
