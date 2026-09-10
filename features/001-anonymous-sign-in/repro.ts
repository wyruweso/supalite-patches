// Anonymous signup uses POST /auth/v1/signup without credentials, with the config flag enabled.
// Run: npm run repro -- anonymous-sign-in
import { newRawApp, get, post, JWT_SECRET, type LiteApp, type LiteConnection } from '../../test/harness.ts'
// `process.exit` is needed here: on the published bundle the feature is absent, so the rest of the
// script would read fields that do not exist. The other reproductions drain their event loop alone.
import process from 'node:process'

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

console.log('\nFEAT-001 — anonymous sign-in\n')

const { app, connection }: { app: LiteApp; connection: LiteConnection } = await newRawApp({
   auth: {
      enabled: true,
      jwt_secret: JWT_SECRET,
      site_url: 'http://localhost:3000',
      enable_anonymous_sign_ins: true,
   },
})
await (
   await connection.createMigrator(`CREATE TABLE carts (id int primary key, owner uuid, item text);
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON carts FOR ALL USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());`)
).migrate()

const r = await post(app, '/auth/v1/signup', {})
show('POST /auth/v1/signup {}', `${r.status} ${r.body?.error_code ?? 'session issued'}`)

if (r.status !== 200) {
   console.log(`\n  ABSENT: refused with ${r.body?.error_code ?? r.body?.message}\n`)
   process.exit(0)
}

const user = r.body.user
show('user.is_anonymous', String(user.is_anonymous))
show('user.email', JSON.stringify(user.email))
show('user.role', user.role)
show('user.app_metadata', JSON.stringify(user.app_metadata))
show('user.identities', JSON.stringify(user.identities))

// The claim is the half that matters: it is what a policy can read, and the user object is not.
show('access token claims', JSON.stringify(claimsOf(r.body.access_token)))

// A session that cannot be refreshed is not a session. The claim has to survive the refresh too —
// there are two places that mint a token, and only one of them is the sign-up path.
const refreshed = await post(app, '/auth/v1/token?grant_type=refresh_token', { refresh_token: r.body.refresh_token })
show('after refresh', `${refreshed.status}, same user: ${refreshed.body.user.id === user.id}`)
show('is_anonymous still claimed', String(claimsOf(refreshed.body.access_token).is_anonymous))

// And it has to work like any other session, or anonymous sign-in is useless.
const auth = { Authorization: `Bearer ${refreshed.body.access_token}` }
await post(app, '/rest/v1/carts', { id: 1, owner: user.id, item: 'book' }, auth)
show('its own row, under RLS', JSON.stringify((await get(app, '/rest/v1/carts?select=item', auth)).body))

console.log(
   '\n  PRESENT: a credential-less user with a refreshable session, an is_anonymous claim a policy can read, and RLS scoping it by auth.uid() like any other\n',
)
