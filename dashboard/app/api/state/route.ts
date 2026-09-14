import { Pool } from 'pg'
import { buildDashboard } from '../../../../src/application/dashboard.js'
import { PostgresStore } from '../../../../src/infrastructure/persistence/postgres-store.js'

/**
 * The only endpoint. Reads; never writes.
 *
 * `force-dynamic` because a cached view of a trading system is worse than no
 * view: a stale "all healthy" reads exactly like a live one.
 */
export const dynamic = 'force-dynamic'

let pool: Pool | null = null
const getPool = (): Pool => {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return pool
}

export async function GET(): Promise<Response> {
  if (!process.env.DATABASE_URL) {
    return Response.json({ error: 'DATABASE_URL is not set' }, { status: 500 })
  }

  try {
    const sql = {
      query: async <T>(text: string, params?: readonly unknown[]) => {
        const result = await getPool().query(text, params as unknown[])
        return { rows: result.rows as T[] }
      },
    }
    const view = await buildDashboard(new PostgresStore(sql), { now: () => Date.now() })
    return Response.json(view, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    // The message, not the stack: a stack from a database client can carry
    // connection details, and this endpoint is one paste away from public.
    return Response.json({ error: String(error).slice(0, 200) }, { status: 500 })
  }
}
