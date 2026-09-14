/**
 * Process entry point.
 *
 * The only file that creates real connections. Everything it wires is a port,
 * so the rest of the system stays runnable without a network or a database.
 */
import { main } from './main.js'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('[fatal] DATABASE_URL is required')
  process.exit(1)
}

// Imported dynamically so the whole codebase stays installable and testable
// without a Postgres driver present.
const { default: pg } = await import('pg')
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })

const post = async (url: string, body: unknown): Promise<{ status: number }> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status }
}

// pg types its rows as QueryResultRow; the store knows the shape it asked for,
// so the cast belongs here, at the boundary, rather than leaking into the port.
const sql = {
  query: async <T>(text: string, params?: readonly unknown[]) => {
    const result = await pool.query(text, params as unknown[])
    return { rows: result.rows as T[] }
  },
}

const fetchJson = async (url: string): Promise<unknown> => {
  // Long polling holds the connection open for the timeout; no AbortSignal
  // here, or every poll would look like a failure.
  const response = await fetch(url)
  return response.json()
}

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
  await main({ sql, post, fetchJson, postJson })
} catch (error) {
  console.error('[fatal]', error)
  process.exitCode = 1
} finally {
  await pool.end()
}
