// FEAT-002 — the core admin users API: list, get, create and delete.
//
// Deliberately not billed as `supabase.auth.admin.*`, which also covers updateUserById, the MFA
// admin routes and generate_link. Those are named as out of scope at the head of
// src/server/server.ts rather than half-implemented.
//
// FEATURES.md marks this planned, effort M. The table, the repository query builders and the
// response mapper are all there; what was missing was routes.
//
// `authRoutes` is a module variable whose name the minifier erased, recovered from the mounting call
// where the path literal survived. The app builder is identified by the storage mount mask, since
// `/auth/v1` also appears in the OAuth callback URL builder.
//
// Two anchors, because a soft delete has two halves and only one is a route:
//
//   createApp               the routes
//   createSessionForUser    a soft-deleted user is refused a session
//
// The second is not tidiness: `deleted_at` occurs once in the published bundle, in the DDL creating
// the column, so nothing honours it and a soft-deleted address would still receive codes from
// `/auth/v1/otp`. One wrapper on the method every sign-in flow ends at; guarding the flows
// themselves would cost five and miss the sixth.
import {
   argumentOfCall,
   functionWithText,
   methodNamed,
   moduleFunctionWithText,
   wrapFunction,
   wrapMethod,
} from '../../lib/patcher.ts'

export const id = 'FEAT-002'
export const title = 'core admin users API: list, get, create, delete'

// `an unauthenticated request never reaches the handler` is deliberately absent: the middleware
// refuses on both builds, so it must not diverge. It guards that the routes inherit the chain rather
// than carrying their own idea of who may call them.
export const expectedDivergence = [
   'FEAT-002 admin user API',
   'FEAT-002 admin user API > listing users returns them',
   'FEAT-002 admin user API > a single user can be fetched by id',
   'FEAT-002 admin user API > the pagination headers supabase-js reads are present',
   'FEAT-002 admin user API > a user is created with sign-ups disabled, and is not signed in',
   'FEAT-002 admin user API > a password is optional, and a phone number is an identifier of its own',
   'FEAT-002 admin user API > id, role and both metadata objects are taken from the request',
   'FEAT-002 admin user API > a created user has an identity per provider',
   'FEAT-002 admin user API > a malformed create is a 400, and a refused one a 422',
   'FEAT-002 admin user API > an absent or blank password is replaced by one nobody knows',
   'FEAT-002 admin user API > a duplicate phone number is refused',
   'FEAT-002 admin user API > an empty page still carries a last link',
   'FEAT-002 admin user API > a create with neither email nor phone is refused, and creates nothing',
   'FEAT-002 admin user API > a malformed body is bad JSON, not a missing field',
   'FEAT-002 admin user API > a duplicate address is refused',
   'FEAT-002 admin user API > a user can be deleted, and their sessions go with them',
   'FEAT-002 admin user API > a soft delete empties the user rather than removing it',
   'FEAT-002 admin user API > a soft-deleted user cannot sign in by any path this build offers',
   'FEAT-002 admin user API > a stale access token dies on the auth API and outlives the delete on the data API',
   'FEAT-002 admin user API > a password_hash that is not a bcrypt hash is refused',
   'FEAT-002 admin user API > a bcrypt hash is stored as the credential',
   'FEAT-002 admin user API > deleting someone who is not there is a 404',
   'FEAT-002 admin user API > an ordinary user token is refused',
]

const routes = new URL('./src/server/server.ts', import.meta.url)
const session = new URL('./src/auth/session.ts', import.meta.url)

export function apply(source: string): string {
   const routed = wrapFunction(source, {
      at: functionWithText('/storage/v1/*'),
      replacement: routes,
      exported: 'createApp',
      bind: { authRoutes: argumentOfCall('/auth/v1', 1) },
   })

   // Every flow creating an initial authenticated session converges here — password, signup,
   // verifyOtp, magic link, recovery, OAuth, PKCE — so this is the one place to turn a deleted user
   // away. Refresh needs no guard: the delete takes its token and session row with it.
   //
   // `invalidCredentials` is the library's own error factory, found by the message only it carries.
   // Raising anything else would leave a 500 where a 400 belongs.
   return wrapMethod(routed, {
      at: methodNamed('createSessionForUser', 'assertPasswordStrong'),
      replacement: session,
      exported: 'createSessionForUser',
      originalAs: 'createSessionForUserOriginal',
      bind: { invalidCredentials: moduleFunctionWithText('Invalid login credentials') },
   })
}
