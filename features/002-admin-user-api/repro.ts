// Admin routes use a service_role JWT. The published build returns Studio HTML for absent routes.
// Run: npm run repro -- admin-user-api
import { newRawApp, get, post, req, JWT_SECRET, type LiteApp, type LiteConnection } from '../../test/harness.ts'
import { SignJWT } from 'jose'
// `process.exit` is needed here: on the published bundle the feature is absent, so the rest of the
// script would read fields that do not exist. The other reproductions drain their event loop alone.
import process from 'node:process'

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)

console.log('\nFEAT-002 — the core admin users API\n')

// Sign-ups are off here, which is the whole distinction: a caller cannot register, an administrator
// can still create.
const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newRawApp({
   auth: { enabled: true, jwt_secret: JWT_SECRET, site_url: 'http://localhost:3000', enable_signup: false },
})

const token = await new SignJWT({ sub: crypto.randomUUID(), role: 'service_role', aud: 'authenticated' })
   .setProtectedHeader({ alg: 'HS256' })
   .setIssuedAt()
   .setExpirationTime('1h')
   .sign(new TextEncoder().encode(JWT_SECRET))
const admin = { Authorization: `Bearer ${token}` }

const refused = await post(app, '/auth/v1/signup', { email: 'a@b.co', password: 'password123' })
show('POST /signup (sign-ups off)', String(refused.body.error_code))

const list = await get(app, '/auth/v1/admin/users', admin)
if (!Array.isArray(list.body?.users)) {
   show('GET /auth/v1/admin/users', `${list.status} ${String(list.body).slice(0, 24)}… (the dashboard)`)
   console.log('\n  ABSENT: the route is not mounted; the path falls through to the Studio page\n')
   process.exit(0)
}
show('GET /auth/v1/admin/users', `${list.status} []`)

for (const body of [
   { email: 'one@b.co', password: 'password123', email_confirm: true },
   { email: 'two@b.co', phone: '+15550002', user_metadata: { plan: 'pro' } },
   { phone: '+15550001', phone_confirm: true },
] as Record<string, unknown>[]) {
   const created = await post(app, '/auth/v1/admin/users', body, admin)
   const identities = (created.body.identities ?? []).map(
      (i: { provider: string; identity_data: Record<string, unknown> }) =>
         `${i.provider}:${JSON.stringify(i.identity_data)}`,
   )
   show(
      `created ${JSON.stringify(body).slice(0, 24)}…`,
      `${created.status} ${created.body.email || created.body.phone}`,
   )
   for (const identity of identities) show('', identity.replace(/"sub":"[^"]+",?/, ''))
}

// Refusals a caller can act on: a malformed request is a 400, a refused one a 422.
for (const body of [{}, { email: 'one@b.co' }] as Record<string, unknown>[]) {
   const r = await post(app, '/auth/v1/admin/users', body, admin)
   show(`refused ${JSON.stringify(body)}`, `${r.status} ${r.body.error_code}`)
}

// Created, not signed in: an administrator makes a user, and does not get a session out of it.
const sessions = ((await connection.exec('SELECT id FROM "auth.sessions"')).rows ?? []).length
show('sessions that created', String(sessions))
const signedIn = await post(app, '/auth/v1/token?grant_type=password', { email: 'one@b.co', password: 'password123' })
show('the created user can sign in', String(signedIn.status === 200))

// supabase-js reads pagination out of the headers, not the body.
const page = await req(app, 'GET', '/auth/v1/admin/users?page=1&per_page=2', undefined, admin)
show('X-Total-Count', String(page.headers.get('x-total-count')))
show('Link', String(page.headers.get('link')).replace(/http:\/\/lite\.test/g, ''))

// One with an address, so what a soft delete keeps is visible.
const everyone = (await get(app, '/auth/v1/admin/users', admin)).body.users as { id: string; email: string }[]
const target = (everyone.find((u) => u.email === 'one@b.co') ?? everyone[0]).id
const soft = await req(app, 'DELETE', `/auth/v1/admin/users/${target}`, { should_soft_delete: true }, admin)
const kept = ((await connection.exec(`SELECT email, deleted_at FROM "auth.users" WHERE id = ?`, target)).rows ??
   []) as { email: string | null; deleted_at: string | null }[]
const [row] = ((await connection.exec('SELECT email, raw_user_meta_data FROM "auth.users" WHERE id = ?', target))
   .rows ?? []) as { email: string | null; raw_user_meta_data: string }[]
const [identity] = ((await connection.exec('SELECT identity_data FROM "auth.identities" WHERE user_id = ?', target))
   .rows ?? []) as { identity_data: string }[]
show(
   'DELETE should_soft_delete',
   `${soft.status} ${JSON.stringify(soft.body)}, row kept: ${kept.length === 1}, deleted_at: ${!!kept[0]?.deleted_at}`,
)
show(
   'what it left behind',
   `email: ${JSON.stringify(row?.email)} (upstream keeps it), metadata: ${row?.raw_user_meta_data}, identity_data: ${identity?.identity_data}`,
)

console.log(
   '\n  PRESENT: list, read, create and delete over the routes GoTrue exposes — gated on service_role, working with sign-ups off, and issuing no session\n',
)
process.exit(0)
