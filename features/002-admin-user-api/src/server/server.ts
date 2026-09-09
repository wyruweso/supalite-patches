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

/** Hono copies routes when mounting a sub-app, so register them before the original builder runs. */
export function createApp(options: unknown, extra: unknown): unknown {
   registerAdminRoutes()
   return original(options, extra)
}

/** Register list, get, create, and delete handlers behind the existing auth middleware. */
function registerAdminRoutes(): void {
   // The app may be built more than once per process, but the router is a module singleton.
   if (authRoutes.adminRoutesRegistered) return
   authRoutes.adminRoutesRegistered = true

   authRoutes.get('/admin/users', listUsers)
   authRoutes.get('/admin/users/:id', readUser)
   authRoutes.post('/admin/users', createUser)
   authRoutes.delete('/admin/users/:id', deleteUser)
}

const forbidden = (c: HonoContext) => c.json({ code: 403, error_code: 'not_admin', msg: 'User not allowed' }, 403)
const notFound = (c: HonoContext) => c.json({ code: 404, error_code: 'user_not_found', msg: 'User not found' }, 404)
const invalid = (c: HonoContext, msg: string, code = 'validation_failed', status = 400) =>
   c.json({ code: status, error_code: code, msg }, status)
const refused = (c: HonoContext, msg: string, code: string) => invalid(c, msg, code, 422)
const isAdmin = (c: HonoContext) => (c.get('jwt') as { role?: string } | undefined)?.role === 'service_role'

/** Include identities in the user response expected by supabase-js. */
async function toAdminUserResponse(c: HonoContext, user: UserRow): Promise<Record<string, unknown>> {
   const { authService } = c.var
   const identities = await authService.repo.findIdentitiesByUserId(user.id)
   return authService.mapUserToResponse(authService.repo.parseUserJson(user), identities, 'user')
}

/** An absent body is an empty record; malformed JSON or a non-object body is rejected. */
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

/** Use one-based integer pages; reject invalid offsets before reaching SQLite. */
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

/** Absent or null defaults to hard deletion; reject non-boolean flags. */
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

/** Admin creation bypasses public signup settings and does not issue a session. */
async function createUser(c: HonoContext): Promise<Response> {
   if (!isAdmin(c)) return forbidden(c)

   const body = await readBody(c)
   if (!body) return invalid(c, 'Could not parse the request body as JSON', 'bad_json', 400)

   const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : undefined
   const phone = typeof body.phone === 'string' ? body.phone.trim() : undefined
   if (!email && !phone) return invalid(c, 'An email address or a phone number is required')
   if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) return invalid(c, `Unable to validate email address: ${email}`)
   if (phone && !/^\+?[0-9]{5,20}$/.test(phone)) return invalid(c, `Invalid phone number: ${phone}`)

   // An explicit empty password still conflicts with password_hash.
   const passwordProvided = typeof body.password === 'string'
   const providedPassword = passwordProvided ? (body.password as string) : undefined
   // An empty hash counts as absent.
   const hashProvided = typeof body.password_hash === 'string' && body.password_hash !== ''
   const passwordHash = hashProvided ? (body.password_hash as string) : undefined

   if (passwordProvided && hashProvided) {
      return invalid(c, 'Only a password or a password_hash should be provided')
   }
   // Reject unsupported or malformed hashes before creating the user.
   if (hashProvided && !BCRYPT_HASH.test(passwordHash as string)) {
      return invalid(c, 'password_hash must be a bcrypt hash ($2a$, $2b$ or $2y$)')
   }

   // An empty password requests a generated credential.
   const nonEmptyPassword = providedPassword ? providedPassword : undefined
   const password = nonEmptyPassword ?? (hashProvided ? undefined : randomPassword(c.var.authService.config))

   // Validate generated passwords too, before reserving the user id and email.
   if (password !== undefined) c.var.authService.assertPasswordStrong(password)

   const id = body.id === undefined ? crypto.randomUUID() : String(body.id)
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
   // Explicit app_metadata overrides the provider defaults.
   const providers = [...(email ? ['email'] : []), ...(phone ? ['phone'] : [])]
   const appMetadata = {
      provider: providers[0],
      providers,
      ...((body.app_metadata as Record<string, unknown>) ?? {}),
   }

   // Each identity carries only its own provider identifier.
   const identityData = (provider: string) => (provider === 'email' ? { sub: id, email } : { sub: id, phone })
   const phoneConfirmedAt = body.phone_confirm === true && phone ? now : null

   const user = await repo.transaction(async (tx) => {
      const created = await tx.createUser({
         id,
         email: email ?? null,
         phone: phone ?? null,
         role: typeof body.role === 'string' ? body.role : 'authenticated',
         encrypted_password: passwordHash ?? null,
         email_confirmed_at: body.email_confirm === true && email ? now : null,
         raw_app_meta_data: JSON.stringify(appMetadata),
         raw_user_meta_data: JSON.stringify(body.user_metadata ?? {}),
      })

      // createUser omits phone_confirmed_at; set it in the same transaction.
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

   // Reuse the library's hashing configuration. Its repository cannot join this transaction;
   // a hashing or database failure here can still leave the password unset.
   if (password !== undefined) await c.var.authService.updateUser(user.id, { password })

   const created = await repo.findUserById(user.id)
   return c.json(await toAdminUserResponse(c, created ?? user), 200)
}

/**
 * Soft deletion retains the user id and replaces login identifiers with digests.
 * Return 200 {} as expected by supabase-js.
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

   // MFA is optional. Probe before the transaction because this driver loses the missing-table cause.
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

      // Keep identity rows for existing references, while removing their login identifiers.
      for (const identity of obfuscated.identities) {
         await tx
            .update('identities')
            .set({ identity_data: '{}', provider_id: identity.providerId })
            .where('user_id', '=', id)
            .where('provider', '=', identity.provider)
            .execute()
      }
   })

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
 * Use GoTrue's identifier digests: base64url(sha256(user id + identifier)),
 * with phone digests truncated to 15 characters.
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

/** Generate at least 64 characters, respecting the configured minimum password length. */
function randomPassword(config: { minimum_password_length?: number }): string {
   // One from each class first, then the rest: the configured requirements can demand a class that
   // random draws are not guaranteed to produce, and the route would refuse its own credential.
   const classes = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!@#$%^&*']
   const alphabet = classes.join('')
   const length = Math.max(64, Number(config.minimum_password_length) || 0)

   const bytes = crypto.getRandomValues(new Uint8Array(length))
   const characters = classes.map((set, index) => set[bytes[index] % set.length])
   for (let at = classes.length; at < length; at++) characters.push(alphabet[bytes[at] % alphabet.length])

   // Shuffled so the classes are not always in the same first four positions.
   const order = crypto.getRandomValues(new Uint32Array(length))
   for (let at = length - 1; at > 0; at--) {
      const swap = order[at] % (at + 1)
      ;[characters[at], characters[swap]] = [characters[swap], characters[at]]
   }
   return characters.join('')
}

/** supabase-js requires a last link and reads the page number from the first query parameter. */
function paginationLinks(page: number, perPage: number, total: number): string {
   const lastPage = total === 0 ? 0 : Math.ceil(total / perPage)
   const url = (n: number) => `</admin/users?page=${n}&per_page=${perPage}>`

   const links: string[] = []
   if (page > 1) links.push(`${url(page - 1)}; rel="prev"`, `${url(1)}; rel="first"`)
   if (page < lastPage) links.push(`${url(page + 1)}; rel="next"`)
   links.push(`${url(lastPage)}; rel="last"`)
   return links.join(', ')
}
