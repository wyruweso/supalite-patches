# FEAT-001: give a guest a real account without asking for credentials

A visitor can start a shopping cart before providing an email or password. Anonymous sign-in gives
that visitor a user id and a session, so the cart can belong to them from the start.

**An anonymous user is signed in.** Their role is `authenticated`. A request with no login token
uses the separate `anon` role. The `is_anonymous` flag distinguishes a guest account from a
permanent account.

## What changes?

With `auth.enable_anonymous_sign_ins: true` and signup enabled, this request creates a guest account:

```http
POST /auth/v1/signup
Content-Type: application/json

{}
```

The response includes a user, an access token for API requests, and a refresh token for obtaining
another access token later. The user has no email, password, or login-provider identity.

Database row-access policies (RLS) can use `auth.uid()` to find this user's id, just as for any other
signed-in user. Application policies still decide which rows that id may access.

## How the feature works

All implementation code is in [service.ts](src/auth/service.ts):

1. `signUp` handles requests without credentials, checks the configuration, and creates the user.
   Requests with an email or password continue through the original signup method.
2. `mapUserToResponse` exposes the saved `is_anonymous` value on the user object.
3. `createSessionForUser` and `createRefreshResponse` add the same flag to each signed access token
   (JWT). Both paths matter: refreshing must not lose the guest flag.
4. After email verification, `markVerifiedAnonymousUserAsPermanent` clears the flag while keeping
   the same user id. Data already owned by that id still belongs to the account.

Ordinary users receive `is_anonymous: false` in their tokens too. A missing field is not equivalent
to false when a database policy reads it.

## Scope and checks

Anonymous sign-in is disabled unless explicitly enabled. Conversion to a permanent account covers
email verification. Guest user creation and session creation remain separate database writes;
a failure creating the session can leave the user row behind.

[Tests](test.ts) cover signup, refresh, access to owned data, email conversion, and the configuration
gates. [patch.ts](patch.ts) installs the wrappers. The feature keeps its helpers local and works
without the other fixes or features.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- anonymous-sign-in
```

The reproduction enables anonymous sign-in itself.
[How to compare the published and patched builds](../../README.md#run-the-project).
