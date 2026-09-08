// FEAT-001 — anonymous sign-in (`signInAnonymously`).
//
// FEATURES.md marks this planned, effort S, no blocker. It was deferred rather than forgotten:
// `auth.users` already has an indexed `is_anonymous` column, the repository reads and writes it, and
// the attempt is refused by a named error, `anonymous_provider_disabled`. Only the path was missing.
//
// What it does not do: the user row and the first session are not written in one transaction. A
// failure issuing the session strands an anonymous user with no credential to sign back in with, and
// nothing will ever reach that row again. Closing it means owning session creation rather than
// wrapping it, which is a larger change than this feature.
//
// The JWT helpers at the foot of `src/auth/service.ts` are duplicated in FEAT-003, which re-signs
// tokens for its own reasons. The duplication is deliberate: a patch that imported them from a
// neighbour could not be applied on its own.
import { methodNamed, moduleFunctionWithText, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FEAT-001'
export const title = 'anonymous sign-in'

// Two of the three refusal tests are deliberately absent: the published build refuses in the same
// words, so they must not diverge — they guard against this patch opening a hole. The third is
// declared, because this patch changes which gate answers first when both are closed.
export const expectedDivergence = [
   'FEAT-001 anonymous sign-in',
   'FEAT-001 anonymous sign-in > a signup with no credentials returns a session',
   'FEAT-001 anonymous sign-in > the user is a credential-less user, not a user of some anonymous provider',
   'FEAT-001 anonymous sign-in > the access token carries is_anonymous',
   'FEAT-001 anonymous sign-in > an ordinary session carries is_anonymous=false',
   'FEAT-001 anonymous sign-in > with both gates closed the anonymous one answers first',
   'FEAT-001 anonymous sign-in > claiming an address makes an anonymous user permanent',
   'FEAT-001 anonymous sign-in > the session refreshes, and the user is still anonymous',
   'FEAT-001 anonymous sign-in > the user reads back through GET /user',
   'FEAT-001 anonymous sign-in > signing out ends the session',
   'FEAT-001 anonymous sign-in > the session works against the Data API',
   'FEAT-001 anonymous sign-in > metadata passed on sign-in is kept',
]

// The library's own refusal, so its status and wording stay the library's. Bound in every splice
// rather than only the one that throws it, since the patcher carries a file's other top-level
// declarations along with whichever function it inserts.
const refusal = { bind: { anonymousProviderDisabled: moduleFunctionWithText('anonymous_provider_disabled') } }

export function apply(source: string): string {
   const patched = wrapMethod(source, {
      at: methodNamed('signUp', 'signInWithPassword'),
      replacement: new URL('./src/auth/service.ts', import.meta.url),
      exported: 'signUp',
      originalAs: 'signUpOriginal',
      ...refusal,
   })

   const mapped = wrapMethod(patched, {
      at: methodNamed('mapUserToResponse', 'assertPasswordStrong'),
      replacement: new URL('./src/auth/service.ts', import.meta.url),
      exported: 'mapUserToResponse',
      originalAs: 'mapUserToResponseOriginal',
      ...refusal,
   })

   // Two methods mint an access token, each assembling the claims inline: one for a new session,
   // one for a refreshed one. Both are wrapped, or the claim survives only until the first refresh.
   const signed = wrapMethod(mapped, {
      at: methodNamed('createSessionForUser', 'assertPasswordStrong'),
      replacement: new URL('./src/auth/service.ts', import.meta.url),
      exported: 'createSessionForUser',
      originalAs: 'createSessionForUserOriginal',
      ...refusal,
   })

   return wrapMethod(signed, {
      at: methodNamed('createRefreshResponse', 'assertSessionRefreshable'),
      replacement: new URL('./src/auth/service.ts', import.meta.url),
      exported: 'createRefreshResponse',
      originalAs: 'createRefreshResponseOriginal',
      ...refusal,
   })
}
