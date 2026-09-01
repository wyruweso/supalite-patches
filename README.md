# supalite-patches

Readable patches for [`@supabase/lite`](https://www.npmjs.com/package/@supabase/lite) `0.9.0`, spliced
into the published bundle: five defect fixes and three capabilities its authors list as unimplemented.

Each patch is proven the same way — its assertions **fail on the package from npm and pass with the
patch applied** — and `pins/`, a suite describing what the published package does, must give the same
answer on both builds. So "nothing else changes" is a check, not a claim.

```
published   779/870 passed
patched     870/870 passed

PROVEN: 91 assertions fail on the published build and pass with the patches
UNTOUCHED: the other 779 assertions behave the same on both
```

```bash
npm i
npm test                   # both builds, compared
npm run verify             # typecheck, lint, then the comparison above
npm run repro              # what each patch is for, printed on a live build
npm run install:patches    # swap the bundle inside node_modules/@supabase/lite
npm run uninstall:patches
```

After `install:patches` the patched library is reachable through an ordinary
`import '@supabase/lite'`. The original is kept beside it, so rolling back needs no reinstall.

## What is patched

| fix     | defect ([details](FINDINGS.md))                                                  |
| ------- | -------------------------------------------------------------------------------- |
| FIX-001 | a partial index loses its `WHERE`, so the database rejects rows Postgres accepts |
| FIX-002 | every RLS refusal and constraint violation comes back as `500 SUP`               |
| FIX-003 | arrays and `jsonb` arrive as JSON strings, `boolean` as `0`/`1`                  |
| FIX-004 | publication statements are emitted mangled or refused, and kill the migration    |
| FIX-005 | triggers never reach the database through the migrator                           |

| feature  | capability          | their own estimate |
| -------- | ------------------- | ------------------ |
| FEAT-001 | `signInAnonymously` | planned, `S`       |
| FEAT-002 | admin users API     | planned, `M`       |
| FEAT-003 | TOTP second factor  | planned, `M`       |

The features come from the package's own `FEATURES.md`, picked for being marked planned rather than
infeasible, carrying no blocker, and being visible over HTTP so they can be demonstrated.

FIX-004 accepts publication statements for schema compatibility and ignores them; it does **not**
implement Supabase Realtime. SQLite has no logical replication for a publication to mean anything in,
so the point is that a schema exported from a project using Realtime migrates instead of dying on the
lines that configure it.

## One directory per patch

```
fixes/002-client-errors-as-500/
   patch.ts                  where in the bundle, and which assertions must diverge
   src/server/data.ts        the readable code, at the path its target occupies
   test.ts                   asserts the CORRECT behaviour, so it fails on the published build
   repro.ts                  prints the defect on a live build
```

`src/server/data.ts` is the artefact to review: an ordinary TypeScript file at the path its target
occupies in the source tree. `lib/patcher.ts` takes the exported function from it and splices it into
the minified bundle — there is no patch code inside the patcher.

A reproduction derives its verdict from what it observed, so the same script reads `AS DESCRIBED` on
the published build and `DIFFERS` on the patched one.

`pins/` holds the rest of the suite: 775 assertions describing the published package as it is,
defects included. They are not there to pass — they are there to stay identical across both builds,
so a patch that reached further than its own directory shows up as a diverging assertion nobody
declared.

## How a patch works

**Finding the place.** What survived minification decides what can be searched for — class method
names, field and object keys and string literals did; function, variable and parameter names did not.
So a patch names its target structurally (`methodNamed('IndexStmt', 'IndexElem')`,
`functionWithText('42P17')`, `functionReturningObject([...])`), and an anchor matching anything other
than exactly one candidate fails the build.

**Substituting names.** The readable code calls `quoteIdentifier`; the bundle calls it `Qo`. Nothing is
hardcoded: parameters map positionally, module functions are found by a characteristic call, and a
module variable is recovered from the literal beside it in a call. An error factory is the exception
that is found by its message instead — it is called from everywhere, so there is no one call to read
its name off, and raising the library's own error is what puts a 400 where a 500 would otherwise be.

**Splicing.** Only the body of the located function is replaced, so the other 500 KB come through byte
for byte — which is what makes "this patch touched nothing else" a real check rather than a formality.
`wrapFunction` and `wrapMethod` rename the original and put a short wrapper in its place, for a small
change to a large function; wrappers stack, and `plan` is wrapped by both FIX-001 and FIX-005.

**Data, not only code.** Some of what the library is, is a string: the auth schema is one long DDL
constant, and a feature needing a table has to put it there. A table created any other way exists on
the live database and is absent from the schema the migrator builds to compare against, so the next
migration plans to drop it. `appendToConstant` finds that constant by something it contains and
re-quotes it from its own parsed value; an interpolated template is refused rather than mangled.

**What it refuses.** Renaming is by name rather than by binding, because some names are free — declared
in the patch, defined by the bundle. `test/patcher.test.ts` pins the three guards that buys: a
reference to something outside the patch, a parameter count that no longer matches, and **capture**,
where a name renamed into the body collides with one the patch declared itself.

## Patches are independent

Every `patch.ts` is a plain `apply(source) => source`, so any subset works in any order: each anchor
searches the text it is given, and a patch applied second finds its place in a bundle the first has
already changed. Verified both ways round.

## Version compatibility

Verified against `0.9.0` and `0.9.1-next.1`; any other version is refused by name rather than failing
somewhere inside Babel.

`0.9.1-next.1` appeared while this was being written, which made it an unplanned test of the design:
**all eight patches found their places in a build they were not written for**, and every assertion
passed there — including the two that add routes. A textual anchor would not have survived the
rebuild. None of the defects is fixed upstream, and none of the capabilities exists there.

## Licence

Apache-2.0, the same licence as `@supabase/lite` itself. The parts that replace, wrap or characterise
the package are derivative works of it, and `NOTICE` says which and credits Supabase. The published
package is not redistributed here: it is installed from npm, patched in place, and the patched build
stays local.
