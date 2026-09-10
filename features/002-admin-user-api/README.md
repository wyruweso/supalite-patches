# FEAT-002: manage users through an admin API

Public signup lets someone create their own account. An admin API lets server-side code manage
accounts, including when public signup is disabled. Creating a user does not sign that user in or
return their session.

These routes require an access token with `service_role`, the privileged server role.

## What this adds

| Request                           | Result                                     |
| --------------------------------- | ------------------------------------------ |
| `GET /auth/v1/admin/users`        | A page of users                            |
| `GET /auth/v1/admin/users/:id`    | One user, including their login identities |
| `POST /auth/v1/admin/users`       | A newly created user                       |
| `DELETE /auth/v1/admin/users/:id` | Hard or soft deletion; returns `200 {}`    |

For example, an admin can create an email account using this JSON body:

```json
{
   "email": "alex@example.com",
   "password": "Example-password-123!",
   "email_confirm": true
}
```

`email_confirm: true` marks the address as confirmed. The user can then use the normal password
sign-in route. Creation requires an email or phone number; it also supports metadata and a supplied id.

## How the feature works

[server.ts](src/server/server.ts) registers the handlers before the original app mounts its auth
router. Mounting copies the routes, so registering them afterwards would be too late.

Creation validates the request, then saves the user and their **identities**: records linking the
account to email or phone login. `password_hash` accepts an already hashed password in bcrypt
format, for importing an account. It cannot be combined with a password. Without either credential, the code
generates a password that is not returned to the caller.

User and identity creation share a transaction: those writes succeed or roll back together.
Password hashing uses the library's existing password-update method afterwards. That separate
step can fail after the user has been saved.

Listing accepts `page` and `per_page`. Pagination headers tell the Supabase JavaScript client the
total count and available pages.

## What deletion means

Hard deletion removes the user row. Soft deletion, requested with `{"should_soft_delete": true}`,
keeps its id, marks it deleted, and replaces email and phone with hashed values. It clears
credentials and metadata, making the original address available for another account.

Both remove sessions and refresh tokens. Saved second factors are also removed if their optional
MFA table exists.
[session.ts](src/auth/session.ts) also prevents a deleted user from starting a new session.

Auth rejects tokens whose session was deleted. The Data API checks the token's signature without
looking up that session, so an already-issued access token can still work until it expires.

## Scope and checks

User updates, bans, link generation, and second-factor admin routes are not implemented. The default user role
is `authenticated`. An explicit `service_role` is accepted and reaches later login tokens, allowing
that user to bypass row-access policies.

[Tests](test.ts) cover routes, pagination, identities, deletion, and rejected input.
[patch.ts](patch.ts) installs this feature independently of the others.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- admin-user-api
```

[How to compare the published and patched builds](../../README.md#run-the-project).
