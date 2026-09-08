interface SqliteConnection {
   config: { ddlDialect?: string }
   introspectBeforeDialectDefault(options?: unknown): Promise<unknown>
   deserializeRowBeforeDialectDefault(row: unknown): unknown
}

/**
 * `ddlDialect` decides whether the Postgres metadata collected during translation is merged back
 * into the introspection, and whether a row is deserialised through it. The constructor never gives
 * it a default, so it is `undefined` for every connection created without one and both checks are
 * false — while two lines below the merge the same value is reported as
 * `ddl_dialect: this.config.ddlDialect ?? 'postgres'`. The schema says one thing and the branch
 * beside it decides another.
 *
 * The declared types are therefore not lost, only unreachable, which is why this needs no inference:
 * `createConnection({ url, ddlDialect: 'postgres' })` on the published build already answers with
 * arrays, objects and booleans.
 *
 * A constructor cannot be wrapped — there is no way to run before it and change what it passes to
 * `super` — so the default is applied at the two methods that read the flag. `??=` means whichever
 * runs first settles it for the connection, which is what a constructor default would have done.
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
