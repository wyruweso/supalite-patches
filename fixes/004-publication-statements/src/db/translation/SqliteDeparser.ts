interface Deparser {
   visitOriginal(node: unknown, context: unknown): string
}

/**
 * Omit publication AST nodes, which have no SQLite equivalent.
 * Parsing still rejects malformed SQL and distinguishes statements from quoted text.
 */
export function visit(this: Deparser, node: unknown, context: unknown): string {
   if (isPublicationStatement(node)) return ''
   return this.visitOriginal(node, context)
}

function isPublicationStatement(node: unknown): boolean {
   if (!node || typeof node !== 'object') return false

   const nodeType = Object.keys(node)[0]
   const body = (node as Record<string, Record<string, unknown> | undefined>)[nodeType]

   // CREATE and ALTER have a node type of their own. DROP, RENAME and OWNER share theirs with every
   // other kind of database object, so for those the object type has to be read.
   switch (nodeType) {
      case 'CreatePublicationStmt':
      case 'AlterPublicationStmt':
         return true
      case 'DropStmt':
         return body?.removeType === PUBLICATION_OBJECT_TYPE
      case 'RenameStmt':
         return body?.renameType === PUBLICATION_OBJECT_TYPE
      case 'AlterOwnerStmt':
         return body?.objectType === PUBLICATION_OBJECT_TYPE
      default:
         return false
   }
}

const PUBLICATION_OBJECT_TYPE = 'OBJECT_PUBLICATION'
