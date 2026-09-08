# supalite-patches

Five bug fixes and three feature implementations for
[`@supabase/lite`](https://www.npmjs.com/package/@supabase/lite), with readable TypeScript,
reproductions, and tests against the published npm package.

The patches are applied to the bundled JavaScript. Each change has its own implementation, tests,
and reproduction script, so it can be reviewed without reading the minified bundle.

- [Fixes and their reproductions](FINDINGS.md)
- [Additional findings from the package review](ADDITIONAL_FINDINGS.md)
- [Patch implementation and validation](#how-patches-work)

## Run the project

Requires Node.js 24 or later. The dependency is pinned to `@supabase/lite@0.9.0`.

```bash
npm ci
npm test
```

`npm test` runs the suites against the published package and then against the same package with all
patches applied. It checks that the differences match those declared by each patch.

| Command                          | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `npm run verify`                 | Typecheck, lint, test the patcher, and compare both builds |
| `npm run repro`                  | Run all reproduction scripts against the installed build   |
| `npm run repro -- partial-index` | Run one reproduction, selected by its directory name       |
| `npm run build`                  | Write the patched bundle to `dist-patched/`                |
| `npm run install:patches`        | Apply all patches to the installed package                 |
| `npm run uninstall:patches`      | Restore the original package bundle                        |

To compare a reproduction before and after patching:

```bash
npm run repro -- partial-index
npm run install:patches
npm run repro -- partial-index
npm run uninstall:patches
```

While patches are installed, `import '@supabase/lite'` loads the patched build. The installer keeps
a backup of the original bundle. Run the comparison suite before installing patches or
after uninstalling them, so its baseline is the published package.

## Included changes

### Fixes

| Patch                                        | Change                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [FIX-001](fixes/001-partial-index/)          | Preserve partial-index `WHERE` clauses through translation, schema comparison, and migration planning |
| [FIX-002](fixes/002-client-errors-as-500/)   | Map unhandled RLS refusals and constraint violations to client errors                                 |
| [FIX-003](fixes/003-value-types/)            | Return arrays and `jsonb` as JSON values, and booleans as `true`/`false`                              |
| [FIX-004](fixes/004-publication-statements/) | Accept publication statements in imported schemas without generating invalid SQLite DDL               |
| [FIX-005](fixes/005-triggers-in-migration/)  | Include trigger additions, changes, and removals in migrations                                        |

The five patches address the eight defects described in [FINDINGS.md](FINDINGS.md). FIX-003 was also
fixed upstream in `0.9.1-next.2`.

FIX-002 converts the driver's error codes to SQLSTATE values, so the package's existing error mapping
answers them; it does not add a second mapping alongside it. `SQLITE_CONSTRAINT_DATATYPE` is left
out, and [FINDINGS.md](FINDINGS.md) records why.

FIX-004 skips publication statements after accepting them, across all five statement forms —
`CREATE`, `ALTER`, `DROP`, `RENAME TO` and `OWNER TO`. It supports importing a Supabase schema; it
does not implement Realtime or logical replication.

FIX-005 drops triggers before tables are rebuilt and recreates them afterwards. SQLite keeps a
trigger that references a rebuilt table, and validating the schema then fails the migration.

### Features

| Feature                                     | Implemented scope                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| [FEAT-001](features/001-anonymous-sign-in/) | Anonymous sign-in, refreshable sessions, and the `is_anonymous` claim            |
| [FEAT-002](features/002-admin-user-api/)    | Admin user listing, lookup, creation, and deletion                               |
| [FEAT-003](features/003-mfa-totp/)          | TOTP enrollment, challenge, verification, factor listing, and `aal`/`amr` claims |

These capabilities were listed as planned in the package's `FEATURES.md`. The admin implementation
does not include user updates, bans, link generation, or MFA admin routes. The TOTP implementation
does not include unenrollment, QR generation, or phone factors.

Two behaviors are worth naming, because they are security-relevant rather than optional:

- FEAT-002's soft delete replaces the user's identifiers with a digest, as GoTrue does, so a deleted
  address does not stay registered. It keeps the row and its id.
- FEAT-003 requires `aal2` to enroll or verify a further factor once one is verified. Without that
  check, a session holding only the password can enroll a factor of its own and reach `aal2`.

## Reviewing a patch

Each directory under `fixes/` or `features/` follows the same layout:

| File          | What to look for                                                               |
| ------------- | ------------------------------------------------------------------------------ |
| `src/**/*.ts` | The replacement or wrapper implementation, under the corresponding source path |
| `patch.ts`    | Where to apply it and which test outcomes are expected to change               |
| `test.ts`     | Behavior exercised through the package's API                                   |
| `repro.ts`    | A runnable example showing the change                                          |

Start with a patch's `src/` and `test.ts`. The [pins/](pins/) suites record other behavior of the
published package, including known defects. They help detect changes beyond those declared by the
patches.

## How patches work

[lib/patcher.ts](lib/patcher.ts) locates code using names and literals that survive minification,
such as class methods, neighboring methods, and route paths. An anchor must identify exactly one
target. The patcher resolves references to bundle symbols and checks for missing references,
parameter mismatches, and name collisions.

A patch can replace a function body or wrap the existing implementation. Schema additions use
`appendToConstant` to extend the library's auth DDL, so the migration system sees the new tables.
The patcher's own tests are in [test/patcher.test.ts](test/patcher.test.ts).

Top-level declarations in a patch's source move inside the function being spliced, so they are
evaluated on every call. Constants that allocate belong outside a hot path.

Each `patch.ts` exports `apply(source) => source`. The standard build and test commands apply the
full set. Each patch's own `test.ts` also passes with only that patch applied, which is how the
suites are kept from depending on one another; a custom subset or order beyond that needs its own
validation.

Passing the comparison suite confirms the declared differences for the cases it exercises. It does
not establish that every other behavior is unchanged.

## Version compatibility

| Package version | Status                                                                              |
| --------------- | ----------------------------------------------------------------------------------- |
| `0.9.0`         | Pinned dependency and baseline for the findings and tests                           |
| `0.9.1-next.1`  | Also accepted by the build and installer                                            |
| `0.9.1-next.2`  | Reviewed separately; not enabled in the build                                       |
| `0.10.0`        | Current `latest`; reviewed separately; not enabled in the build                     |
| `0.10.1-next.2` | Current `next`; reviewed separately; not enabled in the build                       |

[apply.ts](apply.ts) defines the accepted versions and rejects others.

All eight patches applied to each reviewed version without changes. `0.10.0` produced the same
comparison results as `0.9.1-next.2`, in the same bundle size, so the `0.9` to `0.10` change is the
storage rework below. Of the defects recorded here, `0.9.1-next.2` and later fix FIX-003 and
`CREATE EXTENSION` translation; the rest were still present when re-measured on `0.10.0`.

The reviewed versions also change storage: bucket creation requires both `id` and `name` and is
subject to RLS, and `storage` is no longer an exposed REST schema. These differ from the `0.9.0`
behavior recorded in `pins/`, which is why the newer versions are not enabled in the build.

## License

[Apache-2.0](LICENSE). [NOTICE](NOTICE) records attribution to Supabase and identifies the derivative
parts of this project. The published package is installed from npm; patched bundles stay local.
