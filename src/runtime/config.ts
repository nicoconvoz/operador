import { isTokenTier, type TokenTier } from '../domain/risk/token-tier.js'
import { type Chain } from '../domain/scanner/snapshot.js'
import { productionDoors } from '../application/production-doors.js'
import { productionLadder } from '../application/production-ladder.js'
import { type CandidateOrder } from '../domain/scanner/ranking.js'
import { FLAT_ONE_PCT_STOP, type StopLossPolicy } from '../domain/risk/stop-loss.js'
import { DEFAULT_MAX_SWAP_LOSS_PCT } from '../domain/risk/idle-slots.js'
import { DEFAULT_GAIN_LOCK_POLICY, type GainLockPolicy } from '../domain/risk/gain-lock.js'

/**
 * Dollars a single token gets, before the pool impact budget shrinks it.
 *
 * The operator number. With a wide shortlist an even split of the capital
 * would hand each of two hundred names a rung too small to pay its own gas;
 * a fixed size makes the BOOK grow with the shortlist instead of the
 * positions shrinking with it.
 */
export const DEFAULT_USD_PER_TOKEN = 15

/**
 * The share of a winner gross gain the chain is allowed to take.
 *
 * A THIRD. At $15 a position that makes the exit ask 3.9% instead of 2%, and
 * the net per winner goes from eleven cents to thirty-nine — because the round
 * trip is about 1.3% and a 2% target was barely above it.
 *
 * OFF in production now (`OPERADOR_MAX_COST_SHARE_PCT` unset reads zero): *vendé
 * si el promedio de todos los 1 sumados + 10% de ese promedio.* A $1 step pays
 * $0.05 of gas — five percent on the way in — so the target derived from the
 * round trip of one step would ask the exit for about +35%, and the operator's
 * +10% would never be the line. Set it to bring the derivation back.
 */
export const DEFAULT_MAX_COST_SHARE_PCT = 33

/**
 * Where the break-even arms and where an armed position sells, in percent over
 * its average cost. *Poné el break-even en 7.5.*
 *
 * The operator's answer to *calibrá para que las ganancias sean las máximas y
 * las pérdidas las mínimas*, in place of a fixed take-profit. A fixed TP would
 * have cut the runners: fifteen real TP cycles made $5–$21 each — $133.60 of
 * the $439.87 the strategy's own exit earned — at +32% to +120%. So nothing is
 * sold on the way UP: the ratchet arms at +7.5% and, once armed, sells only if
 * the price falls back to +7.5%, locking the gain it had reached. Above that
 * the position runs, and the strategy's exit takes the top.
 */
export const DEFAULT_BREAK_EVEN_ARM_PCT = 7.5
export const DEFAULT_BREAK_EVEN_FLOOR_PCT = 7.5
import { FIFTEEN_MINUTES, ONE_HOUR, type BarSize } from '../infrastructure/adapters/geckoterminal/geckoterminal.js'

/**
 * Runtime configuration, read from the environment.
 *
 * Validated eagerly and loudly at boot. A system that holds money must never
 * discover a missing wallet key three hours in, halfway through a ladder —
 * failing to start is a good outcome; starting wrong is not.
 */

export interface RuntimeConfig {
  readonly mode: 'paper' | 'live'
  /**
   * Every chain the scanner covers, in order. A LIST and not one value,
   * because the universe spans chains: running one at a time meant the screen
   * showed whichever scanned last and the other looked like it had stopped
   * existing.
   */
  readonly chains: readonly Chain[]

  readonly databaseUrl: string

  readonly totalCapitalUsd: number
  readonly maxPositions: number
  readonly gasUsdPerSwap: number

  /**
   * How long between PASSES.
   *
   * Most passes are watch passes: recover, advance every open position,
   * checkpoint. On 15-minute bars this is what decides how quickly a closed bar
   * gets acted on — five minutes means a bar is processed within five, instead
   * of waiting out a scan.
   */
  readonly cycleIntervalMs: number
  /**
   * How often a pass ALSO goes looking for new tokens.
   *
   * Separate from the pass interval because the two halves cost wildly
   * different amounts: a scan is hundreds of throttled calls and about half an
   * hour, while advancing five open positions is one candle request and one
   * sell probe each. Sharing a clock meant a held token got attention every
   * ~35 minutes on 15-minute bars.
   *
   * ONE HOUR, the user's decision: scan only when there is no scan from the
   * last hour, and spend the rest of the engine's life on the positions that
   * already have money in them.
   *
   * A token you HOLD can rug in ten minutes; a new opportunity missed by an
   * hour is a missed opportunity and nothing worse.
   */
  readonly scanIntervalMs: number
  readonly heldScanIntervalMs: number
  /** How often the death watch re-probes the sell path of open positions. */
  readonly healthIntervalMs: number
  /**
   * Stop after this many cycles. 0 means never — the daemon.
   *
   * 1 turns the engine into a ONE-SHOT: do a cycle, write everything down,
   * exit. That is what lets a scheduler run it instead of a server, and it is
   * only honest because every adapter is HTTP polling and every piece of state
   * is in Postgres. Nothing is held in memory between cycles, so there is
   * nothing for a long-lived process to hold.
   */
  readonly maxCycles: number
  /**
   * Tokens per chain given the expensive treatment each cycle.
   *
   * Each one costs about nine throttled seconds on Solana and six on BSC, and
   * a cycle has to finish well inside one 15-minute bar. 20 keeps two chains
   * around five minutes. The rest are reported as unchecked, not dropped.
   */
  readonly maxSecurityChecks: number | null
  /**
   * Sell a position the moment its ladder freezes, instead of holding it.
   *
   * The operator's decision, and it is a real departure from the reference: a
   * freeze fires on ONE reading, so this liquidates where the two-stage design
   * would have paused and asked for confirmation. What it buys is the failure
   * that actually happened — six positions frozen with their capital
   * unreachable, unable to buy because frozen and unable to sell because the
   * strategy's own exit wants a profit it will never reach.
   *
   * The token is not blacklisted by the sale itself — see `blacklistOnFreeze`,
   * which bans it once the slot is released and holds nothing.
   */
  readonly exitOnFreeze: boolean
  /**
   * Blacklist a token when its frozen slot is released, so it is never bought
   * back. ON by default: *no me gustó que las congeladas ... no pasen a la lista
   * negra.* On the replay it cost about $6 over 336 entries and removed GO —
   * bought back thirty minutes after a half-liquidity freeze, now −54% — and
   * ASTEROID, bought back and $9.29 more lost. `OPERADOR_BLACKLIST_ON_FREEZE=0`
   * restores the old rule, where a frozen token went back to the filtered pile.
   */
  readonly blacklistOnFreeze: boolean
  /**
   * Hours without a single trade before the death watch freezes a position —
   * and, with `exitOnFreeze`, sells it and bans the token on release.
   *
   * OFF in production (Infinity): *ya no quiero que vendan por dos horas sin
   * operaciones, sacalo.* It was two — *las que no tengan barras en 2h,
   * congelarlas y recuperar el dinero* — and with `exitOnFreeze` a freeze is a
   * sale. A number in OPERADOR_ABANDON_FREEZE_HOURS brings it back. The
   * reference's three stays in `DEFAULT_DEATH_EXIT_POLICY`; the death exit at
   * twelve hours without a trade is unchanged.
   */
  readonly abandonFreezeHours: number
  /**
   * USD cap per ladder level, in production.
   *
   * NOT `DEFAULT_PARAMS.maxUsdPerLevel`, which is 5,000 because that is what
   * TradingView ran — the parity harness asserts those params are exactly the
   * backtest's inputs, so they are evidence and must not be edited to express
   * a preference.
   *
   * 15 is the user's decision for 15-minute bars, and it changes the SHAPE of
   * the ladder as well as its size: `min(1000 × (1 + 1.2n), 15)` is $15 at
   * every level, so the ladder is flat rather than growing. Ten fills come to
   * $150, where gas at $0.05 a swap is 0.33% of each — which is what makes a
   * ladder this small viable at all.
   *
   * Raise it as the capital grows. That was always the plan.
   */
  readonly maxUsdPerLevel: number
  /**
   * Drop from the 20-bar swing high the classic entry demands, in percent.
   *
   * ZERO in production, against the reference's 10. See the note in
   * `application/production-ladder.ts`: twenty-two of forty positions had never
   * bought anything, and an average entry that happens beats a good one that
   * never does.
   */
  readonly dropInitPct: number
  /** The least the strategy exit sells for, in percent over the average cost. */
  readonly minProfitPct: number
  /**
   * The FIXED take-profit, in percent over the average cost: the sweep sells
   * the whole holding at the first live price at or over it. Zero: off. See
   * `domain/strategy/fixed-tp.ts`.
   */
  readonly fixedTpPct: number
  /** Gains at which the exit stops waiting for the impulse to die. */
  readonly impatientProfitPct: number
  readonly urgentProfitPct: number
  /**
   * Hours a reserved slot may sit without a single fill before it goes back to
   * the pool.
   *
   * A slot is handed to a token BEFORE the strategy enters it, so a token whose
   * gates never line up holds capital and a slot against nothing. Three hours
   * is twelve bars at 15m — most of the 20-bar swing-high window the classic
   * entry gate looks back over, so the setup had a fair chance.
   */
  readonly idleSlotHours: number
  /**
   * DCA rungs production will actually fill, per token. Entry is not one of
   * them, so 1 means two open entries.
   *
   * NOT `PYRAMIDING`, which is 10 because that is what the `strategy()` header
   * ran and the parity harness asserts it. Evidence, not a preference.
   *
   * NINETEEN — twenty dip-bounce steps, the first buy included, so the venue
   * holds twenty entries. It was ONE, the deep rung, and FIVE, ladder A. The
   * history of the number, and why it moved each time, is in
   * `application/production-ladder.ts`.
   */
  readonly maxDcaPerToken: number
  /** What the first dip-bounce buy is, in dollars; later ones grow by `stepGrowth`. */
  readonly stepUsd: number
  /** How much each step grows over the one before: two doubles them. */
  readonly stepGrowth: number
  /** Dip-bounce buys per holding, the first included. */
  readonly maxSteps: number
  /** The dip under the reference that arms the watch, in percent. */
  readonly dipPct: number
  /** The bounce off the low that buys, in percent. */
  readonly bouncePct: number
  /** A fall of more than this under the reference, in percent, is a collapse: no step buys. Zero: off. OPERADOR_MAX_DIP_PCT. */
  readonly maxDipPct: number
  /** Points each DCA after the first adds to the dip and to the collapse ceiling. Zero: flat. OPERADOR_DIP_STEP_PCT. */
  readonly dipStepPct: number
  /** Points each DCA after the first adds to the bounce. Zero: flat. OPERADOR_BOUNCE_STEP_PCT. */
  readonly bounceStepPct: number
  /**
   * What one slot is given, exactly: steps × step. *El tope son 5000 dividido
   * 50, que es lo que tengo* — the book holds capital / slot tokens, and no
   * other ceiling.
   */
  readonly slotUsd: number
  /** Whether the deep rung buys at all. OFF; OPERADOR_DEEP_RUNG=1. */
  readonly deepRung: boolean
  /** Whether the cascade's own doors may buy. OFF; OPERADOR_CASCADE_ENTRIES=1. */
  readonly cascadeEntries: boolean
  /** Who wins when there are more candidates than free slots. See `DEFAULT_CANDIDATE_ORDER`. */
  readonly order: CandidateOrder
  /** Points of cost efficiency a waiting candidate must beat a reservation by. */
  readonly minCostEdgePct: number
  /** Percent a candidate must move every five minutes to enter. Zero is off. See `DEFAULT_MIN_VOLATILITY_PCT`. */
  readonly minVolatilityPct: number
  /**
   * How far a scan may read the permanent registry, busiest first — an upper
   * bound, never a read size: it reads a page at a time and only while the
   * free slots are still short. Infinity when unset: the whole registry, if
   * the slots need it. OPERADOR_REGISTRY_TOKENS bounds it.
   */
  readonly registryTokens: number
  /**
   * Entries' worth of capital a position is allocated when it opens: every
   * step, the whole ladder — twenty. The fees each step pays beyond its dollar
   * are asked of the free capital as it fills. See `DEFAULT_RESERVED_ENTRIES`.
   */
  readonly reservedEntries: number
  /**
   * Require every window the momentum rule reads to be GREEN before a token is
   * a candidate: h6 > 0, h1 > 0 and m5 > 0.
   *
   * The operator's strategy: *sacá todos los filtros mientras haya liquidez...
   * mirá las últimas 4 horas, que no haya bajado de 0% y que se haya
   * incrementado en el total del tiempo hasta los 5m.*
   *
   * On by default, because it IS the strategy now. It is still a flag rather
   * than a deletion: the reference behaviour is one value away, and the day
   * this turns out to be worse than what it replaced, nobody has to rewrite
   * the ranking to find out.
   */
  readonly requireRising: boolean
  /**
   * Whether the executor buys as soon as a slot is handed to it, with no
   * indicator condition.
   *
   * SEPARATE from `requireRising`, and it had to be pulled apart. The two were
   * one switch because the momentum rule needed door 3 — the scanner selects
   * risers and the classic door refuses a bar making a new high, so without it
   * sixteen candidates produced five positions.
   *
   * They are different questions. This one asks HOW the executor enters; the
   * other asks WHICH tokens are worth entering. Leaving them tied meant that
   * turning the selection rule off also closed the only door those tokens can
   * come through — the engine would have chosen a wide shortlist and bought
   * none of it.
   *
   * It is the dip-bounce's FIRST step now, bought by the cycle in the pass that
   * opened the slot (`dipBounce.onSelection`), never the cascade's door 3. ON
   * by default; OPERADOR_BUY_ON_SELECTION=0.
   */
  readonly buyOnSelection: boolean
  /**
   * The LIVE PRICE instead of the candles: each pass ticks a position on one
   * bar made of the price it already fetched. *Quiero el precio directamente.*
   * ON; OPERADOR_LIVE_PRICE=0 brings the candle downloads back.
   */
  readonly livePrice: boolean
  /**
   * Hours without a buy after which a position asks one short read of real
   * candles, so the death watch can still see a pool that stopped trading.
   * *Si ha pasado mucho tiempo sin actuar, ahí sí consultamos sólo la última
   * vela.* OPERADOR_STALE_CHECK_HOURS, 6.
   */
  readonly staleCheckHours: number
  /**
   * Fixed dollars per token, or absent to split the capital among whoever
   * qualified.
   *
   * The operator's instruction: *comprá solo 15 usd por moneda.* With a wide
   * shortlist that is the sane shape — an even split across two hundred names
   * would hand each one a rung too small to pay its own gas, and the count is
   * no longer bounded by how strict the rules are.
   */
  readonly usdPerToken: number | null
  /** Whether a held position rotates out when its filter switches off. */
  readonly rotateOnFilter: boolean
  /** Whether the buy-pressure ladder and its sale run at all. */
  readonly pressure: boolean
  /**
   * The take-profit on buy pressure: runs past `armPct` of gain and sells on
   * a `dropPct` fall of buyers' share from its peak. Zero `dropPct` is off.
   */
  readonly pressureTp: { readonly armPct: number; readonly dropPct: number }
  /** The crash stop: more than `dropPct` down inside `windowMs` sells. Zero `dropPct` is off. */
  readonly crashStop: { readonly dropPct: number; readonly windowMs: number }
  /** Each buy sized by the token's class (`token-tier.ts`). ON; OPERADOR_TIERS=0 is the flat step. */
  readonly tiers: boolean
  /** The lowest class bought. `good`: *dejame las que califiquen como 15 y 25.* OPERADOR_MIN_TIER. */
  readonly minTier: TokenTier
  /** Whether the death watch observes held tokens at all. OFF; OPERADOR_DEATH_WATCH=1 brings it back. */
  readonly deathWatch: boolean
  /** Whether the strategy's own TP sells. OFF: *no uses el TP antiguo.* OPERADOR_STRATEGY_EXIT=1. */
  readonly strategyExit: boolean
  /** How far under its anchor each DCA rung buys, in percent, DCA-1 first. */
  readonly dcaDropsPct: readonly number[]
  /** What each DCA rung buys, in dollars, DCA-1 first — one per drop. */
  readonly dcaRungsUsd: readonly number[]
  /** What each drop is measured from: the previous buy in production. */
  readonly dcaFrom: 'first' | 'previous'
  /**
   * Whether the chained drop ladder buys at all. OFF: only the deep rung buys
   * after the entry. OPERADOR_DROP_LADDER=1 brings it back.
   */
  readonly dropLadder: boolean
  /**
   * The deep rung: *si el precio cae más de 80% y hay un rebote de 10%, nueva
   * compra DCA de $20.* How far under the first buy the low must go, strictly;
   * how far over that low the price must come back; what it buys.
   */
  readonly deepRungFallPct: number
  readonly deepRungReboundPct: number
  readonly deepRungUsd: number
  /**
   * Whether each position's drops follow its own `dcaScale` — the more the
   * token moves, the closer its rungs. OFF; OPERADOR_DCA_ADAPTIVE=1 turns it on.
   */
  readonly dcaAdaptive: boolean
  /**
   * Whether the NEXT rung is spaced by the token's last hour of 5-minute bars,
   * decided when the sweep looks at it. OFF; OPERADOR_DCA_REALTIME=1 turns it
   * on. Only inside `dcaAdaptive`: with that off, nothing is scaled at all.
   */
  readonly dcaRealtime: boolean
  /**
   * How far, in percent, a pool may have lost liquidity over the last five
   * minutes or the last hour before a DCA rung at its line waits — and off
   * whose minimum a bounce buys. 0, off; OPERADOR_LIQUIDITY_BRAKE_PCT=5 turns
   * it on.
   */
  readonly liquidityBrakePct: number
  /** Whether a position holding tokens may be sold for a better token. */
  readonly swapHolders: boolean
  /** Points under the entry score at which a held position is sold. Zero: off. */
  readonly scoreStopPoints: number
  /** The ways a candidate may be OPENED, any one enough. See `DEFAULT_ENTRY_DOORS`. */
  readonly entryDoors: readonly import('../domain/scanner/opportunity.js').ComponentFloors[]
  /**
   * The component floors a candidate must clear — today NONE: *puerta de
   * entrada ninguna*. See `DEFAULT_COMPONENT_FLOORS`. The scan and the shelf both rank
   * with it, and the dashboard reads the same module.
   */
  readonly minComponents: import('../domain/scanner/opportunity.js').ComponentFloors
  /** Whether a token failing only a preference gate may still be bought. See `ProductionDoors`. */
  readonly reserve: boolean
  /**
   * How much of a winner gross gain the chain may eat, in percent.
   *
   * The exit target is DERIVED from it instead of being the flat 2 the
   * reference runs: at a third, the target is three times the round trip and
   * two thirds of every winner is ours.
   *
   * A third is the operator number in the shape this codebase states costs —
   * the same form as `maxGasSharePct`, which asks how much of a fill gas may
   * eat. Composed in production beside the ladder cap and the entry drop,
   * because it is a real departure from the backtest.
   */
  readonly maxCostSharePct: number
  readonly rewardRiskRatio: number
  readonly breakEven: boolean
  /** Where the break-even arms, in percent over the average cost. */
  readonly breakEvenArmPct: number
  /** Where an ARMED position sells. Never above the arm. */
  readonly breakEvenFloorPct: number
  /**
   * The stepped gain lock, or null when switched off. *Si pasás el 20% de
   * ganancia, break-even en el 10%; con cada aumento de 20%, aumentar el
   * break-even 10%.* See `domain/risk/gain-lock.ts`.
   */
  readonly gainLock: GainLockPolicy | null
  readonly maxStopPct: number
  /**
   * How much of a loss the allocator may pay to move a slot to a better token.
   *
   * Zero disables it, and zero is a REAL value here: it restores the rule this
   * engine ran on for months — a slot holding tokens is never the allocator to
   * sell.
   */
  readonly maxSwapLossPct: number
  /**
   * How far a position may fall below what was paid before it is closed, as a
   * share of the run the token had already made.
   *
   * One twentieth, floored at 5% and capped at 50% — the operator's numbers:
   * *si es de 1000%, 50% de lo invertido, ese es el techo; si es 500%, 25%.*
   */
  readonly stopLoss: StopLossPolicy
  /**
   * How many points better a waiting candidate must score to take a flat
   * position's slot.
   *
   * Not zero on purpose: the opportunity score is a heuristic that moves bar to
   * bar, so swapping on any difference would trade the book against its own
   * noise and pay gas for it.
   */
  readonly minScoreEdge: number
  /**
   * The lowest opportunity score the book will open a position on.
   *
   * A DOOR, not a weight, and that distinction is the whole design. The same
   * preference was first expressed by raising `costEfficiency` from 0.2 to
   * 0.9, which worked and cost too much: a weighted average has one
   * denominator, so weight added anywhere is share taken everywhere and every
   * score in the book fell — for a change in our arithmetic, not in the
   * market. A threshold read against the old scale was then silently wrong.
   *
   * This reads the score AFTER it is computed and changes nothing about it,
   * so the number the operator remembers is the number he still sees.
   *
   * Zero is a REAL value here — "let everything through", never "unset".
   * `dropInitPct` learned that the expensive way.
   */
  readonly minScore: number

  readonly solanaRpcUrl: string
  readonly bscRpcUrl: string

  /**
   * Bar size the strategy runs on. 15m in production.
   *
   * 1H is what the parity harness proved against TradingView — that test shows
   * the PORT is faithful, and it stays green whatever bar size runs live.
   */
  readonly barSize: BarSize
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

type Env = Readonly<Record<string, string | undefined>>

const required = (env: Env, key: string): string => {
  const value = env[key]?.trim()
  if (!value) throw new ConfigError(`${key} is required`)
  return value
}

/** Same as `number`, but zero is a meaningful value rather than an error. */
const numberOrZero = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new ConfigError(`${key} must be zero or a positive number, got "${raw}"`)
  return value
}

/**
 * A switch that is ON unless it is explicitly turned off.
 *
 * Only '0', 'false' and 'no' turn it off. A typo leaves it ON, which is the
 * safe direction for a switch whose job is to recover capital: the failure it
 * guards against is money stuck in a position nobody can trade.
 */
/** OFF unless set to 1, true or yes. */
const onlyIf = (env: Env, key: string): boolean => ['1', 'true', 'yes'].includes(env[key]?.trim().toLowerCase() ?? '')

const onUnless = (env: Env, key: string): boolean => {
  const raw = env[key]?.trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'no')
}

/**
 * A percentage in [min, 100), or null when absent or nonsense. For the lines
 * whose rule is "nonsense falls back to the decision", not "nonsense refuses
 * to boot": a mistyped break-even must not stop the engine that protects the
 * book, and falling back to the operator's own number is the safe direction.
 */
const percentOrNull = (env: Env, key: string, above: number): number | null => {
  const raw = env[key]?.trim()
  const value = Number(raw)
  return raw && Number.isFinite(value) && value >= above && value < 100 ? value : null
}

const number = (env: Env, key: string, fallback: number): number => {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) throw new ConfigError(`${key} must be a positive number, got "${raw}"`)
  return value
}

export function loadConfig(env: Env = process.env): RuntimeConfig {
  const mode = env.OPERADOR_MODE?.trim() ?? 'paper'
  if (mode !== 'paper' && mode !== 'live') throw new ConfigError(`OPERADOR_MODE must be "paper" or "live", got "${mode}"`)

  // "solana", "bsc", or "solana,bsc".
  const chains = (env.OPERADOR_CHAIN?.trim() || 'solana')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
  for (const name of chains) {
    if (name !== 'solana' && name !== 'bsc') {
      throw new ConfigError(`OPERADOR_CHAIN accepts "solana", "bsc" or "solana,bsc"; got "${name}"`)
    }
  }
  if (chains.length === 0) throw new ConfigError('OPERADOR_CHAIN must name at least one chain')

  // 15m by default, chosen from live trading rather than from the backtest:
  // on young tokens an hour is long enough for the move to be over before the
  // strategy has an opinion. The 1H parity run remains the proof that the PORT
  // is faithful; the bar size is a separate decision, and this one is the
  // user's, made with money on a real chart.
  const timeframe = env.OPERADOR_TIMEFRAME?.trim() ?? '15m'
  if (timeframe !== '1h' && timeframe !== '15m') throw new ConfigError(`OPERADOR_TIMEFRAME must be "1h" or "15m", got "${timeframe}"`)

  // The break-even's two lines. The arm must be above zero — a ratchet armed at
  // cost is a stop — and the floor may be anything from cost up to the arm,
  // never above it: a floor over the arm sells the position on the very sweep
  // that armed it, which is a fixed take-profit wearing the ratchet's name.
  const breakEvenArmPct = percentOrNull(env, 'OPERADOR_BREAK_EVEN_ARM_PCT', Number.MIN_VALUE) ?? DEFAULT_BREAK_EVEN_ARM_PCT
  const floorAsked = percentOrNull(env, 'OPERADOR_BREAK_EVEN_FLOOR_PCT', 0)
  const breakEvenFloorPct =
    floorAsked !== null && floorAsked <= breakEvenArmPct ? floorAsked : Math.min(DEFAULT_BREAK_EVEN_FLOOR_PCT, breakEvenArmPct)

  const config: RuntimeConfig = {
    mode,
    chains: chains as readonly Chain[],
    databaseUrl: required(env, 'DATABASE_URL'),
    totalCapitalUsd: number(env, 'OPERADOR_CAPITAL_USD', 1_000),
    // ZERO means no ceiling: the capital decides, at one ladder's worth each.
    // That is the honest default once every slot is the same size — what bounds
    // the damage one token can do is then the SIZE of a slot, not how many
    // there are, and a count cap only leaves capital idle. $1,500 at a $95
    // ladder is about fourteen tokens; five was paired with $200 slots.
    maxPositions: numberOrZero(env, 'OPERADOR_MAX_POSITIONS', 0),
    gasUsdPerSwap: number(env, 'OPERADOR_GAS_USD', 0.05),
    cycleIntervalMs: number(env, 'OPERADOR_CYCLE_MS', 5 * 60 * 1000),
    // TWO hours. The full sweep now asks GeckoTerminal for every page it
    // will give, on every pass rather than only on a cold one, so it is a
    // deliberate event rather than a background hum. The held pass (20 min)
    // and the watch (5 min) are what keep the book current in between.
    scanIntervalMs: number(env, 'OPERADOR_SCAN_MS', 2 * 60 * 60 * 1000),
    // The urgent half of a scan, on its own clock: re-examine the BOOK without
    // discovering anything. Twenty minutes against the full scan's hour,
    // because a token holding money can rug in ten minutes while one that does
    // not is only a missed opportunity.
    heldScanIntervalMs: number(env, 'OPERADOR_HELD_SCAN_MS', 20 * 60 * 1000),
    healthIntervalMs: number(env, 'OPERADOR_HEALTH_MS', 10 * 60 * 1000),
    // Zero means "never — the daemon", and `number()` rejects zero. The
    // behaviour therefore existed only while the variable was UNSET: writing
    // its own documented value into it threw at boot. The same sentinel trap
    // as maxPositions, left in the one place it was not fixed.
    maxCycles: numberOrZero(env, 'OPERADOR_MAX_CYCLES', 0),
    // NULL BY DEFAULT — every token that cleared the free gates is examined.
    //
    // The cap of 20 answered a question that has since been re-measured. It was
    // set when a scan cost 384 seconds and each examination was a thousand-row
    // candle download, so a cycle could not finish inside a bar without one. The
    // free gates now reject about ninety percent (57 of 480 on Solana, 41 of 452
    // on BSC, measured), the history count asks for 250 rows instead of 1,000,
    // and a scan runs once an HOUR while watch passes every five minutes look
    // after the money. Ninety-eight examinations at 2.5s is four minutes.
    //
    // A cap is now something you ASK for — on a day the providers are unhappy —
    // rather than something you get. Absent means unbounded; zero is REFUSED
    // rather than read as "no limit", because `maxPositions: 0` meaning "no
    // ceiling" in one file and "zero slots" in the next one cost this engine
    // every position it could have opened. A value that means one thing here and
    // its opposite there is not a sentinel, it is a trap.
    maxSecurityChecks: env.OPERADOR_MAX_SECURITY_CHECKS?.trim() ? number(env, 'OPERADOR_MAX_SECURITY_CHECKS', 0) : null,
    exitOnFreeze: onUnless(env, 'OPERADOR_EXIT_ON_FREEZE'),
    // ON: *y además que no pasen a la lista negra.* A frozen token is banned
    // once its slot is released and holds nothing. OPERADOR_BLACKLIST_ON_FREEZE=0
    // turns it off.
    // 24/09 (2026-10-08): a frozen token is not banned, and three hours
    // without a trade freezes.
    blacklistOnFreeze: onlyIf(env, 'OPERADOR_BLACKLIST_ON_FREEZE'),
    abandonFreezeHours: number(env, 'OPERADOR_ABANDON_FREEZE_HOURS', 3),
    // One step, from the module the dashboard reads: the ladder a slot is
    // priced with is the ladder the sweep buys.
    maxUsdPerLevel: number(env, 'OPERADOR_MAX_USD_PER_LEVEL', productionLadder(env).maxUsdPerLevel),
    dropInitPct: productionLadder(env).dropInitPct,
    minProfitPct: productionLadder(env).minProfitPct,
    // *Poné un TP fijo al 12.5% del promedio.* From the module the dashboard
    // reads, so the card draws the line the sweep sells at.
    fixedTpPct: productionLadder(env).fixedTpPct,
    impatientProfitPct: productionLadder(env).impatientProfitPct,
    urgentProfitPct: productionLadder(env).urgentProfitPct,
    idleSlotHours: number(env, 'OPERADOR_IDLE_HOURS', 3),
    // Every step the venue must hold: twenty, the first buy included.
    maxDcaPerToken: number(env, 'OPERADOR_MAX_DCA', productionLadder(env).maxOpenEntries - 1),
    // The whole ladder reserved, capped by what the venue holds, from the same
    // module the dashboard reads.
    reservedEntries: Math.min(
      productionLadder(env).reservedEntries,
      number(env, 'OPERADOR_MAX_DCA', productionLadder(env).maxOpenEntries - 1) + 1,
    ),
    stepUsd: productionLadder(env).stepUsd,
    stepGrowth: productionLadder(env).stepGrowth,
    maxSteps: productionLadder(env).maxSteps,
    dipPct: productionLadder(env).dipPct,
    bouncePct: productionLadder(env).bouncePct,
    maxDipPct: productionLadder(env).maxDipPct,
    dipStepPct: productionLadder(env).dipStepPct,
    bounceStepPct: productionLadder(env).bounceStepPct,
    slotUsd: productionLadder(env).slotUsd,
    deepRung: productionLadder(env).deepRung,
    cascadeEntries: productionLadder(env).cascadeEntries,
    order: productionDoors(env).order,
    minCostEdgePct: productionDoors(env).minCostEdgePct,
    minVolatilityPct: productionDoors(env).minVolatilityPct,
    registryTokens: env.OPERADOR_REGISTRY_TOKENS?.trim() ? number(env, 'OPERADOR_REGISTRY_TOKENS', 1) : Number.POSITIVE_INFINITY,
    // Only an explicit "0" or "false" turns these off. A misspelt value must
    // not silently disable the strategy the engine is running, which is the
    // failure `OPERADOR_MAX_DCA=0` taught this codebase twice.
    // OFF now: *dejá pasar todas las monedas que tengan más de 100k de
    // liquidez y menos del 50% topholders.* Liquidity and concentration are
    // the whole rule, and the momentum window is not part of it any more.
    requireRising: (env.OPERADOR_REQUIRE_RISING ?? '0').trim() === '1',
    // ON: *y además que la primera compra entre automáticamente.* The FIRST
    // dip-bounce step is bought in the pass that opens the slot; every later
    // one waits for a 3% dip and a 2% bounce. It was off — *nada se compra
    // cuando una moneda pasa a candidata* — and only an explicit 0 or false
    // puts it back off.
    buyOnSelection: onUnless(env, 'OPERADOR_BUY_ON_SELECTION'),
    // OFF since 2026-10-08: the strategy's TP reads real candles.
    // OPERADOR_LIVE_PRICE=1 brings the one-bar live tick back.
    livePrice: onlyIf(env, 'OPERADOR_LIVE_PRICE'),
    staleCheckHours: number(env, 'OPERADOR_STALE_CHECK_HOURS', 6),
    // Unset: exactly one slot, steps × step, set below — nothing grossed up.
    usdPerToken: env.OPERADOR_USD_PER_TOKEN?.trim() ? number(env, 'OPERADOR_USD_PER_TOKEN', DEFAULT_USD_PER_TOKEN) : null,
    // ZERO — off — by default: the target a $1 step's round trip derives would
    // lift the operator's +10% to about +35%. See `DEFAULT_MAX_COST_SHARE_PCT`.
    // 24/09 again: the TP target is what keeps costs under a third of the gain.
    maxCostSharePct: numberOrZero(env, 'OPERADOR_MAX_COST_SHARE_PCT', 33),
    // *Hacé la relación 1:4, quiero ver si aguanta mejor.* Four times the
    // stop, NET of the round trip — which on a $15 fill is 1.38% and lands on
    // both sides of the trade, so the advertised 1:3.9 was really 1:1.06.
    //
    // Zero turns it off and the cost floor decides alone, exactly as before.
    rewardRiskRatio: number(env, 'OPERADOR_REWARD_RISK', 4),
    // *Un break even.* A position that reached its target may never close at a
    // loss. Measured before it was built: four losers had been above the target
    // first, $5.57 between them. OPERADOR_BREAK_EVEN=0 turns it off.
    // OFF: *lo demás, sólo salí si el TP se cumple.* The ratchet sells a winner
    // back at its cost — protection, not the TP. OPERADOR_BREAK_EVEN=1 for it.
    // ON again, at 7.5: *poné el break-even en 7.5.* The operator's answer to a
    // fixed take-profit, which would have cut the runners the strategy exit
    // lives on.
    // OFF again: *sacá el break-even, pero poné un mínimo de ganancia* (10%)
    // — the strategy exit's floor, `minProfitPct`, does the job instead.
    // OPERADOR_BREAK_EVEN=1 brings it back at 7.5.
    breakEven: onlyIf(env, 'OPERADOR_BREAK_EVEN'),
    breakEvenArmPct,
    breakEvenFloorPct,
    // ON: *si pasás el 20% de ganancia, break-even en el 10%; con cada aumento
    // de 20%, aumentar el break-even 10% — por si algo es muy volátil y vuela
    // para arriba, lo podemos atrapar si baja a toda velocidad.* A floor under
    // a winner that only rises, and sells only on the way back down to it.
    // Beside the strategy exit, not in place of it. OPERADOR_GAIN_LOCK=0 turns
    // it off; a typo leaves it on, the safe side for a rule that only ever
    // sells above cost.
    // OFF since 2026-10-08, as on 24/09. OPERADOR_GAIN_LOCK=1 brings it back.
    gainLock: onlyIf(env, 'OPERADOR_GAIN_LOCK') ? DEFAULT_GAIN_LOCK_POLICY : null,
    // *El operador pierde de a mucho, no funciona el SL.* The 1:4 multiplies
    // the toll by about seven with no ceiling of its own: fomopay was cut with
    // a 24% stop, a thin pool derives 51% on the old toll and 14.7% on the
    // right one. Ten is rounded up from the 8.7-9.5 the operator asked for —
    // the deep pool derives 8.4% and is untouched; above it, the formula is
    // reacting to an expensive pool rather than to him. Zero means no ceiling.
    maxStopPct: number(env, 'OPERADOR_MAX_STOP_PCT', 10),
    // ZERO: *no cierres en negativo.* A swap for a better token may only take a
    // gain larger than its whole round trip; `DEFAULT_MAX_SWAP_LOSS_PCT` (1.2)
    // stays tested and one variable away.
    maxSwapLossPct: numberOrZero(env, 'OPERADOR_MAX_SWAP_LOSS_PCT', 0),
    stopLoss: {
      // ON, FLAT, at one percent — the operator's experiment: *si alguno llega
      // a bajar 1% SL, revisá tick a tick, no quiero quedarme con ninguna
      // posición que baje eso, y rotás a otra moneda.*
      //
      // It reverses *anulá el SL* from the same week, and the reversal is the
      // operator's to make: the engine is in PAPER, so the cost of being wrong
      // is a measurement rather than money — *no hay plata de por medio, estas
      // son pruebas.*
      //
      // This is the ONLY path in the engine where a PRICE causes a sale. The
      // death watch stays out of it and its observation type still refuses any
      // price-shaped field, which is the structural guarantee that keeps the
      // two apart. `FLAT_ONE_PCT_STOP` carries the arithmetic of what this
      // costs — it cuts below the round trip that opened the position — and
      // that is the number to read the results against.
      //
      // Both other policies stay tested and one variable away:
      // `OPERADOR_STOP_SHARE_OF_RUN=0.05` restores the proportional rule,
      // `OPERADOR_STOP_MIN_PCT=0` turns the stop off entirely.
      // OFF. *No, el SL no lo quiero; quiero el que habíamos acordado antes,
      // el death o congelamiento.* No price sells a position: it is held and
      // the ladder averages it down. What may still sell at a loss is an
      // asset that stopped being one — the death exit and the freeze exit.
      // Every field below is one variable away, and all of it stays tested.
      shareOfRun: numberOrZero(env, 'OPERADOR_STOP_SHARE_OF_RUN', 0),
      minStopPct: numberOrZero(env, 'OPERADOR_STOP_MIN_PCT', 0),
      maxStopPct: numberOrZero(env, 'OPERADOR_STOP_MAX_PCT', 0),
      // *Ponele un SL de 0.10 centavos, todo lo que caiga a partir de ahí
      // salte, inmediatamente.* In DOLLARS, and when set it is the whole rule —
      // *no quiero que mires el porcentaje.* The percent fields above are then
      // not consulted at all. Zero hands the decision back to them.
      //
      // *Si alguno luego del 2 DCA lleva perdiendo más de 1.2 USD, entonces
      // SL* — armed from the second buy on. OFF since 2026-10-04, *sacá la
      // regla del SL*: OPERADOR_STOP_MAX_LOSS_USD=1.2 brings it back.
      maxLossUsd: numberOrZero(env, 'OPERADOR_STOP_MAX_LOSS_USD', 0),
      minBuys: numberOrZero(env, 'OPERADOR_STOP_AFTER_BUYS', 2),
      // *Si la ganancia es mayor a la pérdida también SL y rotar; si no, no
      // salir en pérdida.* ON: the stop sells at a loss only what the token
      // has already paid for across its whole history. OFF since the $1.20
      // stop — *entonces SL* — and OPERADOR_STOP_NEEDS_HISTORY=1 restores it.
      onlyWhenHistoryCovers: onlyIf(env, 'OPERADOR_STOP_NEEDS_HISTORY'),
    },
    minScoreEdge: number(env, 'OPERADOR_MIN_SCORE_EDGE', 10),
    minScore: productionDoors(env).minScore,
    entryDoors: productionDoors(env).entryDoors,
    // None: *puerta de entrada ninguna, todo es bienvenido.*
    // OPERADOR_MIN_COST_EFFICIENCY_PCT brings a floor back.
    minComponents: productionDoors(env).minComponents,
    // *Cuando el puntaje cae 5 puntos, SL.* Points under the entry score at
    // which a held position is sold as it is. Zero turns it off.
    scoreStopPoints: numberOrZero(env, 'OPERADOR_SCORE_STOP_POINTS', 0),
    // *Dejá correr todo con esa única condición y la de congelamiento y la de
    // la muerte; lo demás, sólo salí si el TP se cumple.* Both OFF, one
    // variable away each.
    rotateOnFilter: onlyIf(env, 'OPERADOR_ROTATE_ON_FILTER'),
    pressure: onlyIf(env, 'OPERADOR_PRESSURE'),
    // *Sin TP fijo; sólo cuando haya más ganancia que 12% empieza a correr el
    // TP de la presión compradora* — sold on a 10% fall from its peak.
    // *Si una moneda baja más de 5% del precio en menos de un minuto, SL.*
    crashStop: {
      // OFF since 2026-10-05: *sin SL.* OPERADOR_CRASH_STOP_PCT=5 brings it back.
      dropPct: numberOrZero(env, 'OPERADOR_CRASH_STOP_PCT', 0),
      windowMs: numberOrZero(env, 'OPERADOR_CRASH_STOP_SECONDS', 60) * 1_000,
    },
    // *Si el token es más peligroso le asignamos 5 USD, si es normal 10, si es
    // muy bueno 15 y si es seguro seguro 25.*
    // OFF since 2026-10-08: one buy of capital / 70. OPERADOR_TIERS=1.
    tiers: onlyIf(env, 'OPERADOR_TIERS'),
    // *De todas las monedas dejame las que califiquen como 15 y 25.* Nonsense
    // keeps the decision.
    minTier: ((raw) => (raw !== undefined && isTokenTier(raw) ? raw : 'good'))(env.OPERADOR_MIN_TIER?.trim().toLowerCase()),
    // *Sin congelamiento, sin caída de la muerte.* Nothing observes a held
    // token's health, so nothing freezes and nothing dies.
    // ON again since 2026-10-08, as on 24/09.
    deathWatch: onUnless(env, 'OPERADOR_DEATH_WATCH'),
    // OFF since 2026-10-09: *no uses el TP antiguo, usá este que te dije* —
    // the TP on buy pressure is the one take-profit.
    strategyExit: onlyIf(env, 'OPERADOR_STRATEGY_EXIT'),
    pressureTp: {
      armPct: numberOrZero(env, 'OPERADOR_PRESSURE_TP_ARM_PCT', 12),
      // ON again since 2026-10-09: *la salida de la última configuración, más
      // del 12% y caída de la presión compradora 10%.*
      dropPct: numberOrZero(env, 'OPERADOR_PRESSURE_TP_DROP_PCT', 10),
    },
    // The rungs' triggers and sizes, from the module the dashboard reads too.
    dcaDropsPct: productionLadder(env).dcaDropsPct,
    dcaRungsUsd: productionLadder(env).dcaRungsUsd,
    dcaFrom: productionLadder(env).dcaFrom,
    dropLadder: productionLadder(env).dropLadder,
    deepRungFallPct: productionLadder(env).deepRungFallPct,
    deepRungReboundPct: productionLadder(env).deepRungReboundPct,
    deepRungUsd: productionLadder(env).deepRungUsd,
    dcaAdaptive: productionLadder(env).dcaAdaptive,
    dcaRealtime: productionLadder(env).dcaRealtime,
    liquidityBrakePct: productionLadder(env).liquidityBrakePct,
    // OFF: *no me cortes por cambio por una mejor — sólo dejá que, si el TP
    // que habíamos puesto se activa, cierre; si no, no.* A position holding
    // tokens is never sold for a better token; OPERADOR_SWAP_HOLDERS=1 brings
    // the swap back. Empty slots still move to whatever waits.
    swapHolders: ['1', 'true', 'yes'].includes(env.OPERADOR_SWAP_HOLDERS?.trim().toLowerCase() ?? ''),
    reserve: productionDoors(env).reserve,
    solanaRpcUrl: env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com',
    // Confirmed reachable without a key; Ankr's public endpoint now requires one.
    bscRpcUrl: env.BSC_RPC_URL?.trim() || 'https://bsc-dataseed.binance.org',
    barSize: timeframe === '15m' ? FIFTEEN_MINUTES : ONE_HOUR,
  }

  // Live mode is not a flag you drift into. Nothing in this repo can place a
  // real order yet, so refusing is the only honest answer.
  if (config.mode === 'live') {
    throw new ConfigError(
      'live mode is not available: no wallet adapter has been built or audited. ' +
        'Run OPERADOR_MODE=paper until one exists and has been reviewed.',
    )
  }

  // One slot, exactly steps × step, when nobody fixed another: *el tope son
  // 5000 dividido 50.* Nothing grossed up — the fees come out of the free
  // capital as the fills happen.
  return {
    ...config,
    usdPerToken: config.usdPerToken ?? config.slotUsd,
  }
}

/** Redacted for logs. Secrets never reach stdout, not even once at boot. */
export const describeConfig = (config: RuntimeConfig): Record<string, unknown> => ({
  mode: config.mode,
  chains: config.chains.join(','),
  database: config.databaseUrl.replace(/:\/\/[^@]*@/, '://***@'),
  capitalUsd: config.totalCapitalUsd,
  maxPositions: config.maxPositions,
  gasUsdPerSwap: config.gasUsdPerSwap,
  cycleMinutes: config.cycleIntervalMs / 60_000,
})
