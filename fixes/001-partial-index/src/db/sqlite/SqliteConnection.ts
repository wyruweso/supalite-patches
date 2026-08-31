interface IndexModel {
   name: string
   table: string
   unique: boolean
   columns: string[]
   schema: string
   /** Partial-index predicate. The field did not exist. */
   where?: string | null
}

interface Introspection {
   indexes: IndexModel[]
}

interface SqliteConnection {
   introspectOriginal(options?: { useCache?: boolean; postprocess?: boolean }): Promise<Introspection>
   exec(query: string): Promise<{ rows?: { name: string; sql: string | null }[] }>
}

/**
 * Reads the schema out of the database.
 *
 * The index model came from `pragma_index_list` and `pragma_index_info`, which do not report a
 * partial index's predicate — so the model had no `where` field, and the planner rebuilding
 * `CREATE INDEX` from it dropped the predicate even once the DDL translator emitted one.
 *
 * One place covers both sides of the comparison: `diff()` builds the desired schema by executing the
 * translated DDL into an in-memory SQLite and introspecting it with this same code.
 */
export async function introspect(
   this: SqliteConnection,
   options?: { useCache?: boolean; postprocess?: boolean },
): Promise<Introspection> {
   const introspection = await this.introspectOriginal(options)
   if (!introspection?.indexes?.length) return introspection

   // One query per introspection, not per index.
   const rows =
      (await this.exec("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")).rows ?? []

   const predicates = new Map<string, string>()
   for (const row of rows) {
      const predicate = predicateOf(row.sql)
      if (predicate) predicates.set(row.name, predicate)
   }

   for (const index of introspection.indexes) index.where = predicates.get(index.name) ?? null
   return introspection
}

/**
 * Pulls the predicate out of `CREATE INDEX … WHERE …`.
 *
 * `sqlite_schema.sql` keeps the statement roughly as written, so the filter's `WHERE` has to be told
 * apart from any other — and a regular expression cannot, since the word appears as happily inside a
 * string literal, a quoted identifier or a comment:
 *
 *   CREATE INDEX i ON t (note || ' WHERE ') WHERE a > 0
 *
 * So this walks the statement, skipping anything a `WHERE` inside cannot be the filter of. Not a
 * parser: it only needs to know where it is, not what it is reading.
 */
function predicateOf(sql: string | null): string | null {
   if (!sql) return null

   let depth = 0
   for (let i = 0; i < sql.length; i++) {
      const char = sql[i]

      // Anything quoted is skipped whole. SQLite escapes by doubling, which needs no special case:
      // the closing quote ends the run and the next one opens another.
      if (char === "'" || char === '"' || char === '`') {
         i = skipTo(sql, i + 1, char)
         continue
      }
      if (char === '[') {
         i = skipTo(sql, i + 1, ']')
         continue
      }
      if (char === '-' && sql[i + 1] === '-') {
         const end = sql.indexOf('\n', i)
         i = end < 0 ? sql.length : end
         continue
      }
      if (char === '/' && sql[i + 1] === '*') {
         const end = sql.indexOf('*/', i + 2)
         i = end < 0 ? sql.length : end + 1
         continue
      }

      if (char === '(') depth++
      else if (char === ')') depth--
      // Only at the top level: the index elements are parenthesised, and the filter never is.
      else if (depth === 0 && isWhereAt(sql, i))
         return (
            sql
               .slice(i + 5)
               .trim()
               .replace(/;$/, '') || null
         )
   }
   return null
}

/** The index of the closing delimiter, or the end of the string. */
function skipTo(sql: string, from: number, closing: string): number {
   const end = sql.indexOf(closing, from)
   return end < 0 ? sql.length : end
}

/** `WHERE` at this position, as a whole word. */
function isWhereAt(sql: string, i: number): boolean {
   if (sql.slice(i, i + 5).toUpperCase() !== 'WHERE') return false
   const before = sql[i - 1]
   const after = sql[i + 5]
   return (i === 0 || !/[A-Za-z0-9_$]/.test(before)) && (after === undefined || !/[A-Za-z0-9_$]/.test(after))
}
