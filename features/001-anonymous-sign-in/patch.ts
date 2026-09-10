// FEAT-001: anonymous sign-in and user/JWT flags. Helpers stay local for independent application.
import { methodNamed, moduleFunctionWithText, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FEAT-001'
export const title = 'anonymous sign-in'

// Single-gate refusals already match upstream. Only their priority when both are closed changes.
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
   'FEAT-001 anonymous sign-in > an anonymous user cannot claim an address that is taken',
]

// Bind the library's refusal in every splice: each one also carries this file's helpers.
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
