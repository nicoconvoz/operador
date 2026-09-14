import { Pool } from 'pg'
import { PostgresStore } from '../../src/infrastructure/persistence/postgres-store.js'

/**
 * One pool for the whole app. Next.js reuses the module across requests, and
 * a pool created per request is how a free-tier database runs out of
 * connections at the worst possible moment.
 */
let pool: Pool | null = null

export function openStore(): PostgresStore {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set')
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return new PostgresStore({
    query: async <T>(text: string, params?: readonly unknown[]) => {
      const result = await pool!.query(text, params as unknown[])
      return { rows: result.rows as T[] }
    },
  })
}

/**
 * The message, never the stack: a stack from a database client carries
 * connection details, and these endpoints are one paste away from public.
 */
export const failed = (error: unknown, status = 500): Response =>
  Response.json({ error: String(error).slice(0, 200) }, { status })
