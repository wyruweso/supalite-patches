// FEAT-002 — list, get, create, and delete users through the admin API.
// Adds routes before authRoutes is mounted and rejects deleted users at session creation.
// The storage mount identifies createApp; /auth/v1 also occurs in the OAuth callback builder.
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
   'FEAT-002 admin user API > a role given at creation reaches the token, service_role included',
   'FEAT-002 admin user API > a create without a role is authenticated',
   'FEAT-002 admin user API > a generated password satisfies the configured character classes',
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
   'FEAT-002 admin user API > a soft delete empties the user and unnames them',
   'FEAT-002 admin user API > malformed input is refused before anything happens',
   'FEAT-002 admin user API > malformed input is refused before anything happens > a should_soft_delete that is not a boolean is a 400, and keeps the user',
   'FEAT-002 admin user API > malformed input is refused before anything happens > a body that is not an object is bad JSON',
   'FEAT-002 admin user API > malformed input is refused before anything happens > ?page=1.5 is a 400, not a 500',
   'FEAT-002 admin user API > malformed input is refused before anything happens > ?per_page=1.5 is a 400, not a 500',
   'FEAT-002 admin user API > malformed input is refused before anything happens > ?page=Infinity is a 400, not a 500',
   'FEAT-002 admin user API > malformed input is refused before anything happens > ?page=0 is a 400, not a 500',
   'FEAT-002 admin user API > malformed input is refused before anything happens > ?per_page=-1 is a 400, not a 500',
   'FEAT-002 admin user API > phone_confirm marks the number confirmed',
   'FEAT-002 admin user API > a minimum password length longer than the generator is still satisfied',
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
