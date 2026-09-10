# FEAT-003: verify a second factor with an authenticator app

This feature adds a six-digit authenticator code after ordinary sign-in. The code is **TOTP**, a
time-based one-time password: the server and authenticator calculate it from a shared secret and time.

A **factor** is the saved authenticator setup for one user. A **challenge** is a temporary check
against that factor, with its own id and expiry.

## The user flow

The caller first signs in to a permanent account. Each request below uses that session's access token.

| Step      | Request                                     | Result                                                                 |
| --------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| Enroll    | `POST /auth/v1/factors`                     | A factor id, secret, and `otpauth://` setup link for the authenticator |
| Challenge | `POST /auth/v1/factors/:factorId/challenge` | A challenge id and expiry                                              |
| Verify    | `POST /auth/v1/factors/:factorId/verify`    | A session response after checking the code                             |

Enrollment uses a body such as `{"factor_type":"totp","friendly_name":"Phone"}`. Verification sends
both the challenge id and the code currently shown by the authenticator:

```json
{ "challenge_id": "<id returned by challenge>", "code": "123456" }
```

Replace `123456` with the current code. Enroll once per factor; use challenge and verify on later
sign-ins. The client should use the session returned by verification.

## What successful verification changes

The signed access token (JWT) includes two fields:

- `aal` describes how the session was verified: `aal1` before the second factor, `aal2` afterwards.
- `amr` records the authentication methods used and their timestamps, such as password followed by TOTP.

The level is saved in the database, so refresh preserves it. Other `aal1` sessions are revoked;
existing `aal2` sessions remain. Database policies must require `aal2` for actions needing a second factor.

## How the code works

- [mfa.ts](src/auth/mfa.ts) registers the routes and calculates codes in 30-second time steps. It
  accepts the previous, current, or next step to allow small clock differences.
- Verification consumes the challenge, records the used time step, and updates the session together
  in one transaction. That step cannot be reused for this factor, even with a new challenge.
- [session.ts](src/auth/session.ts) includes `aal` and `amr` in newly issued and refreshed tokens. It
  also adds `user.factors`, which the JavaScript client's `listFactors()` reads.
- [schema.ts](src/auth/schema.ts) adds the tables to the desired auth schema so later migrations retain
  them. [migration.ts](src/auth/migration.ts) adds the reuse-tracking column to existing MFA tables.

## Scope and checks

Guest accounts cannot enroll. If an account already has a verified factor, its session needs `aal2`
to enroll or first verify another. At sign-in, any existing verified factor can establish `aal2`.

Each challenge lasts five minutes and is invalidated after five wrong codes. Only one challenge
per factor is stored: creating another replaces it and resets the attempt count. There is no
request rate limit. Secrets are stored in clear text; QR generation, factor removal, and phone
factors are not implemented.

[Tests](test.ts) check codes calculated independently of the implementation, concurrent verification,
refresh, and upgrades of existing tables. [patch.ts](patch.ts) connects the feature to the bundle;
its helpers and schema work independently of the other patches.

## Try it

From the project root, after `npm ci`:

```bash
npm run repro -- mfa-totp
```

[How to compare the published and patched builds](../../README.md#run-the-project).
