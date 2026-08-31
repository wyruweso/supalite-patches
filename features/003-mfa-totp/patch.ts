// FEAT-003 — TOTP as a second factor (`supabase.auth.mfa.*`).
//
// FEATURES.md marks this planned, effort M, no blocker, suggesting otplib. No library was needed:
// RFC 6238 is thirty lines and `crypto.subtle` exists in every runtime this package targets,
// including Workers. QR is the one thing a patch cannot honestly do; the enrol route says why.
//
// AAL is the point of MFA, and the schema was ready for it — `auth.sessions` already carries `aal`
// and `factor_id`. Verifying a factor elevates the session in the database and the token is stamped
// from that row, which is what makes `aal2` survive a refresh.
//
// Five anchors, because the level and the factors have to appear everywhere the SDK looks:
//
//   the auth schema DDL        the two tables, so the migrator sees them on both sides
//   createApp                  the routes
//   getUser                    user.factors — mfa.listFactors() reads them from there, not a route
//   createSessionForUser       aal on a new token
//   createRefreshResponse      aal on a refreshed one
//
import {
   appendToConstant,
   argumentOfCall,
   functionWithText,
   methodNamed,
   wrapFunction,
   wrapMethod,
} from '../../lib/patcher.ts'
import { MFA_SCHEMA_SQL } from './src/auth/schema.ts'

export const id = 'FEAT-003'
export const title = 'TOTP second factor: enroll, challenge, verify, aal2'

// `an anonymous user cannot enrol a factor` is not declared: the anonymous sign-in it needs does
// not exist on the published build either, so it cannot diverge. It guards the two patches together.
export const expectedDivergence = [
   'FEAT-003 TOTP second factor',
   'FEAT-003 TOTP second factor > enrolling returns a secret and an otpauth URI',
   'FEAT-003 TOTP second factor > the issuer reaches the URI, and the label is the account',
   'FEAT-003 TOTP second factor > a challenge can be raised for the factor',
   'FEAT-003 TOTP second factor > the right code verifies the factor and returns a session',
   'FEAT-003 TOTP second factor > a wrong code is refused',
   'FEAT-003 TOTP second factor > a code from a neighbouring time step is accepted',
   'FEAT-003 TOTP second factor > a challenge cannot be replayed',
   'FEAT-003 TOTP second factor > a challenge dies after too many wrong codes',
   'FEAT-003 TOTP second factor > a non-totp factor is refused by name',
   'FEAT-003 TOTP second factor > factors are exposed on the user, where supabase-js reads them',
   'FEAT-003 TOTP second factor > factors are scoped to their owner',
   'FEAT-003 TOTP second factor > verifying raises the session to aal2',
   'FEAT-003 TOTP second factor > a permanent user is stamped by both patches at once',
   'FEAT-003 TOTP second factor > an ordinary session carries aal1 and its own method',
   'FEAT-003 TOTP second factor > a second factor cannot reuse a friendly name',
   'FEAT-003 TOTP second factor > a second verification does not repeat the method',
   'FEAT-003 TOTP second factor > a factor carries both timestamps, and updated_at moves when it is verified',
   'FEAT-003 TOTP second factor > aal2 survives a refresh',
   'FEAT-003 TOTP second factor > verifying ends the other sessions of that user',
   'FEAT-003 TOTP second factor > the secret is stored, and this build stores it in the clear',
]

const routes = new URL('./src/auth/mfa.ts', import.meta.url)
const session = new URL('./src/auth/session.ts', import.meta.url)

export function apply(source: string): string {
   const schema = appendToConstant(source, { containing: 'users_email_partial_key', addition: MFA_SCHEMA_SQL })

   const routed = wrapFunction(schema, {
      at: functionWithText('/storage/v1/*'),
      replacement: routes,
      exported: 'createApp',
      bind: { authRoutes: argumentOfCall('/auth/v1', 1) },
   })

   // `mfa.listFactors()` reads `user.factors` out of getUser() rather than calling a route, so an
   // invented GET /factors would be unreachable from the SDK.
   const listed = wrapMethod(routed, {
      at: methodNamed('getUser', 'assertPasswordStrong'),
      replacement: session,
      exported: 'getUser',
      originalAs: 'getUserOriginal',
   })

   // Two methods mint an access token, each assembling the claims inline. Stamping one alone gives
   // an aal2 token that quietly drops back to aal1 at the first refresh.
   const stamped = wrapMethod(listed, {
      at: methodNamed('createSessionForUser', 'assertPasswordStrong'),
      replacement: session,
      exported: 'createSessionForUser',
      originalAs: 'createSessionForUserOriginal',
   })

   return wrapMethod(stamped, {
      at: methodNamed('createRefreshResponse', 'assertSessionRefreshable'),
      replacement: session,
      exported: 'createRefreshResponse',
      originalAs: 'createRefreshResponseOriginal',
   })
}
