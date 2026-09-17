const r = await fetch('https://operador-green.vercel.app/api/view')
const { dashboard, universe, operations } = (await r.json()) as any

const byTier: Record<string, number> = {}
for (const t of universe.tokens) byTier[t.tier] = (byTier[t.tier] ?? 0) + 1

// Why the ones that are NOT candidates were refused — the whole point.
const reasons: Record<string, number> = {}
for (const t of universe.tokens) {
  if (t.tier === 'held' || t.tier === 'prime' || t.tier === 'eligible') continue
  const first = t.blockers?.[0]
  if (first) reasons[String(first).slice(0, 48)] = (reasons[String(first).slice(0, 48)] ?? 0) + 1
}
const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)

console.log('escaneado hace', dashboard.lastScan ? Math.round((Date.now() - dashboard.lastScan.at) / 60000) + ' min' : '—')
console.log('universo', universe.tokens.length, JSON.stringify(byTier))
console.log('posiciones', operations.positions.length, '| comprometido $' + operations.totals.deployedUsd.toFixed(0))
console.log('ganancia neta $' + operations.totals.netUsd.toFixed(2), '| cobrada $' + operations.totals.realisedUsd.toFixed(2))
console.log('motivos de rechazo mas comunes:')
for (const [why, n] of top) console.log(`  ${String(n).padStart(4)}  ${why}`)
