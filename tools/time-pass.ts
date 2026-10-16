// Runs ONE real pass from home against a saved state file, in memory, and
// tallies every request by provider: how many, how long, which statuses.
// Nothing is published; the state file is only read.
//   npx tsx tools/time-pass.ts <state.json> [full|watch]
import { readFileSync } from 'node:fs'
import { MemoryStore } from '../src/infrastructure/persistence/memory-store.js'
import { loadConfig } from '../src/runtime/config.js'
import { buildRuntime } from '../src/runtime/main.js'
import { runCycle } from '../src/application/orchestrator.js'

type Tally = { n: number; ms: number; max: number; status: Record<string, number> }
const tally = new Map<string, Tally>()
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const key = `${url.host}${url.pathname.replace(/\/[A-Za-z0-9]{32,}.*/, '/…')}`
  const t = tally.get(key) ?? { n: 0, ms: 0, max: 0, status: {} }
  tally.set(key, t)
  const start = performance.now()
  try {
    const response = await realFetch(input, init)
    t.status[response.status] = (t.status[response.status] ?? 0) + 1
    return response
  } catch (error) {
    t.status.error = (t.status.error ?? 0) + 1
    throw error
  } finally {
    const ms = performance.now() - start
    t.n += 1
    t.ms += ms
    t.max = Math.max(t.max, ms)
  }
}) as typeof fetch

const began = Date.now()
const report = () => {
  console.log(`\n── ${Math.round((Date.now() - began) / 1000)}s ──`)
  for (const [key, t] of [...tally].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)) {
    console.log(key.slice(0, 60).padEnd(60), String(t.n).padStart(5), `${(t.ms / 1000).toFixed(0)}s`.padStart(6), `max ${(t.max / 1000).toFixed(1)}s`, JSON.stringify(t.status))
  }
}
const timer = setInterval(report, 30_000)

const config = loadConfig({ ...process.env, OPERADOR_CAPITAL_USD: '5000', OPERADOR_CYCLE_MS: '60000', OPERADOR_SCAN_MS: '60000', OPERADOR_HELD_SCAN_MS: '60000' })
const store = MemoryStore.fromState(JSON.parse(readFileSync(process.argv[2]!, 'utf8')))
const postJson = async (url: string, body: unknown) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, json: () => response.json() as Promise<unknown> }
}
const { deps, cycleConfig, throttle } = buildRuntime(config, { store, postJson })
const result = await runCycle(deps, cycleConfig, throttle, (process.argv[3] as 'full' | 'watch' | undefined) ?? 'full')
clearInterval(timer)
report()
console.log('\npass', Math.round((Date.now() - began) / 1000), 's', JSON.stringify({ positions: result.ticks.length, opened: result.opened.length }))
process.exit(0)
