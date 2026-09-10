interface SqliteConnection {
   config: { ddlDialect?: string }
   introspectBeforeDialectDefault(options?: unknown): Promise<unknown>
   deserializeRowBeforeDialectDefault(row: unknown): unknown
}

/**
 * The missing postgres default skips metadata merging and row deserialization.
 * The patcher cannot wrap a constructor, so set the default at both readers of the flag.
 */
function defaultDialect(connection: SqliteConnection): void {
   connection.config.ddlDialect ??= 'postgres'
}

export async function introspect(this: SqliteConnection, options?: unknown): Promise<unknown> {
   defaultDialect(this)
   return this.introspectBeforeDialectDefault(options)
}

export function deserializeRow(this: SqliteConnection, row: unknown): unknown {
   defaultDialect(this)
   return this.deserializeRowBeforeDialectDefault(row)
}
