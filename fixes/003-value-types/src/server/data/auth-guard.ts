/** The original type resolution: `pg_type`, else the physical type, plus CAST parsing in views. */
declare function resolveColumnSemanticType(column: IntrospectedColumn, introspection: Introspection): string

interface IntrospectedColumn {
   name: string
   table: string
   schema?: string
   type: string
   nullable?: boolean
   default_value?: unknown
   is_primary_key?: boolean
   is_identity?: boolean
   is_generated?: boolean
}

interface Introspection {
   tables: { name: string; schema?: string; sql?: string }[]
}

/**
 * Describes a column so a field class can be chosen for it.
 *
 * `pgTypeName` decides serialization, and on the response path it was wrong: introspection reads the
 * schema from SQLite, where only physical types remain, so columns got TextField and IntegerField
 * instead of ArrayField, JsonField and BooleanField. Storage is lossless, but the client receives the
 * characters of the JSON and `row.ok === true` is never true.
 */
export function describeColumn(column: IntrospectedColumn, introspection: Introspection) {
   return {
      schema: column.schema || 'public',
      table: column.table,
      column: column.name,
      // The fix: recover the declared type first, fall back to the physical one.
      pgTypeName: declaredTypeFromChecks(column, introspection) ?? resolveColumnSemanticType(column, introspection),
      nullable: column.nullable,
      defaultValue: column.default_value ?? null,
      isPrimaryKey: column.is_primary_key,
      isUnique: false,
      isSerial: !!column.is_identity,
      isGenerated: column.is_generated,
   }
}

/**
 * Recovers the declared Postgres type from the CHECK constraints the DDL translator wrote itself.
 *
 * Not guessed from the data: the library adds a characteristic check per type, and that check is the
 * only surviving trace of the original type in `sqlite_master`.
 *
 *   boolean   CHECK (ok IN (0, 1))
 *   jsonb     CHECK (meta IS NULL OR json_valid(meta))
 *   text[]    CHECK (tags IS NULL OR (json_valid(tags) AND json_type(tags) = 'array'))
 *
 * `resolveColumnSemanticType` already reads types out of SQL the same way, from `CAST(... AS ...)`
 * in a view's text.
 *
 * Known limit: the element type of an array is not in the check, so `int[]` and `text[]` are
 * indistinguishable. It does not show in the output, since elements arrive from JSON already typed.
 */
function declaredTypeFromChecks(column: IntrospectedColumn, introspection: Introspection): string | null {
   const schema = column.schema || 'public'
   const table = introspection.tables.find((t) => t.name === column.table && (t.schema || 'public') === schema)
   if (!table?.sql) return null

   const compact = table.sql.replace(/\s+/g, ' ').toLowerCase()
   const name = column.name.toLowerCase()

   // Order matters: the array check contains json_valid.
   if (mentions(compact, `json_type(${name}) = 'array'`)) return 'text[]'
   if (mentions(compact, `json_valid(${name})`)) return 'jsonb'
   if (mentions(compact, `${name} in (0, 1)`)) return 'boolean'
   return null
}

/**
 * The check text, found where it starts a name rather than ends someone else's. A plain `includes`
 * is reachably wrong: `book_k in (0, 1)` contains `k in (0, 1)`, so a column `k` beside a boolean
 * `book_k` came back as `true` instead of `1`. Only the boolean check lacks a bounding `(`, so each
 * occurrence is checked for what precedes it.
 */
function mentions(compact: string, check: string): boolean {
   for (let at = compact.indexOf(check); at >= 0; at = compact.indexOf(check, at + 1)) {
      const before = compact[at - 1]
      if (before === undefined || !/[a-z0-9_$"]/.test(before)) return true
   }
   return false
}
