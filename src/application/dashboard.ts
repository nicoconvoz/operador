import { type StatePort } from '../domain/persistence/store.js'

/**
 * The read model behind the dashboard.
 *
 * Lives in the application layer, not in the web app, for one reason: the
 * dashboard must never become a second place where the system's numbers are
 * computed. Two implementations of "how much are we up" will disagree, and the
 * one on the screen is the one you will believe.
 *
 * Read-only by construction. Nothing here can write, so a compromised
 * dashboard cannot trade.
 */

export interface PositionView {
  readonly id: string
  readonly symbol: string
  readonly chain: string
  readonly tokenAddress: string
  readonly capitalUsd: number
  /** DCA levels filled, not counting the initial entry. */
  readonly filledDcas: number
  readonly deathStage: 'healthy' | 'frozen' | 'dead'
  /** Why the death watch is not healthy, newest first. */
  readonly deathSignals: readonly string[]
  readonly lastPriceUsd: number | null
  readonly updatedAt: number
  /** True when an order has been decided and is waiting for the next bar's open. */
  readonly hasPendingOrders: boolean
}

export interface DashboardView {
  readonly generatedAt: number
  readonly killSwitchEngaged: boolean
  readonly lastCompletedBar: number | null
  readonly positions: readonly PositionView[]
  readonly totals: {
    readonly positions: number
    readonly committedUsd: number
    readonly frozen: number
    readonly pending: number
  }
  readonly blacklistedCount: number
  /** When the scanner last ran, and how much it looked at. */
  readonly lastScan: { readonly at: number; readonly tokensSeen: number } | null
  /**
   * Warnings a human should act on, plainest first. Empty is the good case,
   * and an empty list is a stronger signal than a green badge nobody reads.
   */
  readonly warnings: readonly string[]
}

export interface DashboardOptions {
  readonly now: () => number
  /** A position untouched for longer than this is reported as stale. */
  readonly staleAfterMs?: number
}

export async function buildDashboard(store: StatePort, options: DashboardOptions): Promise<DashboardView> {
  const generatedAt = options.now()
  const staleAfterMs = options.staleAfterMs ?? 2 * 60 * 60 * 1000

  const [positions, checkpoint, blacklisted, scan] = await Promise.all([
    store.loadPositions(),
    store.loadCheckpoint(),
    store.blacklisted(),
    store.latestScan(),
  ])

  const views: PositionView[] = positions.map((p) => ({
    id: p.id,
    symbol: p.symbol,
    chain: p.chain,
    tokenAddress: p.tokenAddress,
    capitalUsd: p.capitalUsd,
    filledDcas: p.cascade.level > 0 ? p.cascade.level - 1 : 0,
    deathStage: p.deathWatch.stage,
    deathSignals: [...p.deathWatch.evidence]
      .reverse()
      .flatMap((record) => record.signals.map((signal) => signal.detail))
      .slice(0, 3),
    lastPriceUsd: p.lastPriceUsd,
    updatedAt: p.updatedAt,
    hasPendingOrders: p.pendingOrders.length > 0,
  }))

  const warnings: string[] = []
  if (checkpoint?.killSwitchEngaged) warnings.push('Corte de emergencia activo — no se abrirán posiciones nuevas.')

  // A pending order is NORMAL: an order decided at a close fills at the next
  // bar's open, so every position that just decided something is carrying one.
  // Warning on that fired constantly during healthy operation, and a warning
  // that cries wolf costs you the one that matters.
  //
  // The anomaly is an order that should have filled and did not — which is the
  // same staleness the check below measures, so it uses the same window.
  const stuck = views.filter((v) => v.hasPendingOrders && generatedAt - v.updatedAt > staleAfterMs)
  if (stuck.length > 0) {
    warnings.push(`${stuck.length} posición(es) con una orden sin ejecutar hace horas: ${stuck.map((v) => v.symbol).join(', ')}.`)
  }

  const frozen = views.filter((v) => v.deathStage === 'frozen')
  if (frozen.length > 0) {
    warnings.push(`${frozen.length} posición(es) congelada(s): ${frozen.map((v) => v.symbol).join(', ')}.`)
  }

  const stale = views.filter((v) => generatedAt - v.updatedAt > staleAfterMs)
  if (stale.length > 0) {
    const hours = Math.round(staleAfterMs / 3_600_000)
    const names = stale.map((v) => v.symbol).join(', ')
    // WHICH one stopped — the engine, or the token? That distinction is the
    // whole diagnosis, and the warning used to skip it and accuse the engine
    // every time. Reported live with the engine demonstrably fine: six
    // positions had just advanced to the newest bar while three had not.
    //
    // All of them stale is an engine that stopped. SOME of them, while the
    // rest advance, is those tokens going quiet — their pools stopped
    // producing candles, so there is no new bar to act on. That is the
    // abandonment signal's territory, not an outage.
    //
    // A warning that names the wrong suspect sends the reader to check the
    // wrong thing, and the next warning gets believed a little less.
    warnings.push(
      stale.length === views.length
        ? `Ninguna posición avanzó en ${hours}h — revisá si el motor está corriendo.`
        : `${names}: sin barras nuevas hace más de ${hours}h. El motor sigue avanzando las demás, así que dejó de operarse ese token.`,
    )
  }

  if (positions.length === 0 && !checkpoint) {
    warnings.push('Sin posiciones y sin checkpoint: el motor nunca completó un ciclo.')
  }

  return {
    generatedAt,
    killSwitchEngaged: checkpoint?.killSwitchEngaged ?? false,
    // Zero is not a bar, it is the ABSENCE of one: a cycle that opened
    // positions without ticking any of them checkpoints a lastCompletedBar of
    // zero, and rendering that literally puts "1 Jan 1970" on the screen. On a
    // money screen an epoch date reads as a dead engine, which is a worse lie
    // than showing nothing at all. No market ever traded a bar at zero.
    lastCompletedBar: checkpoint?.lastCompletedBar || null,
    positions: views,
    totals: {
      positions: views.length,
      committedUsd: views.reduce((sum, v) => sum + v.capitalUsd, 0),
      frozen: frozen.length,
      pending: views.filter((v) => v.hasPendingOrders).length,
    },
    blacklistedCount: blacklisted.size,
    lastScan: scan ? { at: scan.scannedAt, tokensSeen: scan.snapshots.length } : null,
    warnings,
  }
}
