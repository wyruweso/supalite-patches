import type { Deparser, DeparseContext, IndexStmtNode } from '../../../../../lib/pg-ast.ts'

/**
 * `CREATE INDEX` → SQLite.
 *
 * The method assembled the statement from `unique`, `idxname`, `relation` and `indexParams` and never
 * looked at `node.whereClause`, which the parser does populate. SQLite is not the constraint —
 * partial indexes have worked since 3.8.0.
 *
 * A wrapper, since the whole defect is one missing suffix. Rebuilding the statement would mean owning
 * `IF NOT EXISTS`, the quoting, the relation and the index elements for ever after.
 */
export function IndexStmt(this: Deparser, node: IndexStmtNode, context: DeparseContext): string {
   const sql = this.IndexStmtOriginal(node, context)
   if (!node.whereClause) return sql

   // A predicate is an ordinary expression node, so compound conditions work without extra code.
   // A construct the visitor cannot handle raises rather than vanishing.
   const predicate = this.visit(node.whereClause, context)
   return predicate ? `${sql} WHERE ${predicate}` : sql
}
