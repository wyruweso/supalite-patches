interface Deparser {
   visitOriginal(node: unknown, context: unknown): string
}

/**
 * Nodes that mean nothing in SQLite and should disappear rather than reach the output. Publications
 * are Postgres logical replication; in Supabase they enable Realtime on a table.
 *
 * `AlterPublicationStmt` covers ADD, SET, DROP and the rest, so naming the type covers the variants.
 */
const IGNORED_STATEMENTS = new Set(['CreatePublicationStmt', 'AlterPublicationStmt'])

/**
 * The deparser's dispatch by node type.
 *
 * A wrapper rather than an edit to UNSUPPORTED_TYPES, a module object with nowhere to splice into —
 * and the same mechanism upstream used in 0.9.1-next.1 to fix CREATE EXTENSION.
 */
export function visit(this: Deparser, node: unknown, context: unknown): string {
   if (!node || typeof node !== 'object') return this.visitOriginal(node, context)

   // The node type is the object's only key, as the library itself reads it.
   const [type] = Object.keys(node)
   if (IGNORED_STATEMENTS.has(type)) return ''

   // The third statement of the family has no node type of its own: `DROP PUBLICATION` parses as an
   // ordinary DropStmt with `removeType: 'OBJECT_PUBLICATION'`, so only that removeType is matched —
   // ignoring DropStmt wholesale would swallow every drop in the schema.
   //
   // Unlike the other two, this one throws rather than mangles, since `DropStmt` raises for anything
   // but TABLE, VIEW, INDEX, TRIGGER and POLICY. The empty string returned here is what a dropped
   // policy already gets.
   //
   // It is also the statement most likely to be met first: the canonical Supabase Realtime snippet
   // opens with `drop publication if exists supabase_realtime`.
   if (type === 'DropStmt' && (node as { DropStmt?: { removeType?: unknown } }).DropStmt?.removeType === PUBLICATION) {
      return ''
   }

   return this.visitOriginal(node, context)
}

/** libpg_query spells the object kind as a plain string, and the library compares it as one. */
const PUBLICATION = 'OBJECT_PUBLICATION'
