// FEAT-003: TOTP routes, factors, and session claims.
// Extends the auth schema and upgrades existing MFA tables; helpers stay local.
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
   'FEAT-003 TOTP second factor > a further factor needs the existing one',
   'FEAT-003 TOTP second factor > a further factor needs the existing one > an aal1 session cannot enrol another factor',
   'FEAT-003 TOTP second factor > a further factor needs the existing one > an aal1 session cannot verify a factor enrolled earlier',
   'FEAT-003 TOTP second factor > a further factor needs the existing one > the owner still steps up from a password-only session',
   'FEAT-003 TOTP second factor > a further factor needs the existing one > either verified factor can establish aal2 on a new session',
   'FEAT-003 TOTP second factor > upgrades a persisted MFA schema without losing factors or pending challenges',
   'FEAT-003 TOTP second factor > one use each',
   'FEAT-003 TOTP second factor > one use each > two concurrent verifications with one challenge: exactly one succeeds',
   'FEAT-003 TOTP second factor > one use each > the same code is refused through a second challenge',
   'FEAT-003 TOTP second factor > one use each > concurrent wrong codes are all counted',
   'FEAT-003 TOTP second factor > a session that already passed MFA is left alone',
   'FEAT-003 TOTP second factor > a migration after the upgrade plans nothing for the MFA tables',
   'FEAT-003 TOTP second factor > a malformed enrolment leaves nothing',
   'FEAT-003 TOTP second factor > a malformed enrolment leaves nothing > a body that is not a JSON object is refused',
   'FEAT-003 TOTP second factor > a malformed enrolment leaves nothing > a field of the wrong type is refused before anything is written',
]

const routes = new URL('./src/auth/mfa.ts', import.meta.url)
const session = new URL('./src/auth/session.ts', import.meta.url)

export function apply(source: string): string {
   const schema = appendToConstant(source, { containing: 'users_email_partial_key', addition: MFA_SCHEMA_SQL })

   const upgraded = wrapMethod(schema, {
      at: methodNamed('ensureSystemSchema', 'getClient'),
      replacement: new URL('./src/auth/migration.ts', import.meta.url),
      exported: 'ensureSystemSchema',
      originalAs: 'ensureSystemSchemaOriginal',
   })

   const routed = wrapFunction(upgraded, {
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
