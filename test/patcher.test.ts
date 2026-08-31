// The patcher's own guards, on a bundle small enough to read.
//
// Every other test here asks whether a patch behaves correctly. These ask whether the machinery
// refuses what it cannot do safely, which end-to-end testing never shows: a guard that never fires
// and a guard that does not exist look identical.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendToConstant, functionWithText, moduleFunctionWithText, replaceFunction } from '../lib/patcher.ts'

// A minified-looking bundle: single-letter parameters, exactly as esbuild leaves them.
const BUNDLE = 'function Qx(e, t) { return t.rows.find((r) => r.name === e) ?? "no such column" }'

const dir = mkdtempSync(join(tmpdir(), 'patcher-'))
let n = 0
const patchFile = (source: string): URL => {
   const path = join(dir, `patch-${n++}.ts`)
   writeFileSync(path, source)
   return pathToFileURL(path)
}

const applyTo = (source: string) =>
   replaceFunction(BUNDLE, {
      at: functionWithText('no such column'),
      replacement: patchFile(source),
      exported: 'describeColumn',
   })

describe('patcher guards', () => {
   // Parameters map positionally, so `introspection` becomes `t`. A `t` of the patch's own in the
   // same scope would then be the same variable, silently.
   test('a local name colliding with a renamed parameter is refused', () => {
      assert.throws(
         () =>
            applyTo(`export function describeColumn(name: string, introspection: any) {
               const t = 1
               return introspection.rows.find((r: any) => r.name === name) ?? t
            }`),
         /capture/i,
      )
   })

   // The same name in a scope the renaming never reaches is not a capture, and refusing it would
   // make single-letter helper parameters unusable — which is most of them.
   test('the same name in a disjoint scope is allowed', () => {
      const out = applyTo(`export function describeColumn(name: string, introspection: any) {
         return pick(introspection, name)
      }

      function pick(rows: any, name: string) {
         return rows.rows.find((t: any) => t.name === name) ?? null
      }`)
      assert.match(out, /function pick/)
      assert.match(out, /t\.name === name/)
   })

   // A name the patch reaches for that exists only in the patch's own module would be a
   // ReferenceError inside someone else's library.
   test('a reference to something outside the patch is refused', () => {
      assert.throws(
         () =>
            applyTo(`export function describeColumn(name: string, introspection: any) {
               return SOMETHING_ELSE + name + introspection
            }`),
         /free names/i,
      )
   })

   test('a parameter count that does not match the bundle is refused', () => {
      assert.throws(() => applyTo('export function describeColumn(name: string) { return name }'), /parameters/)
   })

   // The other bindings read a name off a call the target function makes. An error factory is called
   // from everywhere and nowhere in particular, so it is found by its message — and the name that
   // comes back has to be the one it is bound to, not the one it is called by.
   test('an error factory is found by its message, through the whole program', () => {
      const bundle =
         'var ct=()=>new $(400,"invalid_credentials","Invalid login credentials");' +
         'function Qx(e, t) { return t.rows.find((r) => r.name === e) ?? "no such column" }'
      const out = replaceFunction(bundle, {
         at: functionWithText('no such column'),
         replacement: patchFile(`declare function invalidCredentials(): Error
            export function describeColumn(name: string, introspection: any) {
               if (!introspection) throw invalidCredentials()
               return name
            }`),
         exported: 'describeColumn',
         bind: { invalidCredentials: moduleFunctionWithText('Invalid login credentials') },
      })
      assert.match(out, /throw ct\(\)/)
   })

   test('a message shared by two factories is refused', () => {
      assert.throws(
         () =>
            replaceFunction('var a=()=>"same";var b=()=>"same";' + BUNDLE, {
               at: functionWithText('no such column'),
               replacement: patchFile(`declare function shared(): Error
                  export function describeColumn(name: string, introspection: any) {
                     if (!introspection) throw shared()
                     return name
                  }`),
               exported: 'describeColumn',
               bind: { shared: moduleFunctionWithText('same') },
            }),
         /found 2, expected 1/,
      )
   })

   // Some of a library is data: the auth schema is one long DDL string, and a feature needing a
   // table has to put it there rather than create it on the side.
   test('text is appended to the constant that contains a marker', () => {
      const out = appendToConstant('const a = "CREATE TABLE users (id text)"; const b = "other"', {
         containing: 'CREATE TABLE users',
         addition: '; CREATE TABLE more (id text)',
      })
      assert.match(out, /CREATE TABLE users \(id text\); CREATE TABLE more/)
      assert.match(out, /const b = "other"/)
   })

   test('an ambiguous marker is refused', () => {
      assert.throws(
         () => appendToConstant('const a = "same"; const b = "same"', { containing: 'same', addition: '!' }),
         /found 2, expected 1/,
      )
   })

   // Replacing an interpolated template would mean evaluating it, so it is refused instead.
   test('an interpolated template is refused', () => {
      assert.throws(
         () => appendToConstant('const a = `x ${y} CREATE TABLE t`', { containing: 'CREATE TABLE t', addition: '!' }),
         /interpolated/,
      )
   })
})
