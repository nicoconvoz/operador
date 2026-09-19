import { lpModelOf } from './lp-model.js'
import { hoursOld, type TokenSnapshot } from './snapshot.js'

/**
 * Safety gates — hard blockers evaluated before anything else.
 *
 * A token that fails ANY gate is never traded, regardless of how good its
 * market signal looks. And the gates FAIL CLOSED: when a critical security
 * fact is unknown, the token is treated as unsafe, not as unproven. The cost
 * of a false negative here is a wallet full of something unsellable.
 */

export interface GatePolicy {
  readonly minLiquidityUsd: number
  readonly minAgeHours: number
  readonly minVolume24hUsd: number
  /**
   * A fall this deep, in a window this short, and the token is not an
   * opportunity — it is an exit in progress.
   *
   * It lives with the ENTRY gates and must never reach the death exit. Price
   * may not cause an exit: a death exit that reacts to price is a stop loss
   * under another name, and the ladder's premise is that a drop is something to
   * average into. Choosing what to ENTER on price is a different question, and
   * the strategy already answers it — the classic gate is a drop from the swing
   * high.
   *
   * The user asked for three hours. The providers report 1h, 6h and 24h, so
   * three sits between two of them, and the gate reads BOTH rather than
   * inventing the window it wants: half gone inside an hour is a collapse, half
   * gone over six is a bleed. 24h is deliberately ignored — half a day is not
   * freefall, it is a bad day, and the strategy was built for bad days.
   */
  readonly maxFallPct: number
  /**
   * Same rule over a full day, and the STRICTEST of the three.
   *
   * The short windows catch a collapse; a day is long enough that the same
   * fall is a different event, and the ladder was built for bad days. The
   * reason it exists at all is the ladder's DEPTH: at ten rungs a token down
   * 60% in a day was something the cascade could answer. At two it is not —
   * a shallower ladder needs better entries, and this is where that is paid.
   *
   * Measured live: 58 of 252 tokens were worse than -50% over 24h, and every
   * one of them passed, because nothing looked at that window.
   */
  readonly maxDailyFallPct: number
  /**
   * 24h volume over liquidity: how many times the pool trades itself in a day.
   *
   * `minVolume24hUsd` is an absolute floor, and an absolute floor cannot tell
   * $10k of volume on a $2M pool — dead — from $10k on a $25k pool, which is
   * lively. Measured across 252 live tokens, turnover spans four orders of
   * magnitude: p10 of 0.12, median 3.5, p90 of 116.
   *
   * Both survive. A ratio cannot save a pool nobody can get $15 out of, and a
   * dollar floor cannot see that a large pool has stopped moving.
   */
  readonly minTurnoverRatio: number
  /**
   * Trades in the LAST HOUR, below which the pool is not alive now.
   *
   * The 24h figures cannot catch this: a token was reported live with $168k of
   * daily volume and FIVE HOURS without a new bar. A daily average is a lagging
   * one — a pool can trade heavily in the morning and be dead by the afternoon,
   * and the 24h number keeps quoting the morning.
   *
   * Tied to the bar size rather than guessed. The strategy runs on 15-minute
   * bars, so an hour holds FOUR of them; fewer than four trades guarantees
   * empty bars, and an empty bar produces no candle. That is exactly how a
   * position ends up frozen with nothing new to act on — the symptom this gate
   * exists to prevent at the door instead of reporting from the screen.
   */
  readonly minHourlyTxns: number
  readonly maxTransferTaxPct: number
  readonly minLpLockedPct: number
  readonly maxTopHoldersPct: number
  readonly maxCreatorPct: number
  /**
   * The strategy hunts small caps. Above this fully-diluted value a token is
   * not the kind of asset CASCADE DCA was tuned for; null disables the cap.
   */
  readonly maxFdvUsd: number | null
  /** Mints that are never a trade: stablecoins, wrapped natives, LSTs. */
  readonly denylist: readonly string[]
  /** Symbol → the only mint allowed to carry it. Anything else is an impostor. */
  readonly canonicalSymbols: Readonly<Record<string, string>>
  /**
   * Closed 1H candles the strategy needs before it can say anything.
   *
   * EMA-200 seeds at bar 199 and takes hundreds more to converge; the
   * Bollinger basis needs 50. Below this the indicators are not wrong, they
   * are ABSENT — and a strategy with absent indicators does not trade, it
   * guesses. Unknown history is tolerated: the gate only fires on a count
   * that was actually measured and came up short.
   */
  readonly minHistoryBars: number
  /**
   * How stale the newest bar may be before the token is refused.
   *
   * Not an opportunity judgement: it answers whether this engine can SEE the
   * pool trade, and the strategy cannot decide anything without bars. One hour
   * matches `minHourlyTxns`'s own window and leaves the three-hour abandonment
   * freeze clear room.
   */
  readonly maxBarAgeHours: number
  /**
   * How far the candle price and the market price may diverge before neither is
   * trusted, as a ratio either way.
   *
   * Generous on purpose. The last CLOSED bar is up to fifteen minutes old and
   * these tokens move, so a tight band would reject the whole universe. This
   * exists to catch a mismatched UNIT, not a price that moved.
   */
  readonly maxPriceRatio: number
  /**
   * Price impact of a reference sell, above which the token is not a trade.
   *
   * The score already penalises cost — `costEfficiency` reaches zero at a 6%
   * round trip — but a penalty only reorders a list. A pool where leaving
   * costs more than this is not a worse opportunity, it is not an opportunity:
   * no entry signal can pay for it and no sizing can shrink out of it, because
   * the measurement was taken at the smallest size worth quoting.
   *
   * Fires only on a MEASURED value. An impact nobody quoted is unknown, and
   * unknown cost is not evidence of a bad pool — unlike the safety gates,
   * which fail closed because unknown danger IS evidence.
   */
  readonly maxReferenceImpactPct: number
}

/** Solana mints the scanner must never propose — they are money, not trades. */
export const SOLANA_DENYLIST: readonly string[] = [
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'So11111111111111111111111111111111111111112', // wSOL
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // jitoSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
]

/**
 * Symbols that belong to exactly one canonical mint. A token wearing one of
 * these names at a different address is an impersonation — the first live
 * scan surfaced a "USDC" on Raydium with a $96k pool and 39% in ten wallets.
 */
export const SOLANA_CANONICAL_SYMBOLS: Readonly<Record<string, string>> = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  SOL: 'So11111111111111111111111111111111111111112',
  WSOL: 'So11111111111111111111111111111111111111112',
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  JITOSOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  WBTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  WETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  // The UNWRAPPED names, pointed at the same wrapped mints.
  //
  // Bitcoin and Ether have no native mint on Solana — the wrapped tokens are
  // the only things those names can honestly refer to. The map knew WBTC and
  // not BTC, which left the most recognisable ticker in crypto as the one
  // symbol anybody could borrow: a fifteen-day-old memecoin was scanned,
  // ranked and ALLOCATED under the name "BTC" with a $267k pool and not one
  // blocker against it.
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
}

export const DEFAULT_GATE_POLICY: GatePolicy = {
  // THE TASTE GATES STEP ASIDE.
  //
  // The operator narrowed what a gate is allowed to be: *tendencia reciente
  // alcista +50%, sube en una hora +30% y eficiencia de costos +30%, esa va a
  // ser la única regla, y obvio la regla de que no nos metan una cripto
  // trampa.* Three component floors plus safety; everything that merely
  // expressed a preference about the pool stops deciding.
  //
  // Measured on 114 live Solana tokens before the change: `turnover` blocked 20
  // of them and was the SOLE cause for 15 — more than any other. `freefall`
  // blocked 23, sole cause for 11. And `liquidity` and `volume` blocked 32 and
  // 17 while being the sole cause for ZERO: they only ever fired alongside
  // something else, so they were never deciding anything.
  //
  // Zero and null are the honest way to express "this does not decide" — the
  // gate and its reason survive for the day it is wanted back, and a reader
  // sees a policy rather than a hole where a check used to be.
  // NOT zero, and this one is not taste. `liquidity` is also a SAFETY gate:
  // it answers "can this position be left", which is the one question a
  // position cannot survive getting wrong — and the operator's own exception
  // covers it, *que no nos metan una cripto trampa.*
  //
  // DERIVED rather than picked, like the gas floor. The smallest order worth
  // placing is `minFillUsd` (~$16, itself the gas floor), and the impact model
  // inverts to depth = 200 x usd / impact%. At the 1% budget that is $3,200,
  // so below roughly $3,000 of depth even the smallest viable order costs more
  // than the whole budget. It rises with gas exactly as it should.
  //
  // It was $20,000, and measured on 114 live tokens it blocked 32 of them while
  // being the SOLE cause for zero: it only ever fired alongside something else,
  // so it was never deciding anything — it was just making the universe look
  // smaller than the real constraints made it.
  minLiquidityUsd: 3_000,
  minAgeHours: 24,
  minVolume24hUsd: 0,
  // The hour decides a collapse now, through the `headroom` floor at -3%. A
  // daily threshold on top was belt and braces against the same accident.
  maxFallPct: 100,
  // MEASURED, on 36 live positions, by reconstructing how far each token had
  // already fallen when the engine bought it (`tools/freefall-what-if.ts`).
  // Of the capital each band would have refused, this much was lost:
  //
  //     already down >50%   47.2%   ← PERK alone, $45.98 of a $134.11 book
  //     already down >30%   18.5%
  //     already down >20%    8.4%
  //     the book overall     3.4%
  //
  // Past thirty is catastrophe — five to fourteen times the book own rate —
  // and it costs $271 of deployment not made. Below it the damage is an
  // ordinary bad day at roughly twice the average, and tightening further eats
  // WINNERS: fone had already fallen 20.3% and is up, CODEC 15.6% and up.
  //
  // Which is the strategy own thesis, so the gate must not take it. CASCADE DCA
  // exists to buy weakness; this exists to refuse a collapse already in
  // progress. Thirty is where the measurement puts the line between them.
  //
  // It read 100 — off — while CLAUDE.md documented 15. A choice written down
  // and not implemented is this project most expensive failure mode, and this
  // is the fourth time.
  maxDailyFallPct: 30,
  minTurnoverRatio: 0,
  minHourlyTxns: 4,
  maxTransferTaxPct: 5,
  minLpLockedPct: 80,
  // EIGHTY, and the operator named the trade: *subilo al 80%, nos vamos a
  // arriesgar.*
  //
  // Forty was calibrated for a more distributed market than this book trades.
  // Measured live on Solana: cbBTC 26.67%, eHYUSD 45%, TRUMP 81.28% — and over
  // 35 tokens that cleared every other gate, this one blocked 20 and was the
  // SOLE cause for 7, more than any other check. High concentration here is
  // the norm, and it is not always the creator: an LP position, an exchange
  // wallet or simply the first buyers all look identical from this distance.
  //
  // What eighty COSTS, stated rather than softened: a holder with four fifths
  // of the supply can sell whenever they like and this engine will be inside
  // when they do. The check is close to open now — it refuses the extreme case
  // and nothing milder.
  //
  // What still does real work is the UNKNOWN branch, which is unchanged. GoPlus
  // returns an empty holders array for most Solana tokens, and an unmeasured
  // concentration is an unanswered question rather than a low one.
  maxTopHoldersPct: 80,
  maxCreatorPct: 10,
  // The CEILING, not the preference. $50M for months, which excluded every
  // established token outright — and measured on ten days of 15m candles, that
  // was wrong about the thing that matters: SOL/USDC hits the classic entry
  // (a 10% drop from the five-hour high) on 4.1% of bars, once every six hours.
  // Tradeable, just rarer. USDT/USDC hits it on 0%, which is what the denylist
  // is for.
  //
  // They earn their place for a second reason that only appeared this week:
  // deep pools are the ones the candle provider indexes properly, so they do
  // not carry the `staleBars` failure that is currently the largest cut of all.
  //
  // Small caps are still the thesis. `smallCapFdvUsd` in the RANKING keeps them
  // ahead of every large one regardless of score, so the big names only ever
  // take a slot nothing smaller wanted. The ceiling admits them; the order
  // decides they come last.
  maxFdvUsd: null,
  denylist: SOLANA_DENYLIST,
  canonicalSymbols: SOLANA_CANONICAL_SYMBOLS,
  // ENOUGH TO ENTER, not enough for every door.
  //
  // 250 was calibrated for the whole indicator set, EMA-200 included, and it
  // was the single biggest thing standing between the engine and a usable
  // universe. Measured live on 97 priced Solana tokens: 15 cleared the free
  // gates, and AGE ALONE blocked another 16 — age being derived from exactly
  // this number.
  //
  // The EMA-200 feeds ONE thing: `trendBullish`, which arms the TREND
  // RE-ENTRY. That is the second door, and it opens only after a sell. Every
  // new position comes through the CLASSIC door — a 20-bar swing high inside a
  // lateral zone — whose longest lookback is the 50-bar Bollinger basis.
  //
  // So 100 bars, twice what the classic entry needs. A young pool trades
  // through the door it can reach, and the other one opens when it matures:
  // an unconverged EMA is `na`, `trendBullish` is false, and the re-entry
  // simply does not fire. Safe by construction rather than by luck.
  //
  // It carries the age gate down with it — 25 hours instead of 62.5 — because
  // `minAgeForHistory` only ever existed to serve this.
  // SIXTY, and it was a hundred.
  //
  // Measured over 564 live Solana tokens, `age` — which is derived from this
  // number — blocked 354 of them and was the SOLE cause for 40, the second
  // largest cut in the entire funnel. What these lists return is mostly pools
  // born this morning, and a hundred bars of 15 minutes demands 25 hours of
  // them.
  //
  // What the strategy actually needs: the classic entry is a 20-bar swing high
  // inside a lateral zone, and the longest lookback in that is the 50-bar
  // Bollinger basis. Sixty leaves TEN bars of converged output to judge the
  // zone on — thin, and the operator chose it knowing so, because 25 hours of
  // required pool age becomes 15.
  //
  // The EMA-200 is untouched by this and always was: it feeds only
  // `trendBullish`, which arms the TREND RE-ENTRY, and an unconverged EMA is
  // `na` so that door simply does not open until the pool has matured. Safe by
  // construction rather than by luck.
  minHistoryBars: 60,
  maxBarAgeHours: 1,
  maxPriceRatio: 5,
  // CREPE measured 98% on a $285 sell while reporting $718k of liquidity.
  // Ten percent is already far beyond anything the 1%-per-fill and 3%-exit
  // budgets could rescue; past it there is nothing to size down to.
  maxReferenceImpactPct: 10,
}

/**
 * The thresholds the taste gates USED to carry, kept so their logic stays
 * tested after production stopped asking them.
 *
 * The gates themselves are unchanged and still work; what changed is that
 * `DEFAULT_GATE_POLICY` no longer asks them anything, because the operator
 * narrowed the rule to three component floors plus safety. A test that proves
 * `turnover` fires on a slow pool is still worth having — it just has to say
 * which policy it is proving it under, rather than leaning on a default whose
 * whole point is that it does not decide any more.
 */
export const STRICT_GATE_POLICY: GatePolicy = {
  ...DEFAULT_GATE_POLICY,
  minLiquidityUsd: 20_000,
  minVolume24hUsd: 10_000,
  maxFallPct: 50,
  maxDailyFallPct: 15,
  minTurnoverRatio: 1,
  maxFdvUsd: 500_000_000,
}


/**
 * The age a pool must have before it could POSSIBLY hold `bars` of history.
 *
 * Pure arithmetic, and it replaces a network call. `minHistoryBars` is 250,
 * which at 15m is 62.5 hours — but `minAgeHours` stood at 24, so a pool thirty
 * hours old passed the free gate and then cost a **thousand-row candle
 * download** to learn it had about a hundred bars and failed anyway. The
 * heaviest call in the whole cycle, made to produce one integer that a
 * subtraction already knew.
 *
 * It matters more since discovery started asking for `new_pools`, where nearly
 * every result is younger than this. Those are now refused at the door for
 * free, instead of each one paying for a download it was always going to fail.
 *
 * It cannot CONFIRM anything: an old pool with no trades has no candles either,
 * which is the abandonment case. So it only ever rejects, and the real count is
 * still measured for what survives.
 */
export function minAgeForHistory(minHistoryBars: number, barMinutes: number): number {
  return (minHistoryBars * barMinutes) / 60
}

export type GateName =
  | 'honeypot'
  | 'impact'
  | 'mintAuthority'
  | 'freezeAuthority'
  | 'blacklist'
  | 'transferTax'
  | 'lpLocked'
  | 'topHolders'
  | 'creatorShare'
  | 'liquidity'
  | 'age'
  | 'volume'
  | 'freefall'
  | 'turnover'
  | 'idle'
  | 'proxy'
  | 'denylist'
  | 'marketCap'
  | 'impersonation'
  | 'history'
  | 'staleBars'
  | 'priceMismatch'

export interface GateFailure {
  readonly gate: GateName
  /** 'unknown' when the gate failed closed on missing data. */
  readonly reason: 'failed' | 'unknown'
  readonly detail: string
}

export interface GateResult {
  readonly passed: boolean
  readonly failures: readonly GateFailure[]
}

const fail = (gate: GateName, reason: GateFailure['reason'], detail: string): GateFailure => ({ gate, reason, detail })

/** "usdc", " USDC ", "$USDC" and "USDC." all mean USDC to a victim. */
const normaliseSymbol = (symbol: string): string => symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')

/**
 * The gates that need NO extra network call — everything decidable from the
 * market snapshot alone.
 *
 * Separated because the security gates cost one throttled request per token,
 * and the universe is larger than that budget. Deciding what is free before
 * paying for what is not lets the scanner cover every token it can see
 * instead of the first N it happens to reach.
 *
 * This is an optimisation of ORDER, not of strictness: a token that passes
 * here still faces the full gate set, security included.
 */
export function evaluateMarketGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult {
  const failures: GateFailure[] = []

  if (policy.denylist.includes(snapshot.address)) {
    failures.push(fail('denylist', 'failed', `${snapshot.symbol} is money, not a trade`))
  }
  const canonical = policy.canonicalSymbols[normaliseSymbol(snapshot.symbol)]
  if (canonical !== undefined && canonical !== snapshot.address) {
    failures.push(fail('impersonation', 'failed', `"${snapshot.symbol}" at ${snapshot.address} is not the canonical mint`))
  }
  if (policy.maxFdvUsd !== null && snapshot.fdvUsd !== null && snapshot.fdvUsd > policy.maxFdvUsd) {
    failures.push(fail('marketCap', 'failed', `FDV $${Math.round(snapshot.fdvUsd).toLocaleString()} > $${policy.maxFdvUsd.toLocaleString()} — not a small cap`))
  }
  if (snapshot.liquidityUsd < policy.minLiquidityUsd) {
    failures.push(fail('liquidity', 'failed', `liquidity $${snapshot.liquidityUsd.toFixed(0)} < $${policy.minLiquidityUsd}`))
  }
  const age = hoursOld(snapshot)
  if (age === null) failures.push(fail('age', 'unknown', 'pair creation time unknown'))
  else if (age < policy.minAgeHours) failures.push(fail('age', 'failed', `pair is ${age.toFixed(1)}h old < ${policy.minAgeHours}h`))

  // Can this engine SEE it trade? Only on a measured value: a scan that has not
  // asked the candle feed says nothing, and the entry confirmation asks again
  // live before any capital moves.
  //
  // A null measurement is NOT silence — it is the feed answering "no trades at
  // all", which is the strongest form of the failure.
  if (snapshot.lastTradeAgoHours !== undefined) {
    const age = snapshot.lastTradeAgoHours
    if (age === null) {
      failures.push(fail('staleBars', 'unknown', 'el proveedor de velas no devolvió ninguna operación — sin barras la estrategia no puede decidir'))
    } else if (age > policy.maxBarAgeHours) {
      failures.push(fail('staleBars', 'failed', `última vela hace ${age.toFixed(1)}h — sin barras no se puede operar, por más actividad que reporte el mercado`))
    }
  }

  // Do the two providers even agree what this token COSTS?
  //
  // Measured live: DexScreener quoted ZCAT at $0.1318 while GeckoTerminal's
  // candles for the SAME pool quoted $1,429.49 — a factor of 10,846. The engine
  // sizes an order from the market price and fills it at the candle price, so
  // it bought 0.0105 tokens for $15.11 when that money was fifteen dollars of a
  // token worth a tenth of a dollar. On screen it read as a 100% collapse
  // minutes after buying.
  //
  // Not a rug and not a crash: a unit nobody agreed on. The only safe answer is
  // the same as for stale bars — a token the engine cannot price consistently
  // is a token it cannot trade.
  const candlePrice = snapshot.lastCandlePriceUsd
  if (candlePrice !== undefined && candlePrice !== null && candlePrice > 0 && snapshot.priceUsd > 0) {
    const ratio = Math.max(candlePrice / snapshot.priceUsd, snapshot.priceUsd / candlePrice)
    if (ratio > policy.maxPriceRatio) {
      failures.push(fail('priceMismatch', 'failed',
        `el mercado dice $${snapshot.priceUsd} y las velas dicen $${candlePrice} — ${ratio.toFixed(0)}× de diferencia, no se puede operar lo que no se puede precificar`))
    }
  }

  if (snapshot.volumeUsd.h24 < policy.minVolume24hUsd) {
    failures.push(fail('volume', 'failed', `24h volume $${snapshot.volumeUsd.h24.toFixed(0)} < $${policy.minVolume24hUsd}`))
  }

  const fall = freefall(snapshot, policy)
  if (fall) failures.push(fall)

  // Activity measured against the pool, not in dollars. Zero liquidity is
  // already a liquidity failure; dividing by it here would only add noise.
  if (snapshot.liquidityUsd > 0) {
    const turnover = snapshot.volumeUsd.h24 / snapshot.liquidityUsd
    if (turnover < policy.minTurnoverRatio) {
      failures.push(fail('turnover', 'failed', `rota ${turnover.toFixed(2)}× su liquidez en 24h, menos de ${policy.minTurnoverRatio}× — el pool está quieto`))
    }
  }

  // Is it alive NOW? The last hour is the only window that answers that, and
  // it is the one a daily average hides.
  const lastHour = snapshot.txns.h1.buys + snapshot.txns.h1.sells
  if (lastHour < policy.minHourlyTxns) {
    failures.push(fail('idle', 'failed', `${lastHour} operaciones en la última hora, menos de ${policy.minHourlyTxns} — con barras de 15m eso deja barras vacías, y una barra vacía no existe para la estrategia`))
  }

  return { passed: failures.length === 0, failures }
}

/**
 * What must STILL hold at the moment capital moves — and nothing else.
 *
 * `evaluateGates` answers two different questions at once, and re-asking both
 * before a buy was a mistake that cost the book most of its positions.
 *
 *  - **Is this token dangerous?** honeypot, authorities, LP, holders, tax,
 *    proxy, denylist, impersonation — and whether there is a way OUT, which is
 *    liquidity and measured impact. These turn between the scan and the buy,
 *    each one costs real money, and every one of them is re-asked here.
 *
 *  - **Is this token WORTH buying?** freefall, turnover, hourly trades, volume,
 *    FDV, age, history. The scanner already answered that, against a universe
 *    of nine hundred, minutes ago.
 *
 * Re-arguing the second question at the door refuses entries for the ordinary
 * motion the strategy exists to harvest. On a DEX the price moves WHILE the
 * order is placed — somebody else's buy moves it, and ours moves it too — so a
 * token that slipped past the freefall threshold between being chosen and being
 * bought has not become dangerous. **It has become cheaper, which is the entire
 * premise of a DCA ladder.** Reported live: an alert log full of
 * "cambió antes de comprar" while eight positions traded and hundreds of
 * candidates waited outside.
 *
 * The safety half keeps failing CLOSED, exactly as before. An unknown honeypot
 * answer or an unreadable authority is still a refusal — a token nobody can
 * vouch for at the moment of purchase is not bought.
 */
/**
 * The gates a token may be FORGIVEN when capital would otherwise sit idle.
 *
 * The operator's rule: when there are not enough coins to trade, reach further
 * down the ranking rather than leave money doing nothing — always in the order
 * the scores decided. Measured live across 509 tokens, three were ready to
 * trade and **eighty-four were held back by `turnover` alone**.
 *
 * This is a STRICTER set than `evaluateSafetyGates` forgives at the door, and
 * the difference is the point. That one answers "is this dangerous?"; this one
 * has to answer "is this merely not my first choice?", and three of the
 * opportunity gates fail that test:
 *
 *  - `idle` — under four trades an hour a 15m bar comes back EMPTY, and an
 *    empty bar is how a position freezes with its capital unreachable. Not a
 *    preference: the exact failure this engine spent a session repairing.
 *  - `age` / `history` — no bars, no indicators, and the machine cannot step.
 *  - `freefall` — a day-long bleed is an exit in progress. Forgiving it would
 *    quietly undo `maxDailyFallPct`, decided this week and on purpose.
 *
 * What is left really is taste. A deep pool that turns over slowly, a small
 * one with a thin day, a name bigger than this book prefers: each is a reason
 * to rank a token BELOW another, never a reason to leave the slot empty.
 */
const FORGIVABLE = new Set<GateName>(['turnover', 'volume', 'marketCap'])

/**
 * The failures this token would be forgiven, or null when it cannot be.
 *
 * Null for a token that passed everything too — a caller asking this question
 * wants the FALLBACK list, and something that qualifies outright is not on it.
 */
export function forgivableFailures(gates: GateResult): readonly GateFailure[] | null {
  if (gates.passed || gates.failures.length === 0) return null
  return gates.failures.every((failure) => FORGIVABLE.has(failure.gate)) ? gates.failures : null
}

export function evaluateSafetyGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult {
  const opportunityOnly = new Set<GateName>(['freefall', 'turnover', 'idle', 'volume', 'marketCap', 'age', 'history'])
  const { failures } = evaluateGates(snapshot, policy)
  const kept = failures.filter((failure) => !opportunityOnly.has(failure.gate))
  return { passed: kept.length === 0, failures: kept }
}

export function evaluateGates(snapshot: TokenSnapshot, policy: GatePolicy): GateResult {
  const s = snapshot.security
  const failures: GateFailure[] = []

  // ── Not a trade at all ────────────────────────────────────────────────────
  if (policy.denylist.includes(snapshot.address)) {
    failures.push(fail('denylist', 'failed', `${snapshot.symbol} is money, not a trade`))
  }
  const canonical = policy.canonicalSymbols[normaliseSymbol(snapshot.symbol)]
  if (canonical !== undefined && canonical !== snapshot.address) {
    failures.push(fail('impersonation', 'failed', `"${snapshot.symbol}" at ${snapshot.address} is not the canonical mint`))
  }
  if (policy.maxFdvUsd !== null && snapshot.fdvUsd !== null && snapshot.fdvUsd > policy.maxFdvUsd) {
    failures.push(fail('marketCap', 'failed', `FDV $${Math.round(snapshot.fdvUsd).toLocaleString()} > $${policy.maxFdvUsd.toLocaleString()} — not a small cap`))
  }

  // ── Critical security facts: unknown is a failure ─────────────────────────
  const impact = snapshot.measuredImpactPct
  if (impact !== null && impact !== undefined && impact > policy.maxReferenceImpactPct) {
    failures.push(fail('impact', 'failed', `a reference sell moves the price ${impact.toFixed(1)}% — there is no way out`))
  }

  if (s.honeypot === null) failures.push(fail('honeypot', 'unknown', 'sell simulation unavailable'))
  else if (s.honeypot) failures.push(fail('honeypot', 'failed', 'sell simulation failed'))

  if (s.mintAuthorityActive === null) failures.push(fail('mintAuthority', 'unknown', 'mint authority unknown'))
  else if (s.mintAuthorityActive) failures.push(fail('mintAuthority', 'failed', 'mint authority still active'))

  if (s.freezeAuthorityActive === null) failures.push(fail('freezeAuthority', 'unknown', 'freeze authority unknown'))
  else if (s.freezeAuthorityActive) failures.push(fail('freezeAuthority', 'failed', 'freeze authority still active'))

  if (s.hasBlacklist === null) failures.push(fail('blacklist', 'unknown', 'blacklist capability unknown'))
  else if (s.hasBlacklist) failures.push(fail('blacklist', 'failed', 'contract can blacklist wallets'))

  if (s.transferTaxPct === null) failures.push(fail('transferTax', 'unknown', 'transfer tax unknown'))
  else if (s.transferTaxPct > policy.maxTransferTaxPct) {
    failures.push(fail('transferTax', 'failed', `transfer tax ${s.transferTaxPct}% > ${policy.maxTransferTaxPct}%`))
  }

  // An LP lock can only exist where LP tokens exist. On concentrated venues
  // the gate is skipped — not passed — and the liquidity gate plus the death
  // exit's monitoring carry the defense. See lp-model.ts.
  if (lpModelOf(snapshot.dexId, snapshot.dexLabels) === 'lp-token') {
    if (s.lpLockedPct === null) failures.push(fail('lpLocked', 'unknown', 'LP lock status unknown'))
    else if (s.lpLockedPct < policy.minLpLockedPct) {
      failures.push(fail('lpLocked', 'failed', `LP locked ${s.lpLockedPct}% < ${policy.minLpLockedPct}%`))
    }
  }

  if (s.topHoldersPct === null) failures.push(fail('topHolders', 'unknown', 'holder concentration unknown'))
  else if (s.topHoldersPct > policy.maxTopHoldersPct) {
    failures.push(fail('topHolders', 'failed', `top holders ${s.topHoldersPct}% > ${policy.maxTopHoldersPct}%`))
  }

  // Creator share is informative on both chains but only sometimes known;
  // unknown is tolerated because the holder concentration gate already covers
  // the dangerous case.
  if (s.creatorPct !== null && s.creatorPct > policy.maxCreatorPct) {
    failures.push(fail('creatorShare', 'failed', `creator holds ${s.creatorPct}% > ${policy.maxCreatorPct}%`))
  }

  // EVM-only: an upgradeable proxy can change the rules after you buy.
  if (snapshot.chain === 'bsc' && s.isProxy === true) failures.push(fail('proxy', 'failed', 'upgradeable proxy contract'))

  // ── Market facts: these are always known ──────────────────────────────────
  if (snapshot.liquidityUsd < policy.minLiquidityUsd) {
    failures.push(fail('liquidity', 'failed', `liquidity $${snapshot.liquidityUsd.toFixed(0)} < $${policy.minLiquidityUsd}`))
  }

  const age = hoursOld(snapshot)
  if (age === null) failures.push(fail('age', 'unknown', 'pair creation time unknown'))
  else if (age < policy.minAgeHours) failures.push(fail('age', 'failed', `pair is ${age.toFixed(1)}h old < ${policy.minAgeHours}h`))

  // Only fires on a measured count: a scanner pass that has not fetched
  // candles yet says nothing, and the executor checks again before trading.
  if (snapshot.historyBars !== null && snapshot.historyBars !== undefined && snapshot.historyBars < policy.minHistoryBars) {
    failures.push(fail('history', 'failed', `${snapshot.historyBars} barras de historial < ${policy.minHistoryBars} — EMA-200 no puede existir`))
  }

  // Can this engine SEE it trade? Only on a measured value: a scan that has not
  // asked the candle feed says nothing, and the entry confirmation asks again
  // live before any capital moves.
  //
  // A null measurement is NOT silence — it is the feed answering "no trades at
  // all", which is the strongest form of the failure.
  if (snapshot.lastTradeAgoHours !== undefined) {
    const age = snapshot.lastTradeAgoHours
    if (age === null) {
      failures.push(fail('staleBars', 'unknown', 'el proveedor de velas no devolvió ninguna operación — sin barras la estrategia no puede decidir'))
    } else if (age > policy.maxBarAgeHours) {
      failures.push(fail('staleBars', 'failed', `última vela hace ${age.toFixed(1)}h — sin barras no se puede operar, por más actividad que reporte el mercado`))
    }
  }

  // Do the two providers even agree what this token COSTS?
  //
  // Measured live: DexScreener quoted ZCAT at $0.1318 while GeckoTerminal's
  // candles for the SAME pool quoted $1,429.49 — a factor of 10,846. The engine
  // sizes an order from the market price and fills it at the candle price, so
  // it bought 0.0105 tokens for $15.11 when that money was fifteen dollars of a
  // token worth a tenth of a dollar. On screen it read as a 100% collapse
  // minutes after buying.
  //
  // Not a rug and not a crash: a unit nobody agreed on. The only safe answer is
  // the same as for stale bars — a token the engine cannot price consistently
  // is a token it cannot trade.
  const candlePrice = snapshot.lastCandlePriceUsd
  if (candlePrice !== undefined && candlePrice !== null && candlePrice > 0 && snapshot.priceUsd > 0) {
    const ratio = Math.max(candlePrice / snapshot.priceUsd, snapshot.priceUsd / candlePrice)
    if (ratio > policy.maxPriceRatio) {
      failures.push(fail('priceMismatch', 'failed',
        `el mercado dice $${snapshot.priceUsd} y las velas dicen $${candlePrice} — ${ratio.toFixed(0)}× de diferencia, no se puede operar lo que no se puede precificar`))
    }
  }

  if (snapshot.volumeUsd.h24 < policy.minVolume24hUsd) {
    failures.push(fail('volume', 'failed', `24h volume $${snapshot.volumeUsd.h24.toFixed(0)} < $${policy.minVolume24hUsd}`))
  }

  const fall = freefall(snapshot, policy)
  if (fall) failures.push(fall)

  // Activity measured against the pool, not in dollars. Zero liquidity is
  // already a liquidity failure; dividing by it here would only add noise.
  if (snapshot.liquidityUsd > 0) {
    const turnover = snapshot.volumeUsd.h24 / snapshot.liquidityUsd
    if (turnover < policy.minTurnoverRatio) {
      failures.push(fail('turnover', 'failed', `rota ${turnover.toFixed(2)}× su liquidez en 24h, menos de ${policy.minTurnoverRatio}× — el pool está quieto`))
    }
  }

  // Is it alive NOW? The last hour is the only window that answers that, and
  // it is the one a daily average hides.
  const lastHour = snapshot.txns.h1.buys + snapshot.txns.h1.sells
  if (lastHour < policy.minHourlyTxns) {
    failures.push(fail('idle', 'failed', `${lastHour} operaciones en la última hora, menos de ${policy.minHourlyTxns} — con barras de 15m eso deja barras vacías, y una barra vacía no existe para la estrategia`))
  }

  return { passed: failures.length === 0, failures }
}

/**
 * A token losing more than half its price in about three hours.
 *
 * Both short windows are read because three hours is not one the providers
 * report, and a single one would miss half the cases: a token can crash inside
 * an hour and look calm over six, or bleed steadily over six without any single
 * hour looking alarming. Either shape is an exit in progress.
 *
 * A null is not a crash. An unreported window means the provider said nothing,
 * and rejecting on silence would reject on absence rather than on evidence —
 * which is the opposite of how the SAFETY gates fail, and rightly so: those
 * guard against a rug, this one against a bad entry.
 */
function freefall(snapshot: TokenSnapshot, policy: GatePolicy): GateFailure | null {
  const windows: readonly (readonly [string, number | null, number])[] = [
    ['1h', snapshot.priceChangePct.h1, policy.maxFallPct],
    ['6h', snapshot.priceChangePct.h6, policy.maxFallPct],
    // TIGHTER than the short windows now, which reverses the reasoning it was
    // written with. It was looser on the argument that the same fall given four
    // times as long is a different event — and then a token bought at −64% on
    // the day sat flat while we held it, because the collapse was entirely
    // somebody else's and we had simply joined it.
    //
    // At fifteen the short windows keep one job the daily one cannot do: catch
    // a pump that is DUMPING inside the day, where the day is still green and
    // only the hour shows the exit in progress.
    ['24h', snapshot.priceChangePct.h24, policy.maxDailyFallPct],
  ]

  for (const [label, change, limit] of windows) {
    if (change === null || change >= -limit) continue
    return fail('freefall', 'failed', `cayó ${Math.abs(change).toFixed(0)}% en ${label} — es una salida en curso, no una oportunidad`)
  }
  return null
}
