# supalite-patches

Five fixes and three features for [`@supabase/lite`](https://www.npmjs.com/package/@supabase/lite),
with readable TypeScript, reproductions, and tests against the published bundle.

The patches are applied to the bundled JavaScript. Each change has its own implementation, tests,
and reproduction script, so it can be reviewed without reading the minified bundle.

- [Fixes: symptoms, causes, and changes](FINDINGS.md)
- [Additional findings, ordered by impact](ADDITIONAL_FINDINGS.md)
- [How to review a patch](#reviewing-a-patch)

## Run the project

Requires **Node.js 24+**. The dependency is pinned to **`@supabase/lite@0.9.0`**.

```bash
npm ci
npm run verify
```

Verification runs typecheck, lint, patcher tests, and a comparison of the published and patched
builds. Tests for the fixes and features intentionally fail on the published build. They must pass
after patching, and all other test outcomes must agree.

| Command                          | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `npm test`                       | Compare published and patched behavior                  |
| `npm run verify`                 | Run all checks, including the comparison                |
| `npm run repro`                  | Run every reproduction against the installed build      |
| `npm run repro -- partial-index` | Run reproductions matching this directory-name fragment |
| `npm run build`                  | Write the patched bundle to `dist-patched/`             |
| `npm run install:patches`        | Replace the installed bundle, keeping a backup          |
| `npm run uninstall:patches`      | Restore the published bundle                            |

To see one fix before and after patching:

```bash
npm run repro -- partial-index
npm run install:patches
npm run repro -- partial-index
npm run uninstall:patches
```

While patches are installed, `import '@supabase/lite'` loads them. Uninstall before running
`npm test` or `npm run verify`: the comparison needs the published package as its baseline.

## Included changes

### Fixes

| Patch                                        | Change                                                              |
| -------------------------------------------- | ------------------------------------------------------------------- |
| [FIX-001](fixes/001-partial-index/)          | Preserve partial-index predicates through translation and migration |
| [FIX-002](fixes/002-client-errors-as-500/)   | Return client errors for RLS refusals and constraint violations     |
| [FIX-003](fixes/003-value-types/)            | Restore declared array, JSON, and boolean response types            |
| [FIX-004](fixes/004-publication-statements/) | Skip publication statements when importing schemas into SQLite      |
| [FIX-005](fixes/005-triggers-in-migration/)  | Migrate trigger changes and preserve triggers across table rebuilds |

[FINDINGS.md](FINDINGS.md) explains the causes, before/after behavior, and boundaries of each fix.
FIX-003 is already fixed upstream in `0.9.1-next.2` and later. FIX-004 supports schema import;
it does not implement Realtime.

### Features

| Feature                                     | Implemented scope                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| [FEAT-001](features/001-anonymous-sign-in/) | Anonymous sign-in, refreshable sessions, and `is_anonymous` claims                |
| [FEAT-002](features/002-admin-user-api/)    | Admin user listing, lookup, creation, hard deletion, and soft deletion            |
| [FEAT-003](features/003-mfa-totp/)          | TOTP enrollment, challenges, verification, factor listing, and `aal`/`amr` claims |

These capabilities were listed as planned in the package's `FEATURES.md`.

- **FEAT-001:** email verification converts an anonymous account to a permanent one.
- **FEAT-002:** soft deletion retains the id and replaces login identifiers with digests. User updates,
  bans, link generation, and MFA admin routes are outside its scope.
- **FEAT-003:** accounts with a verified factor require `aal2` to enroll or first verify another. Verification upgrades the
  current session to `aal2`, retains that level on refresh, and revokes other `aal1` sessions.
  Existing MFA tables are upgraded during `ensureSystemSchema()` without losing factors or challenges.

TOTP uses one pending challenge per factor, so a new challenge replaces the previous one. Attempts
are limited per challenge; there is no request rate limit. Secrets are stored in clear text.
Unenrollment, QR generation, and phone factors are not implemented.

## Reviewing a patch

Each fix and feature has its own `README.md`: start there for an example and a short explanation.
Then read `test.ts` or run `repro.ts` to see the behavior, and follow the links into `src/`.
Open `patch.ts` to see where the implementation is inserted into the bundle.

| File          | Contains                                                            |
| ------------- | ------------------------------------------------------------------- |
| `README.md`   | A plain-language explanation, example, and guide to the code        |
| `src/**/*.ts` | Replacement functions or wrappers at the reconstructed source paths |
| `test.ts`     | API-level tests for the change and its surrounding behavior         |
| `repro.ts`    | A runnable demonstration against the installed build                |
| `patch.ts`    | Bundle anchors, bindings, and expected test differences             |

[pins/](pins/) records other published behavior, including known defects. These tests must produce
the same outcomes before and after patching. Test names form the paths listed in
`expectedDivergence`; changing a name requires updating that list too.

Implementation helpers remain local to each fix or feature. [lib/](lib/) contains the patching
mechanism and AST types; [test/harness.ts](test/harness.ts) supplies shared test fixtures.

## How patches work

Each `patch.ts` exports `apply(source) => source`. The build applies all patches in directory order:
fixes first, then features. Each patch's suite has also been checked with only that patch applied.

[lib/patcher.ts](lib/patcher.ts) finds targets using AST names and literals that survive minification:
method names, sibling methods, object keys, and route paths. Each anchor must match exactly once.
It resolves bundle bindings and rejects missing references, parameter mismatches, and name collisions.

A patch replaces a function body or wraps the original function. `appendToConstant` extends the
library's auth DDL so its migrator retains added tables. Top-level helpers in a replacement file move
inside the inserted function and run on every call; allocating constants there has the same cost.

The comparison confirms the declared differences for the exercised cases. Its implementation is in
[test/run.ts](test/run.ts); the patcher's rejection cases are in [test/patcher.test.ts](test/patcher.test.ts).

## Version compatibility

| Package version                           | Status                                        |
| ----------------------------------------- | --------------------------------------------- |
| `0.9.0`                                   | Pinned dependency and test baseline           |
| `0.9.1-next.1`                            | Also accepted by the build and installer      |
| `0.9.1-next.2`, `0.10.0`, `0.10.1-next.2` | Reviewed separately; not enabled in the build |

[apply.ts](apply.ts) defines the accepted versions. Applying the patches to a newer bundle is not
sufficient to establish compatibility: newer versions change Storage bucket requirements, RLS,
and exposed schemas, and already include FIX-003. See [ADDITIONAL_FINDINGS.md](ADDITIONAL_FINDINGS.md)
for the rechecked findings and version-specific results.

## License

[Apache-2.0](LICENSE). [NOTICE](NOTICE) records Supabase attribution and identifies the derivative
parts. The published package is installed from npm; generated bundles stay local.
