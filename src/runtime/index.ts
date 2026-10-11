/**
 * Process entry point.
 *
 * The only file that creates real connections. Everything it wires is a port,
 * so the rest of the system stays runnable without a network or a database.
 */
import { main } from './main.js'

// Optional since the state moved to GitHub: only the legacy store and the
// one-time move off the database use it.
const databaseUrl = process.env.DATABASE_URL?.trim()

// Imported dynamically so the whole codebase stays installable and testable
// without a Postgres driver present.
const pool = databaseUrl ? new (await import('pg')).default.Pool({ connectionString: databaseUrl, max: 4 }) : null

// pg types its rows as QueryResultRow; the store knows the shape it asked for,
// so the cast belongs here, at the boundary, rather than leaking into the port.
const sql = pool
  ? {
      query: async <T>(text: string, params?: readonly unknown[]) => {
        const result = await pool.query(text, params as unknown[])
        return { rows: result.rows as T[] }
      },
    }
  : undefined

// JSON-RPC needs the parsed body, not just the status.
const postJson = async (url: string, body: unknown) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: () => response.json() as Promise<unknown> }
}

try {
  await main(sql ? { sql, postJson } : { postJson })
} catch (error) {
  console.error('[fatal]', error)
  process.exitCode = 1
} finally {
  await pool?.end()
}
