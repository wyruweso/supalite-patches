interface SqliteConnection {
   normalizeDbErrorOriginal(err: unknown): unknown
}

/** SQLite extended constraint codes mapped to their PostgreSQL SQLSTATE equivalents. */
const SQLSTATE_BY_ERRCODE: Record<number, string> = {
   275: '23514', // SQLITE_CONSTRAINT_CHECK
   787: '23503', // SQLITE_CONSTRAINT_FOREIGNKEY
   1299: '23502', // SQLITE_CONSTRAINT_NOTNULL
   1555: '23505', // SQLITE_CONSTRAINT_PRIMARYKEY
   2067: '23505', // SQLITE_CONSTRAINT_UNIQUE
}

// 3091 (DATATYPE) also covers missing bytea conversion, where valid input should succeed.
// Leave it unmapped rather than report every conversion failure as bad input.

/** Read node:sqlite's numeric errcode before delegating to the original error normalizer. */
export function normalizeDbError(this: SqliteConnection, err: unknown): unknown {
   const normalised = this.normalizeDbErrorOriginal(err)

   // The original builds a new error for everything it recognises and returns its argument when it
   // recognises nothing, so identity is the question to ask — never the message.
   if (normalised !== err) return normalised

   // An error that already carries a code of its own is somebody else's, correctly formed.
   const code = codeOf(err)
   if (typeof code === 'string' && code !== 'ERR_SQLITE_ERROR') return normalised

   const errcode = errcodeOf(err)
   const sqlstate = typeof errcode === 'number' ? SQLSTATE_BY_ERRCODE[errcode] : undefined
   if (!sqlstate) return normalised

   const message = messageOf(err)
   return Object.assign(new Error(message), { code: sqlstate, detail: message })
}

// The driver wraps its error, so the fields are read through `cause` first — as the original reads
// `code` and `message`.
function codeOf(err: unknown): unknown {
   const error = err as { code?: unknown; cause?: { code?: unknown } }
   return error?.cause?.code ?? error?.code
}

function errcodeOf(err: unknown): unknown {
   const error = err as { errcode?: unknown; cause?: { errcode?: unknown } }
   return error?.cause?.errcode ?? error?.errcode
}

function messageOf(err: unknown): string {
   const error = err as { message?: unknown; cause?: { message?: unknown } }
   const message = error?.cause?.message ?? error?.message ?? String(err)
   return typeof message === 'string' ? message : String(message)
}
