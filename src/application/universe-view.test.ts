import { describe, it, expect } from 'vitest'
import { buildUniverse } from './universe-view.js'
import { describeHoldBack } from './hold-back.js'
import { productionDoors } from './production-doors.js'
import { STRICT_GATE_POLICY } from '../domain/scanner/gates.js'
import { MemoryStore } from '../infrastructure/persistence/memory-store.js'
import { initialState } from '../domain/strategy/state.js'
import { startDeathWatch, type DeathWatchState } from '../domain/risk/death-exit.js'
import { type PersistedPosition } from '../domain/persistence/store.js'
import { type SecurityReport, type TokenSnapshot } from '../domain/scanner/snapshot.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const UNKNOWN: SecurityReport = {
  honeypot: null, mintAuthorityActive: null, freezeAuthorityActive: null, transferTaxPct: null,
  hasBlacklist: null, lpLockedPct: null, topHoldersPct: null, creatorPct: null, verifiedSource: null, isProxy: null,
}

const safe: SecurityReport = {
  honeypot: false, mintAuthorityActive: false, freezeAuthorityActive: false, transferTaxPct: 0,
  hasBlacklist: false, lpLockedPct: 100, topHoldersPct: 20, creatorPct: 1, verifiedSource: null, isProxy: null,
}

const token = (address: string, over: Partial<TokenSnapshot> = {}, security: Partial<SecurityReport> = {}): TokenSnapshot => ({
  chain: 'solana', address, symbol: address, pairAddress: `pair-${address}`, observedAt: NOW,
  priceUsd: 0.01, liquidityUsd: 250_000, fdvUsd: 5_000_000,
  volumeUsd: { h1: 60_000, h6: 300_000, h24: 875_000 },
  priceChangePct: { h1: 6, h6: -4, h24: 12 },
  txns: { h1: { buys: 70, sells: 25 }, h24: { buys: 900, sells: 850 } },
  pairCreatedAt: NOW - 30 * 24 * HOUR, historyBars: 1000,
  security: { ...safe, ...security }, ...over,
})

const position = (address: string, over: Partial<PersistedPosition> = {}): PersistedPosition => ({
  id: `pos-${address}`, chain: 'solana', tokenAddress: address, pairAddress: `pair-${address}`, symbol: address,
  cascade: { ...initialState(), level: 3 }, deathWatch: startDeathWatch(250_000, NOW),
  quality: { liquidityUsd: 250_000, spreadPct: 0.3, slippagePct: 0.1, referenceUsd: 100, observedAt: NOW },
  capitalUsd: 200, lastBarTime: NOW, lastPriceUsd: 0.01, pendingOrders: [], openedAt: NOW, updatedAt: NOW, ...over,
})

const seed = async (snapshots: TokenSnapshot[]) => {
  const store = new MemoryStore()
  await store.saveScan({ scannedAt: NOW - HOUR, chain: 'solana', snapshots })
  return store
}

const options = { now: () => NOW }

/** The screen's own labels for the components these tests name. */
const LABELS: Readonly<Record<string, string>> = {
  buyPressure: 'presión compradora', activity: 'actividad', volumeExpansion: 'expansión de volumen',
  costEfficiency: 'eficiencia de costo',
}

/**
 * The tiers, under the policy that still asks the taste gates.
 *
 * Production narrowed to three component floors plus safety, so
 * `DEFAULT_GATE_POLICY` no longer asks turnover, volume or the FDV cap — which
 * means nothing is ever FORGIVEN under it and the `reserve` tier has nothing
 * to hold. The tier LOGIC is still worth proving, and it comes back the day
 * those gates do.
 */
const strictOptions = { now: () => NOW, gates: STRICT_GATE_POLICY }

describe('buildUniverse — tiers tell the story', () => {
  it('an empty store yields an empty universe, not a crash', async () => {
    const view = await buildUniverse(new MemoryStore(), options)
    expect(view.tokens).toEqual([])
    expect(view.scannedAt).toBeNull()
  })

  it('a clean, lively token is prime', async () => {
    const store = await seed([token('HOT')])
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('prime')
    expect(t!.score).toBeGreaterThan(45)
    expect(t!.blockers).toEqual([])
  })

  it('a clean but quiet token is eligible, not prime', async () => {
    // What makes a token score low CHANGED. Volume and trade counts used to
    // carry weight and no longer do — the score is momentum, the hour, and
    // what the pool charges. So "dull" is now a token going nowhere in a pool
    // that is expensive to trade, which is exactly what this one is: flat in
    // every window, and thin enough that a reference order moves it 4%.
    const quiet = token('CALM', {
      volumeUsd: { h1: 1_000, h6: 10_000, h24: 700_000 },
      txns: { h1: { buys: 2, sells: 2 }, h24: { buys: 100, sells: 100 } },
      // Sliding in the hour: momentum reads zero and so does the hour's own
      // door, which between them are 80% of the score.
      priceChangePct: { h1: -10, h6: 0, h24: 0 },
    })
    const [t] = (await buildUniverse(await seed([quiet]), options)).tokens
    expect(t!.tier).toBe('eligible')
  })

  it('a safety failure is UNSAFE, not merely filtered — a bullet dodged, not a missed chance', async () => {
    const store = await seed([token('RUG', {}, { honeypot: true })])
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('unsafe')
    expect(t!.blockers[0]).toContain('sell simulation')
  })

  it('a market failure is filtered — uninteresting, not dangerous', async () => {
    const store = await seed([token('THIN', { liquidityUsd: 500 })])
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('filtered')
    expect(t!.blockers[0]).toContain('liquidity')
  })

  it('a held token is held, whatever its score says', async () => {
    const store = await seed([token('MINE', { volumeUsd: { h1: 0, h6: 0, h24: 0 } })])
    await store.savePosition(position('MINE'))
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('held')
    expect(t!.position).toMatchObject({ capitalUsd: 200, filledDcas: 2, deathStage: 'healthy' })
  })

  it('a blacklisted token is dead, and dead outranks everything', async () => {
    const store = await seed([token('GONE')])
    await store.savePosition(position('GONE'))
    await store.blacklist('solana', 'GONE', 'LP removed', NOW)
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('dead')
  })

  it('carries the death stage so a frozen position can be shown as such', async () => {
    const frozen: DeathWatchState = { ...startDeathWatch(250_000, NOW), stage: 'frozen' }
    const store = await seed([token('ICE')])
    await store.savePosition(position('ICE', { deathWatch: frozen }))
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.position!.deathStage).toBe('frozen')
  })
})

describe('buildUniverse — what a picture needs', () => {
  it('exposes the score components, so the view can show WHY', async () => {
    const [t] = (await buildUniverse(await seed([token('WHY')]), options)).tokens
    expect(Object.keys(t!.components)).toEqual(
      expect.arrayContaining(['volumeExpansion', 'buyPressure', 'liquidityGrowth', 'activity', 'volatility', 'costEfficiency']),
    )
  })

  it('estimates friction so cheap and expensive tokens can look different', async () => {
    const deep = await buildUniverse(await seed([token('DEEP', { liquidityUsd: 5_000_000 })]), options)
    const thin = await buildUniverse(await seed([token('THIN2', { liquidityUsd: 40_000 })]), options)
    expect(thin.tokens[0]!.frictionPct).toBeGreaterThan(deep.tokens[0]!.frictionPct)
  })

  it('counts every tier and lists the chains present', async () => {
    const store = await seed([
      token('A'),
      token('B', { chain: 'bsc', address: 'B' }),
      token('C', { liquidityUsd: 100 }),
      token('D', {}, { honeypot: true }),
    ])
    const view = await buildUniverse(store, options)
    expect(view.counts.filtered).toBe(1)
    expect(view.counts.unsafe).toBe(1)
    expect(view.chains).toEqual(['bsc', 'solana'])
  })

  it('sorts brightest first, so a truncated render keeps what matters', async () => {
    const store = await seed([token('BAD', { liquidityUsd: 1 }), token('GOOD')])
    await store.savePosition(position('MINE'))
    const view = await buildUniverse(await seed([token('BAD', { liquidityUsd: 1 }), token('GOOD')]), options)
    expect(view.tokens[0]!.symbol).toBe('GOOD')
  })
})

describe('buildUniverse — every chain at once', () => {
  const HOUR_MS = 3_600_000

  it('shows Solana AND BSC together, not whichever scanned last', async () => {
    const store = new MemoryStore()
    await store.saveScan({ scannedAt: NOW - 2 * HOUR_MS, chain: 'solana', snapshots: [token('SOL1'), token('SOL2')] })
    await store.saveScan({
      scannedAt: NOW - HOUR,
      chain: 'bsc',
      snapshots: [token('BSC1', { chain: 'bsc', address: 'BSC1' })],
    })

    const view = await buildUniverse(store, options)
    // The old read took the newest row and nothing else, so scanning BSC made
    // every Solana token disappear from the screen.
    expect(view.tokens.map((t) => t.symbol).sort()).toEqual(['BSC1', 'SOL1', 'SOL2'])
    expect(view.chains).toEqual(['bsc', 'solana'])
  })

  it('keeps only the LATEST scan of each chain', async () => {
    const store = new MemoryStore()
    await store.saveScan({ scannedAt: NOW - 2 * HOUR_MS, chain: 'solana', snapshots: [token('OLD')] })
    await store.saveScan({ scannedAt: NOW - HOUR, chain: 'solana', snapshots: [token('FRESH')] })

    const view = await buildUniverse(store, options)
    expect(view.tokens.map((t) => t.symbol)).toEqual(['FRESH'])
  })

  it('reports the OLDEST chain as the scan time — a universe is only as fresh as its stalest half', async () => {
    const store = new MemoryStore()
    await store.saveScan({ scannedAt: NOW - 3 * HOUR_MS, chain: 'solana', snapshots: [token('SOL1')] })
    await store.saveScan({ scannedAt: NOW - HOUR, chain: 'bsc', snapshots: [token('BSC1', { chain: 'bsc', address: 'BSC1' })] })

    expect((await buildUniverse(store, options)).scannedAt).toBe(NOW - 3 * HOUR_MS)
  })
})

describe('buildUniverse — rejected for being thin is not the same as dangerous', () => {
  it('a token rejected on MARKET grounds is filtered, not unsafe', async () => {
    // The scanner never examines these: they fail the free gates first, so
    // their security report is all-null. The gates fail closed, so a naive
    // reading calls them a safety failure — and the screen said "insegura 219,
    // filtrada 6" when almost every one of those was simply too thin.
    const thin = token('THIN', { liquidityUsd: 500 })
    const store = await seed([{ ...thin, security: UNKNOWN, securityChecked: false }])

    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.tier).toBe('filtered')
    expect(t!.blockers.some((b) => b.includes('liquidity'))).toBe(true)
  })

  it('a token that passed the market gates but was never examined is pending', async () => {
    const store = await seed([{ ...token('WAIT'), security: UNKNOWN, securityChecked: false }])
    expect((await buildUniverse(store, options)).tokens[0]!.tier).toBe('pending')
  })

  it('a token that WAS examined and failed a safety gate is still unsafe', async () => {
    const store = await seed([token('RUG', {}, { honeypot: true })])
    expect((await buildUniverse(store, options)).tokens[0]!.tier).toBe('unsafe')
  })
})

describe('buildUniverse — an unexamined token lists why it was REJECTED', () => {
  it('drops the security unknowns, which are noise when nobody looked', async () => {
    const store = await seed([{ ...token('THIN', { liquidityUsd: 500 }), security: UNKNOWN, securityChecked: false }])
    const [t] = (await buildUniverse(store, options)).tokens

    // Measured live: 180 of 185 filtered tokens led with six lines of
    // "mint authority unknown", "blacklist capability unknown" and so on,
    // burying the one line that was the actual reason. They are true and they
    // are useless: the gates fail closed, and nobody examined this token.
    expect(t!.blockers.some((b) => b.includes('unknown') || b.includes('unavailable'))).toBe(false)
    expect(t!.blockers.some((b) => b.includes('liquidity'))).toBe(true)
  })

  it('keeps every blocker when the token WAS examined', async () => {
    const store = await seed([token('RUG', {}, { honeypot: true })])
    const [t] = (await buildUniverse(store, options)).tokens
    expect(t!.blockers.some((b) => b.includes('sell simulation'))).toBe(true)
  })
})

// ── A position is never invisible ───────────────────────────────────────────
//
// The universe was built from the latest scan and nothing else, so a held token
// that fell out of this cycle's discovery lists simply stopped existing on the
// screen. Found live: five open positions, four bodies drawn, and the missing
// one was holding money.
//
// The case matters most in exactly the situation you would least want it to
// fail. A token that drops off every discovery list is a token that may be
// dying — so the screen went blank at the precise moment it had something to
// say.

describe('buildUniverse — a held token is always on the radar', () => {
  it('draws a position the latest scan did not include', async () => {
    const store = await seed([token('Seen')])
    await store.savePosition(position('Seen'))
    await store.savePosition(position('Vanished', { symbol: 'BTC', capitalUsd: 285 }))

    const view = await buildUniverse(store, options)
    const symbols = view.tokens.filter((t) => t.tier === 'held').map((t) => t.symbol)

    expect(symbols).toContain('BTC')
    expect(view.counts.held).toBe(2)
  })

  it('carries what the POSITION knows, since the scanner said nothing', async () => {
    const store = await seed([])
    await store.savePosition(position('Vanished', { symbol: 'BTC', capitalUsd: 285, lastPriceUsd: 0.5 }))

    const [drawn] = (await buildUniverse(store, options)).tokens

    expect(drawn).toMatchObject({
      symbol: 'BTC',
      chain: 'solana',
      address: 'Vanished',
      tier: 'held',
      priceUsd: 0.5,
      liquidityUsd: 250_000, // the quality measured when it was opened
    })
    expect(drawn!.position).toMatchObject({ capitalUsd: 285, filledDcas: 2 })
  })

  it('says the scanner did not see it, rather than inventing a verdict', async () => {
    const store = await seed([])
    await store.savePosition(position('Vanished', { symbol: 'BTC' }))

    const [drawn] = (await buildUniverse(store, options)).tokens

    // Silence is not a clean bill of health. An empty blockers list here would
    // read as "checked and fine", which is the one thing nobody checked.
    expect(drawn!.blockers.join(' ')).toMatch(/escáner|escaner/i)
    expect(drawn!.score).toBe(0)
  })

  it('does not draw a held token twice when the scan did find it', async () => {
    const store = await seed([token('Seen')])
    await store.savePosition(position('Seen'))

    const view = await buildUniverse(store, options)

    expect(view.tokens.filter((t) => t.address === 'Seen')).toHaveLength(1)
    expect(view.counts.held).toBe(1)
  })
})

// ── A held token that turned unsafe ─────────────────────────────────────────
//
// The tier short-circuits to 'held' for anything with a position, so a token
// of ours that now FAILS a safety gate went on being drawn green. The engine
// would act on it — the death watch can finally see the scanner's verdict —
// but the screen would never show it coming.
//
// Both facts are true at once and both matter. It is not "an unsafe candidate":
// it is our money in something that just failed a gate, which is a different
// and more urgent thing than either fact alone.

describe('buildUniverse — a position that turned unsafe', () => {
  const dangerous = { mintAuthorityActive: true }

  it('stays held — it is still ours, and that is the point', async () => {
    const store = await seed([token('Ours', {}, dangerous)])
    await store.savePosition(position('Ours'))

    const [drawn] = (await buildUniverse(store, options)).tokens

    expect(drawn!.tier).toBe('held')
  })

  it('but says it turned unsafe', async () => {
    const store = await seed([token('Ours', {}, dangerous)])
    await store.savePosition(position('Ours'))

    const [drawn] = (await buildUniverse(store, options)).tokens

    expect(drawn!.turnedUnsafe).toBe(true)
  })

  it('names the gate that turned, so the alarm is answerable', async () => {
    const store = await seed([token('Ours', {}, dangerous)])
    await store.savePosition(position('Ours'))

    const [drawn] = (await buildUniverse(store, options)).tokens

    expect(drawn!.blockers.join(' ')).toMatch(/mint/i)
  })

  it('says nothing about a healthy position', async () => {
    const store = await seed([token('Ours')])
    await store.savePosition(position('Ours'))

    expect((await buildUniverse(store, options)).tokens[0]!.turnedUnsafe).toBe(false)
  })

  it('never cries unsafe over a token nobody examined', async () => {
    // An unexamined token fails EVERY safety gate by design — the gates fail
    // closed. Reading that as "it turned unsafe" would put a red alarm on every
    // position the security budget had not reached yet, which is how an alarm
    // stops being read.
    const store = await seed([token('Ours', { securityChecked: false }, {})])
    await store.savePosition(position('Ours'))

    expect((await buildUniverse(store, options)).tokens[0]!.turnedUnsafe).toBe(false)
  })

  it('does not raise it on a token that is not ours', async () => {
    // A dangerous candidate is already drawn as 'unsafe'. The flag is about the
    // one case the tier cannot express: danger inside a position.
    const store = await seed([token('Theirs', {}, dangerous)])

    const [drawn] = (await buildUniverse(store, options)).tokens

    expect(drawn!.tier).toBe('unsafe')
    expect(drawn!.turnedUnsafe).toBe(false)
  })
})

describe('buildUniverse — a freeze that will not say why is a freeze nobody can act on', () => {
  it('carries the evidence that froze the position, newest first', async () => {
    // Six positions showed "❄️ congelada" and not one of them said what for.
    // The evidence chain is recorded, persisted, and extracted by
    // `buildDashboard` — and rendered by nobody, so diagnosing a freeze meant
    // reading the database. The operator is the one who decides whether the
    // token really died or the engine is wrong about it, and that decision is
    // impossible from a snowflake.
    const frozen: DeathWatchState = {
      ...startDeathWatch(250_000, NOW),
      stage: 'frozen',
      evidence: [
        { observedAt: NOW - 1, source: 'probe', stageAfter: 'frozen', verdict: 'freeze', signals: [{ kind: 'abandonment', stage: 1, detail: 'older' }] },
        { observedAt: NOW, source: 'probe', stageAfter: 'frozen', verdict: 'freeze', signals: [{ kind: 'sellPathBroken', stage: 2, detail: 'sell quote failed' }] },
      ],
    }
    const store = await seed([token('ICE')])
    await store.savePosition(position('ICE', { deathWatch: frozen }))

    const [t] = (await buildUniverse(store, options)).tokens

    expect(t!.position!.deathSignals[0]).toBe('sell quote failed')
  })
})

describe('buildUniverse — one token is one body, however many times it was scanned', () => {
  it('does not count the same token twice', async () => {
    // Reported live: the chips said "operando 18" beside a header saying 15
    // positions, and counting the green dots gave 15. The dots were right.
    //
    // A duplicate hides perfectly, which is why it took a hand count to find:
    // a body's place in the sky comes from a HASH of its address, so the twin
    // lands exactly on top of the original and the two read as one.
    //
    // The merge was `scans.flatMap(scan => scan.snapshots)` with nothing
    // guarding it, and the scan's own dedupe runs per batch of thirty rather
    // than across them.
    const store = await seed([token('TWICE')])
    const [scan] = await store.latestScansByChain()
    await store.saveScan({ scannedAt: scan!.scannedAt, chain: 'solana', snapshots: [...scan!.snapshots, ...scan!.snapshots] })

    const view = await buildUniverse(store, options)

    expect(view.tokens.filter((t) => t.address === 'TWICE')).toHaveLength(1)
  })

  it('keeps the richer of two copies, never the emptier one', async () => {
    // If one copy carries a measurement the other does not, dropping the wrong
    // one throws away evidence — and the gates fire on evidence.
    const store = await seed([token('RICH')])
    const [scan] = await store.latestScansByChain()
    const thin = { ...scan!.snapshots[0]!, liquidityUsd: 1_000 }
    const deep = { ...scan!.snapshots[0]!, liquidityUsd: 900_000 }
    await store.saveScan({ scannedAt: scan!.scannedAt, chain: 'solana', snapshots: [thin, deep] })

    const view = await buildUniverse(store, options)

    expect(view.tokens.find((t) => t.address === 'RICH')!.liquidityUsd).toBe(900_000)
  })
})

describe('universe — the reserve is its own tier, not a rejection', () => {
  // The screen re-evaluates the gates on the stored snapshot. A token the
  // allocator can reach for, drawn as `filtered`, is the exact
  // screen-versus-engine disagreement this read model exists to prevent — and
  // this project has paid for that one more than once.
  const quiet = token('QUIET', { liquidityUsd: 5_000_000, volumeUsd: { h1: 4_000, h6: 24_000, h24: 96_000 } })

  it('draws a token held back only by a preference as reserve', async () => {
    // Under the STRICT policy, which is where these gates still live: the
    // production default stopped asking turnover, volume and the FDV cap, so
    // nothing is ever FORGIVEN under it and the reserve has nothing to hold.
    // The mechanism is proved here and comes back the day those gates do.
    const store = await seed([quiet])
    const view = await buildUniverse(store, strictOptions)
    expect(view.tokens[0]?.tier).toBe('reserve')
  })

  it('draws a token failing the ENTRY door as filtered — the engine will not open it', async () => {
    const store = await seed([token('COLD')])
    const view = await buildUniverse(store, { now: () => NOW, entryDoors: [{ volumeExpansion: 2 }] })
    expect(view.tokens[0]?.tier).toBe('filtered')
  })

  it('says WHY a filtered token is held back, in the numbers it was judged on', async () => {
    // *Hay filtradas que cumplen con la condición y no se inician.* They did
    // not: pwease read 49% of volume expansion against a door of 50%. The bars
    // carried no number and the sheet listed only safety blockers, so a door
    // missed by one point looked like a door met. A filtered token now says
    // which door, what it read, and what the door asks.
    const store = await seed([token('COLD')])
    const view = await buildUniverse(store, { now: () => NOW, entryDoors: [{ volumeExpansion: 2 }], minScore: 101 })
    const back = view.tokens[0]!.holdBack
    expect(back.find((b) => b.kind === 'entry')).toMatchObject({ name: 'volumeExpansion', floor: 2, strict: false })
    expect(back.find((b) => b.kind === 'score')).toMatchObject({ floor: 101 })
    expect(back.find((b) => b.kind === 'entry')!.value).toBeLessThan(2)
  })

  it('draws an expensive token as a candidate like any other — *puerta de entrada ninguna*', async () => {
    // The engine asks no door now, so the screen asks none: a 2.2% round trip
    // is welcome, and it only sorts behind the cheaper ones.
    const store = await seed([token('DEAR', { measuredImpactPct: 0.8 })])
    const view = await buildUniverse(store, { now: () => NOW, minComponents: productionDoors({}).minComponents })
    expect(view.tokens[0]!.tier).not.toBe('filtered')
    expect(view.tokens[0]!.holdBack).toEqual([])
  })

  it('draws a token under the cost-efficiency door as filtered when the door is brought back, and says what it read and what it asks', async () => {
    // *La única puerta de entrada para los tokens es que la eficiencia de los
    // costos esté arriba del 60%* — one variable away now. The screen's 0.3%
    // spread and 0.8% of measured impact is a 2.2% round trip: 1 - 2.2 / 4 =
    // 45% — under the door.
    const store = await seed([token('DEAR', { measuredImpactPct: 0.8 })])
    const view = await buildUniverse(store, { now: () => NOW, minComponents: productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: '60' }).minComponents })
    const dear = view.tokens[0]!
    expect(dear.tier).toBe('filtered')
    expect(dear.holdBack).toHaveLength(1)
    expect(dear.holdBack[0]).toMatchObject({ kind: 'floor', name: 'costEfficiency', floor: 0.6, strict: true })
    expect(dear.holdBack[0]!.value).toBeCloseTo(0.45, 9)
    expect(describeHoldBack(dear.holdBack[0]!, LABELS)).toBe('eficiencia de costo 45.0% (pide > 60%)')
  })

  it('refuses a token at 60% of cost efficiency — the door asks for more', async () => {
    // 0.3% of spread and 0.5% of impact is a 1.6% round trip: 60% to the
    // rounding of the screen, and never above it.
    const store = await seed([token('EVEN', { measuredImpactPct: 0.5 })])
    const view = await buildUniverse(store, { now: () => NOW, minComponents: productionDoors({ OPERADOR_MIN_COST_EFFICIENCY_PCT: '60' }).minComponents })
    expect(view.tokens[0]!.tier).toBe('filtered')
    expect(describeHoldBack(view.tokens[0]!.holdBack[0]!, LABELS)).toBe('eficiencia de costo 60.0% (pide > 60%)')
  })

  it('lets a token whose round trip is cheap enough through the door', async () => {
    const store = await seed([token('HOT')])
    const view = await buildUniverse(store, { now: () => NOW, minComponents: productionDoors({}).minComponents })
    expect(view.tokens[0]!.tier).not.toBe('filtered')
    expect(view.tokens[0]!.holdBack).toEqual([])
  })

  it('draws a token that is not rising in the last hour as filtered, and says so with the hour it read', async () => {
    // *Hacé que la barrera de entrada sea solamente que los tokens suban, como
    // marca la barra de estudio.* The engine's door, from the module it reads.
    const store = await seed([
      token('UP', { priceChangePct: { h1: 0.3, h6: 0, h24: 0 } }),
      token('DOWN', { priceChangePct: { h1: -1.2, h6: 0, h24: 0 } }),
      token('FLAT', { priceChangePct: { h1: 0, h6: 0, h24: 0 } }),
      token('QUIET', { priceChangePct: { h1: null, h6: 0, h24: 0 } }),
    ])
    const view = await buildUniverse(store, { now: () => NOW, minComponents: productionDoors({}).minComponents })
    const by = (symbol: string) => view.tokens.find((t) => t.symbol === symbol)!
    expect(by('UP').tier).not.toBe('filtered')
    expect(by('UP').holdBack).toEqual([])
    for (const symbol of ['DOWN', 'FLAT', 'QUIET']) expect(by(symbol).tier, symbol).toBe('filtered')
    expect(by('DOWN').holdBack).toEqual([{ kind: 'rising', name: 'risingHour', value: -1.2, floor: 0, strict: true }])
    expect(describeHoldBack(by('DOWN').holdBack[0]!, LABELS)).toBe('no sube en la última hora (−1.2%)')
    expect(describeHoldBack(by('FLAT').holdBack[0]!, LABELS)).toBe('no sube en la última hora (0.0%)')
    expect(describeHoldBack(by('QUIET').holdBack[0]!, LABELS)).toBe('no sube en la última hora (sin dato)')
  })

  it('draws the same token as buyable with the door off — OPERADOR_ENTRY_RISING=0', async () => {
    const store = await seed([token('DOWN', { priceChangePct: { h1: -1.2, h6: 0, h24: 0 } })])
    const view = await buildUniverse(store, { now: () => NOW, minComponents: productionDoors({ OPERADOR_ENTRY_RISING: '0' }).minComponents })
    expect(view.tokens[0]!.tier).not.toBe('filtered')
  })

  it('says an AT-LEAST door, a first-buy door and the score door in their own words', () => {
    expect(describeHoldBack({ kind: 'floor', name: 'activity', value: 0.49, floor: 0.5, strict: false }, LABELS))
      .toBe('actividad 49.0% (pide ≥ 50%)')
    expect(describeHoldBack({ kind: 'entry', name: 'volumeExpansion', value: 0.2, floor: 0.25, strict: false }, LABELS))
      .toBe('expansión de volumen 20.0% (la primera compra pide ≥ 25%)')
    expect(describeHoldBack({ kind: 'floor', name: 'buyPressure', value: 0.05, floor: 0.125, strict: true }, LABELS))
      .toBe('presión compradora 5.0% (pide > 12.5%)')
    expect(describeHoldBack({ kind: 'score', name: 'score', value: 42, floor: 50, strict: false }, LABELS))
      .toBe('puntaje 42.0 (la puerta pide 50)')
    // A component nobody labelled is named as the code names it, never blank.
    expect(describeHoldBack({ kind: 'floor', name: 'mystery', value: 0.1, floor: 0.2, strict: false }, {}))
      .toBe('mystery 10.0% (pide ≥ 20%)')
  })

  it('holds nothing back on a token the engine may open', async () => {
    const store = await seed([token('HOT')])
    const view = await buildUniverse(store, { now: () => NOW })
    expect(view.tokens[0]!.holdBack).toEqual([])
  })

  it('draws it FILTERED when the engine keeps the reserve off', async () => {
    // *Sólo candidatas las que ya cumplan todas las condiciones.* A fallback
    // the engine will never buy must not be drawn as one it might.
    const store = await seed([quiet])
    const view = await buildUniverse(store, { ...strictOptions, reserve: false })
    expect(view.tokens[0]?.tier).toBe('filtered')
  })

  it('still says WHY it is not a first choice', async () => {
    // Under the STRICT policy, which is where these gates still live: the
    // production default stopped asking turnover, volume and the FDV cap, so
    // nothing is ever FORGIVEN under it and the reserve has nothing to hold.
    // The mechanism is proved here and comes back the day those gates do.
    const store = await seed([quiet])
    const view = await buildUniverse(store, strictOptions)
    expect(view.tokens[0]?.blockers.join(' ')).toMatch(/liquidez/)
  })

  it('leaves a token the strategy cannot run on in filtered, under the policy that still asks', async () => {
    // Under four trades an hour a 15m bar comes back empty. Production stopped
    // asking — *todo es bienvenido* — and STRICT keeps the gate tested.
    const dead = token('DEAD', { txns: { h1: { buys: 1, sells: 0 }, h24: { buys: 900, sells: 850 } } })
    const store = await seed([dead])
    expect((await buildUniverse(store, strictOptions)).tokens[0]?.tier).toBe('filtered')
    expect((await buildUniverse(store, options)).tokens[0]?.tier).not.toBe('filtered')
  })
})

describe('universe — what we HOLD is priced now, not an hour ago', () => {
  // The scan runs hourly, so a token holding money carried numbers up to an
  // hour old — and its score with them. The live market data was already being
  // fetched for the unrealised figure and every field but the price thrown
  // away, so this costs no request at all.
  const stale = token('OURS', { liquidityUsd: 200_000, volumeUsd: { h1: 20_000, h6: 120_000, h24: 600_000 }, priceChangePct: { h1: 1, h6: 2, h24: 4 } })

  const withPosition = async (snapshots: TokenSnapshot[]) => {
    const store = await seed(snapshots)
    await store.savePosition(position('OURS'))
    return store
  }

  it('re-scores a held token from the market as it is right now', async () => {
    const store = await withPosition([stale])
    const before = (await buildUniverse(store, options)).tokens[0]!.score
    const after = (
      await buildUniverse(store, {
        ...options,
        liveMarkets: async () =>
          new Map([['solana:OURS', { ...stale, liquidityUsd: 600_000, priceChangePct: { h1: 9, h6: 14, h24: 22 } }]]),
      })
    ).tokens[0]!

    expect(after.liquidityUsd).toBe(600_000)
    expect(after.score).not.toBeCloseTo(before, 6)
  })

  it('keeps everything the scan PAID for, because the market feed cannot answer it', async () => {
    // Security, the history count and the bar-freshness measurement come from
    // the expensive half of a scan. Overlaying a market response on top of them
    // would blank the evidence every gate here fires on.
    const store = await withPosition([{ ...stale, securityChecked: true, historyBars: 1_000, lastTradeAgoHours: 0.2 }])
    const view = await buildUniverse(store, {
      ...options,
      liveMarkets: async () => new Map([['solana:OURS', { ...stale, liquidityUsd: 600_000 }]]),
    })
    expect(view.tokens[0]!.tier).toBe('held')
    expect(view.tokens[0]!.blockers).toEqual([])
  })

  it('leaves a token we do NOT hold exactly as the scan left it', async () => {
    const store = await seed([stale])
    const view = await buildUniverse(store, {
      ...options,
      liveMarkets: async () => new Map([['solana:OURS', { ...stale, liquidityUsd: 600_000 }]]),
    })
    expect(view.tokens[0]!.liquidityUsd).toBe(200_000)
  })

  it('falls back to the stored numbers when the feed has a bad minute', async () => {
    // Stale and drawn is better than absent. A provider hiccup must not empty
    // the screen of the one thing on it that holds money.
    const store = await withPosition([stale])
    const view = await buildUniverse(store, {
      ...options,
      liveMarkets: async () => { throw new Error('502') },
    })
    expect(view.tokens[0]!.liquidityUsd).toBe(200_000)
  })
})

describe('universe — a slot that holds nothing is a RESERVATION, not a trade', () => {
  // Reported from the screen: three bodies drawn glowing and labelled
  // "operando", every one of them with qty 0 and $0 deployed against $1,250 of
  // capital each. Nothing had been bought.
  //
  // The distinction already exists in the engine and is load-bearing there — a
  // position with fills is a COMMITMENT whose slot cannot come back without
  // selling, and one without is a RESERVATION that costs nothing to cancel.
  // `idle-slots.ts` releases only the second kind. The screen was collapsing
  // the two, which is the engine-versus-canvas disagreement this read model
  // exists to prevent.
  //
  // And it reads the FILLS, never the cascade level: a machine can sit at
  // level 1 believing it holds something the broker refused, and a reservation
  // dressed as a position is exactly the case this must not misread.

  it('says a position with no fills is holding nothing', async () => {
    const store = new MemoryStore()
    await store.savePosition(position('A', { id: 'empty' }))
    const view = await buildUniverse(store, { now: () => NOW })
    expect(view.tokens[0]!.position?.holdsTokens).toBe(false)
  })

  it('says a position WITH a buy is holding something', async () => {
    const store = new MemoryStore()
    await store.savePosition(position('B', { id: 'full' }))
    await store.recordFill({
      positionId: 'full', orderId: 'Entry', idempotencyKey: 'k', side: 'buy',
      qty: 100, price: 1, costUsd: 0.05, comment: 'Entry', time: NOW - 1000,
    })
    const view = await buildUniverse(store, { now: () => NOW })
    expect(view.tokens[0]!.position?.holdsTokens).toBe(true)
  })

  it('goes back to holding nothing once it has been sold out', async () => {
    // A position that took its profit and went flat is a reservation again:
    // its slot is free, and drawing it as money at work would keep a body
    // glowing over an empty slot.
    const store = new MemoryStore()
    await store.savePosition(position('C', { id: 'sold' }))
    await store.recordFill({
      positionId: 'sold', orderId: 'Entry', idempotencyKey: 'k1', side: 'buy',
      qty: 100, price: 1, costUsd: 0.05, comment: 'Entry', time: NOW - 2000,
    })
    await store.recordFill({
      positionId: 'sold', orderId: 'Entry', idempotencyKey: 'k2', side: 'sell',
      qty: 100, price: 2, costUsd: 0.05, comment: '🏁 Exit', time: NOW - 1000,
    })
    const view = await buildUniverse(store, { now: () => NOW })
    expect(view.tokens[0]!.position?.holdsTokens).toBe(false)
  })
})

describe('universe — never more candidates than the capital can take', () => {
  // *Que no haya más candidatos de los que el capital pueda tomar.* The engine
  // cuts its shortlist to the free slots, the cheapest to trade first; the
  // screen draws the same cut. The measured impact decides the order: 0.1% of
  // impact reads 75% of cost efficiency, 0.8% reads 45%.
  const byImpact = (impact: Readonly<Record<string, number>>) =>
    Object.entries(impact).map(([address, measuredImpactPct]) => token(address, { measuredImpactPct }))

  it('draws only as many candidates as there are free slots — the cheapest — and says so', async () => {
    const store = await seed(byImpact({ DEAR: 0.8, CHEAP: 0.1, MID: 0.3, OK: 0.5 }))
    const view = await buildUniverse(store, { ...options, order: 'costEfficiency', freeSlots: 2 })
    const candidates = view.tokens.filter((t) => t.tier === 'prime' || t.tier === 'eligible').map((t) => t.symbol)
    expect(candidates).toEqual(['CHEAP', 'MID'])
    expect(view.freeSlots).toBe(2)
    const cut = view.tokens.find((t) => t.symbol === 'DEAR')!
    expect(cut.tier).toBe('filtered')
    expect(cut.holdBack).toEqual([{ kind: 'slots', name: 'costEfficiency', value: expect.closeTo(0.45, 9), floor: 2, strict: false }])
    expect(describeHoldBack(cut.holdBack[0]!, LABELS)).toBe('sin lugar libre: el capital toma 2 y hay candidatas más baratas de operar (eficiencia de costo 45.0%)')
  })

  it('draws no candidate at all when no slot is free', async () => {
    const store = await seed(byImpact({ CHEAP: 0.1, MID: 0.3 }))
    const view = await buildUniverse(store, { ...options, order: 'costEfficiency', freeSlots: 0 })
    expect(view.tokens.filter((t) => t.tier === 'prime' || t.tier === 'eligible')).toEqual([])
  })

  it('never counts a token we HOLD against the free slots', async () => {
    const store = await seed(byImpact({ OURS: 0.1, CHEAP: 0.2, MID: 0.3 }))
    await store.savePosition(position('OURS'))
    const view = await buildUniverse(store, { ...options, order: 'costEfficiency', freeSlots: 2 })
    expect(view.tokens.filter((t) => t.tier === 'prime' || t.tier === 'eligible').map((t) => t.symbol)).toEqual(['CHEAP', 'MID'])
  })

  it('lists the candidates in the engine’s order: cost efficiency first, the score only breaking a tie', async () => {
    const store = await seed(byImpact({ DEAR: 0.8, CHEAP: 0.1, MID: 0.3 }))
    const view = await buildUniverse(store, { ...options, order: 'costEfficiency', minScore: 0 })
    const listed = view.tokens.filter((t) => t.tier !== 'held' && t.tier !== 'filtered')
    expect(listed.map((t) => t.symbol)).toEqual(['CHEAP', 'MID', 'DEAR'])
  })

  it('says nothing about free slots when it was not told how many there are', async () => {
    const store = await seed(byImpact({ CHEAP: 0.1, MID: 0.3, DEAR: 0.8 }))
    const view = await buildUniverse(store, options)
    expect(view.freeSlots).toBeNull()
    expect(view.tokens.filter((t) => t.tier === 'filtered')).toEqual([])
  })
})

describe('universe — the hour each token moved, for the breadth bar', () => {
  // *Una barra de rojo a verde: si la mayoría están subiendo en la última hora,
  // del lado verde.* The bar counts the rows, so every row carries its hour.

  it('carries the last-hour change the scan read, and says so when nobody reported one', async () => {
    const store = await seed([
      token('RISE'),
      token('FALL', { priceChangePct: { h1: -2.5, h6: 0, h24: 0 } }),
      token('QUIET', { priceChangePct: { h1: null, h6: 0, h24: 0 } }),
    ])
    const view = await buildUniverse(store, options)
    const hour = new Map(view.tokens.map((t) => [t.symbol, t.change1hPct]))
    expect(hour.get('RISE')).toBe(6)
    expect(hour.get('FALL')).toBe(-2.5)
    expect(hour.get('QUIET')).toBeNull()
  })

  it('moves with the live market for a token we hold, so the bar moves with every poll', async () => {
    const store = await seed([token('OURS', { priceChangePct: { h1: 1, h6: 2, h24: 4 } })])
    await store.savePosition(position('OURS'))
    const view = await buildUniverse(store, {
      ...options,
      liveMarkets: async () =>
        new Map([['solana:OURS', { ...token('OURS'), priceChangePct: { h1: -7, h6: 2, h24: 4 } }]]),
    })
    expect(view.tokens[0]!.change1hPct).toBe(-7)
  })

  it('a position the scan did not mention reads its hour from the live feed, or does not claim one', async () => {
    const store = new MemoryStore()
    await store.savePosition(position('GONE'))
    const live = await buildUniverse(store, {
      ...options,
      liveMarkets: async () => new Map([['solana:GONE', { ...token('GONE'), priceChangePct: { h1: 3, h6: 0, h24: 0 } }]]),
    })
    expect(live.tokens[0]!.change1hPct).toBe(3)

    const silent = await buildUniverse(store, options)
    expect(silent.tokens[0]!.change1hPct).toBeNull()
  })
})
