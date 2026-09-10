import type { Deparser, DeparseContext, IndexStmtNode } from '../../../../../lib/pg-ast.ts'

/** Append the missing WHERE clause; keep the original quoting and index options. */
export function IndexStmt(this: Deparser, node: IndexStmtNode, context: DeparseContext): string {
   const sql = this.IndexStmtOriginal(node, context)
   if (!node.whereClause) return sql

   // A predicate is an ordinary expression node, so compound conditions work without extra code, and
   // a construct the visitor cannot handle raises rather than vanishing.
   const predicate = this.visit(node.whereClause, context)

   // No expression is known to deparse to nothing, but were one to, the statement would silently
   // become a global index — the exact defect this patch exists to close.
   if (!predicate) throw new Error(`Index predicate deparsed to nothing: ${JSON.stringify(node.whereClause)}`)

   return `${sql} WHERE ${predicate}`
}
