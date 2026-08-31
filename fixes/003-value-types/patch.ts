// FIX-003 — arrays, jsonb and boolean come back in the wrong types.  FINDINGS #5, #6
//
//   tags  →  "[\"a\",\"b\"]"   instead of  ["a","b"]
//   meta  →  "{\"x\":1}"       instead of  {"x":1}
//   ok    →  1                 instead of  true
//
// Not a deserializer problem: ArrayField, JsonField and BooleanField are all correct. The column is
// matched to the wrong field class, because introspection reads the schema from SQLite, where
// `text[]` and `jsonb` are indistinguishable from TEXT and `boolean` from INTEGER.
import { functionReturningObject, replaceFunction, soleCalleeWithArity } from '../../lib/patcher.ts'

export const id = 'FIX-003'
export const title = 'arrays, jsonb and boolean come back in their Postgres types'

export const expectedDivergence = [
   'FIX-003 values come back in their Postgres types',
   'FIX-003 values come back in their Postgres types > a text[] column is an array, not the characters of one',
   'FIX-003 values come back in their Postgres types > an int[] column keeps its numbers as numbers',
   'FIX-003 values come back in their Postgres types > a jsonb column is an object',
   'FIX-003 values come back in their Postgres types > a boolean column is true, not 1',
   'FIX-003 values come back in their Postgres types > the round trip is still lossless',
   'FIX-003 values come back in their Postgres types > a column does not borrow the type of one whose name ends with its own',
]

export function apply(source: string): string {
   return replaceFunction(source, {
      // The name is gone, but the returned object's keys are data. No other function returns this set.
      at: functionReturningObject([
         'schema',
         'table',
         'column',
         'pgTypeName',
         'nullable',
         'defaultValue',
         'isPrimaryKey',
         'isUnique',
         'isSerial',
         'isGenerated',
      ]),
      replacement: new URL('./src/server/data/auth-guard.ts', import.meta.url),
      exported: 'describeColumn',
      // The only two-argument call is the type resolution we keep as the fallback.
      bind: { resolveColumnSemanticType: soleCalleeWithArity(2) },
   })
}
