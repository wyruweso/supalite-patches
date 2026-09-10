// FIX-002: map node:sqlite constraint codes to SQLSTATE, then handle uncaught RLS and CHECK errors.
import { functionWithText, methodNamed, soleCalleeWithArity, wrapFunction, wrapMethod } from '../../lib/patcher.ts'

export const id = 'FIX-002'
export const title = 'RLS refusals and constraint violations stop being 500s'

export const expectedDivergence = [
   'FIX-002 client errors are not reported as server faults',
   'FIX-002 client errors are not reported as server faults > an insert refused for want of a policy is a 42501, not a 500',
   'FIX-002 client errors are not reported as server faults > an unnamed CHECK violation is a 400, not a 500',
   'FIX-002 client errors are not reported as server faults > an invalid date is a 400 too',
   'FIX-002 client errors are not reported as server faults > a dangling foreign key is a 409, not a 500',
   'FIX-002 client errors are not reported as server faults > a duplicate primary key is a 409, not a 500',
   'FIX-002 client errors are not reported as server faults > a NOT NULL violation is a 400, not a 500',
   'FIX-002 client errors are not reported as server faults > a duplicate value in a UNIQUE column is a 409 too',
   'FIX-002 client errors are not reported as server faults > an anonymous caller refused for want of a policy is a 401',
   'FIX-002 client errors are not reported as server faults > normalizeDbError',
   'FIX-002 client errors are not reported as server faults > normalizeDbError > a node:sqlite constraint error is given its SQLSTATE',
   // The other two normalizeDbError tests are not declared: the published build leaves those errors
   // alone too, for want of any branch rather than by the rule this patch adds. They guard the rule.
]

export function apply(source: string): string {
   const patched = wrapMethod(source, {
      at: methodNamed('normalizeDbError', 'normalizeBindParams'),
      replacement: new URL('./src/db/sqlite/SqliteConnection.ts', import.meta.url),
      exported: 'normalizeDbError',
      originalAs: 'normalizeDbErrorOriginal',
   })

   return wrapFunction(patched, {
      // The name is gone, but 42P17 is emitted from this error mapper and nowhere else.
      at: functionWithText('42P17'),
      replacement: new URL('./src/server/data.ts', import.meta.url),
      exported: 'handlePostgrestError',
      // The response builder is the only function the mapper calls with five arguments.
      bind: { pgrstError: soleCalleeWithArity(5) },
   })
}
