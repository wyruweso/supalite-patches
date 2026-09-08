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

export async function introspect(
   this: SqliteConnection,
   options?: { useCache?: boolean; postprocess?: boolean },
): Promise<Introspection> {
   const introspection = await this.introspectOriginal(options)
   if (!introspection?.indexes?.length) return introspection

   // `pragma_index_list` and `pragma_index_info` do not report a predicate, so it has to be read
   // back out of the statement. One query per introspection, not per index.
   const indexDefinitions =
      (await this.exec("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")).rows ?? []

   const predicateByIndexName = new Map<string, string>()
   for (const definition of indexDefinitions) {
      const predicate = extractIndexPredicate(definition.sql)
      if (predicate) predicateByIndexName.set(definition.name, predicate)
   }

   for (const index of introspection.indexes) index.where = predicateByIndexName.get(index.name) ?? null
   return introspection
}

/**
 * Pulls the predicate out of `CREATE [UNIQUE] INDEX name ON table (…) WHERE …`.
 *
 * The filter's `WHERE` has to be told apart from any other, and there are two ways to meet one that
 * is not it: inside quoted text or a comment, and inside the words before the indexed expressions —
 * `CREATE INDEX індексWHERE ON t (a)` names an index, not a predicate. So the filter is only looked
 * for after the list of indexed expressions has closed, and quoted runs and comments are skipped
 * whole. Not a parser: it only needs to know where it is, not what it is reading.
 */
function extractIndexPredicate(sql: string | null): string | null {
   if (!sql) return null

   let parenthesisDepth = 0
   let indexColumnsClosed = false

   for (let i = 0; i < sql.length; i++) {
      const char = sql[i]

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

      if (char === '(') {
         parenthesisDepth++
      } else if (char === ')') {
         parenthesisDepth--
         if (parenthesisDepth === 0) indexColumnsClosed = true
      } else if (indexColumnsClosed && parenthesisDepth === 0 && isWhereAt(sql, i)) {
         return (
            sql
               .slice(i + 5)
               .trim()
               .replace(/;$/, '') || null
         )
      }
   }
   return null
}

/** The index of the closing delimiter, or the end of the string. */
function skipTo(sql: string, from: number, closing: string): number {
   const end = sql.indexOf(closing, from)
   return end < 0 ? sql.length : end
}

/** `WHERE` at this position, as a whole word. The boundary is Unicode-aware: SQLite identifiers are. */
function isWhereAt(sql: string, i: number): boolean {
   if (sql.slice(i, i + 5).toUpperCase() !== 'WHERE') return false
   return !isWordCharacter(sql[i - 1]) && !isWordCharacter(sql[i + 5])
}

// Declared once rather than inside the test below: the patcher moves top-level declarations into the
// function it splices, so a literal here is built per call rather than per character.
const WORD_CHARACTER = /[\p{L}\p{N}_$]/u

function isWordCharacter(char: string | undefined): boolean {
   return char !== undefined && WORD_CHARACTER.test(char)
}
