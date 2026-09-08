interface SqliteConnection {
   normalizeDbErrorOriginal(err: unknown): unknown
}

/**
 * SQLite's extended result code for each constraint kind, and the SQLSTATE Postgres raises for the
 * same refusal. The numbers are part of SQLite's compatibility contract, so they can be matched on.
 */
const SQLSTATE_BY_ERRCODE: Record<number, string> = {
   275: '23514', // SQLITE_CONSTRAINT_CHECK
   787: '23503', // SQLITE_CONSTRAINT_FOREIGNKEY
   1299: '23502', // SQLITE_CONSTRAINT_NOTNULL
   1555: '23505', // SQLITE_CONSTRAINT_PRIMARYKEY
   2067: '23505', // SQLITE_CONSTRAINT_UNIQUE
}

// SQLITE_CONSTRAINT_DATATYPE (3091) is deliberately absent. It is raised both for a value of the
// wrong type for its column, where 400 would be right, and for a type the library does not serialise
// at all — `bytea`, where Postgres accepts `\x48656c6c6f` and answers 201, so neither 400 nor the
// present 500 is the correct answer. Mapping it would dress a missing conversion as bad input, and
// telling the two apart here would mean reading the message, which is what this patch exists to stop.

/**
 * A driver error to an SQLSTATE, which is what the whole error ladder above dispatches on.
 *
 * The original recognises better-sqlite3's shape, where the constraint is a string in `code`
 * (`SQLITE_CONSTRAINT_UNIQUE` and so on). This package's driver is `node:sqlite`, which puts
 * `ERR_SQLITE_ERROR` there and the constraint in a numeric `errcode`, so no branch matched and every
 * constraint violation arrived at the mapper uncoded — and left it as a `500 SUP`.
 */
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
