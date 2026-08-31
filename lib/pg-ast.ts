// Minimal Postgres AST node types — only the fields the patches touch.
//
// The field names match what the parser produces, which is also what survived minification: they are
// libpg_query data, not identifiers.

/** An opaque expression node: NullTest, A_Expr, BoolExpr and the rest. */
export type PgNode = Record<string, unknown>

/** Traversal context, passed along untouched. */
export type DeparseContext = Record<string, unknown>

export type IndexParam = { IndexElem?: PgNode } & PgNode

export interface IndexStmtNode {
   idxname?: string
   relation?: PgNode
   indexParams?: IndexParam[]
   unique?: boolean
   if_not_exists?: boolean
   /** Partial-index predicate: `CREATE INDEX ... WHERE <expression>`. */
   whereClause?: PgNode
}

/** Deparser methods the patches use. Class and method names survived minification. */
export interface Deparser {
   /** Dispatches on node type. */
   visit(node: PgNode, context: DeparseContext): string
   /** The method FIX-001 wraps, renamed by the patcher. */
   IndexStmtOriginal(node: IndexStmtNode, context: DeparseContext): string
   RangeVar(node: PgNode, context: DeparseContext): string
   IndexElem(node: PgNode, context: DeparseContext): string
}
