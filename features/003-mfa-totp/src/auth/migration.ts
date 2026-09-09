interface Connection {
   dialect: string
   exec(sql: string): Promise<{ rows?: { name: string }[] }>
   clearSchemaCache(): Promise<void>
}

interface App {
   connection: Connection
   ensureSystemSchemaOriginal(options?: unknown): Promise<void>
}

/** CREATE TABLE IF NOT EXISTS leaves existing MFA tables unchanged. Upgrade them after schema setup. */
export async function ensureSystemSchema(this: App, options?: unknown): Promise<void> {
   await this.ensureSystemSchemaOriginal(options)

   const connection = this.connection
   if (connection.dialect !== 'sqlite') return

   const columns = await connection.exec("SELECT name FROM pragma_table_info('auth.mfa_factors')")
   if (!columns.rows?.length || columns.rows.some((column) => column.name === 'last_verified_step')) return

   try {
      await connection.exec('ALTER TABLE "auth.mfa_factors" ADD COLUMN last_verified_step INTEGER NOT NULL DEFAULT 0')
   } catch (error) {
      // Another connection may have added the column after our check.
      const current = await connection.exec("SELECT name FROM pragma_table_info('auth.mfa_factors')")
      if (!current.rows?.some((column) => column.name === 'last_verified_step')) throw error
   }

   await connection.clearSchemaCache()
}
