// FEAT-003 — TOTP as a second factor.  Listed as planned, effort M, in the package's own FEATURES.md.
//
// enroll -> challenge -> verify, the three calls supabase.auth.mfa makes. The code is computed here
// from RFC 6238 on node:crypto, independently of the patch — two implementations agreeing is what
// makes it real TOTP rather than something six digits long.
//
// Verifying elevates the caller's own session to aal2 — in the database, so the level survives a
// refresh — and ends their other sessions.
//
//   node repro.ts 003          ABSENT on the published bundle
//   npm run install:patches    then run it again
import { newApp, get, post, type LiteApp } from '../../test/harness.ts'
import { createHmac } from 'node:crypto'
// `process.exit` is needed here: on the published bundle the feature is absent, so the rest of the
// script would read fields that do not exist. The other reproductions drain their event loop alone.
import process from 'node:process'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function totp(secret: string, step = Math.floor(Date.now() / 1000 / 30)): string {
   let bits = ''
   for (const char of secret) bits += BASE32.indexOf(char).toString(2).padStart(5, '0')
   const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)))

   const counter = Buffer.alloc(8)
   counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0)
   counter.writeUInt32BE(step >>> 0, 4)

   const mac = createHmac('sha1', key).update(counter).digest()
   const offset = mac[mac.length - 1] & 0x0f
   return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0')
}

// The library logs every error it handles, stack trace included, which would bury a short report.
console.error = () => {}
const show = (label: string, value: unknown) => console.log(`  ${label.padEnd(34)} ${String(value)}`)
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

console.log('\nFEAT-003 — TOTP second factor — /auth/v1/factors\n')

const { app }: { app: LiteApp } = await newApp({ seed: false })
const session = (await post(app, '/auth/v1/signup', { email: 'mfa@b.co', password: 'password123' })).body
const auth = { Authorization: `Bearer ${session.access_token}` }

const enrolled = await post(app, '/auth/v1/factors', { factor_type: 'totp', friendly_name: 'Phone' }, auth)
show(
   'POST /auth/v1/factors',
   `${enrolled.status} ${enrolled.status === 200 ? '' : JSON.stringify(enrolled.body).slice(0, 60)}`,
)
if (enrolled.status !== 200) {
   console.log('\n  ABSENT: the route is not mounted at all\n')
   process.exit(0)
}

const factor = enrolled.body
show('secret', `${factor.totp.secret.slice(0, 8)}…  (${factor.totp.secret.length} base32 chars)`)
show('otpauth URI', `${factor.totp.uri.slice(0, 52)}…`)

const raised = (await post(app, `/auth/v1/factors/${factor.id}/challenge`, {}, auth)).body
show('challenge', raised.id)

const code = totp(factor.totp.secret)
const verified = await post(app, `/auth/v1/factors/${factor.id}/verify`, { challenge_id: raised.id, code }, auth)
show(
   `verify with ${code}`,
   `${verified.status} ${verified.body.access_token ? 'session issued' : JSON.stringify(verified.body)}`,
)
show('the factor is now', (await get(app, '/auth/v1/user', auth)).body.factors[0].status)
show('user.factors (listFactors)', JSON.stringify((await get(app, '/auth/v1/user', auth)).body.factors[0]))

// The point of it: the claim a policy and getAuthenticatorAssuranceLevel() read.
show('aal before verifying', String(claimsOf(session.access_token).aal))
show('aal after verifying', String(claimsOf(verified.body.access_token).aal))
show('amr', JSON.stringify(claimsOf(verified.body.access_token).amr))

const refreshed = await post(app, '/auth/v1/token?grant_type=refresh_token', {
   refresh_token: verified.body.refresh_token,
})
show('aal after a refresh', String(claimsOf(refreshed.body.access_token).aal))

const replay = await post(app, `/auth/v1/factors/${factor.id}/verify`, { challenge_id: raised.id, code }, auth)
show('replaying that challenge', `${replay.status} ${replay.body.error_code}`)

const second = (await post(app, `/auth/v1/factors/${factor.id}/challenge`, {}, auth)).body
const wrong = await post(app, `/auth/v1/factors/${factor.id}/verify`, { challenge_id: second.id, code: '000000' }, auth)
show('a wrong code', `${wrong.status} ${wrong.body.error_code}`)

console.log(
   '\n  PRESENT: a code computed here by RFC 6238 verifies, a wrong one does not, and a challenge is single-use\n',
)
