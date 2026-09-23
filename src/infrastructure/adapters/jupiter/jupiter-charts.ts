import { NO_THROTTLE, type HttpGet, type Throttle } from '../../http.js'
import { type Chain } from '../../../domain/scanner/snapshot.js'
import { type Candles } from '../../../application/replay.js'
import { barSizeMs, type BarSize } from '../geckoterminal/geckoterminal.js'

/**
 * Candles from Jupiter — per MINT, a thousand at a time, fast.
 *
 * *La operativa también la quiero con Jupiter, todo con Jupiter.* The tick
 * asked GeckoTerminal for each position's candles in turn, behind the throttle
 * of the provider that rate-limits hardest of all — about 2.5s a position
 * before any refusal, most of a minute for a book of forty. Measured against
 * that same book: forty mints here took 10.5s in a row and 2.0s eight at a
 * time, with not one refusal in eighty requests.
 *
 * ## An endpoint Jupiter does not document
 *
 * `datapi.jup.ag/v2/charts` is what jup.ag's own chart reads. It works and it
 * is fast, and it can also change or disappear without notice — and every
 * position's tick depends on candles. So this THROWS when it cannot answer,
 * and the composition root falls back to GeckoTerminal for that position: when
 * Jupiter works the fallback costs nothing, and when it does not the book is
 * not left blind.
 *
 * ## Per mint, not per pool
 *
 * GeckoTerminal answered for ONE pool, and which pool was a recurring source of
 * grief — a dead bonding curve, a thin side pool, a unit nobody agreed on.
 * Jupiter aggregates the mint across the venues it routes through, which is
 * closer to what a sale would actually get.
 *
 * ## The same series the engine always read
 *
 * Milliseconds, oldest first, the bar stamped by its OPEN, non-positive rows
 * skipped — and the bar still being built DROPPED. Measured live, Jupiter's
 * newest candle had opened 12.7 minutes earlier on a 15-minute bar. Deciding on
 * it is how the engine once bought BinanceTown at a price its bar never closed
 * at, and constraint 7 says signals evaluate on closed bars only.
 */

export const JUPITER_CHARTS_BASE = 'https://datapi.jup.ag'

interface ChartRow {
  readonly time?: number
  readonly open?: number
  readonly high?: number
  readonly low?: number
  readonly close?: number
  readonly volume?: number
}

const INTERVAL: Readonly<Record<BarSize['timeframe'], string>> = { minute: 'MINUTE', hour: 'HOUR', day: 'DAY' }

export const chartInterval = (size: BarSize): string => `${size.aggregate ?? 1}_${INTERVAL[size.timeframe]}`

export class JupiterCharts {
  private readonly now: () => number
  private readonly base: string
  private readonly throttle: Throttle

  constructor(
    private readonly http: HttpGet,
    options: { readonly now?: () => number; readonly base?: string; readonly throttle?: Throttle } = {},
  ) {
    this.now = options.now ?? Date.now
    this.base = options.base ?? JUPITER_CHARTS_BASE
    this.throttle = options.throttle ?? NO_THROTTLE
  }

  async candles(chain: Chain, mint: string, size: BarSize, limit = 1000): Promise<Candles> {
    // Solana only. Throwing rather than returning empty: an empty series reads
    // as "nobody traded", which is a verdict the death watch acts on.
    if (chain !== 'solana') throw new Error(`Jupiter charts: no ${chain}`)
    await this.throttle.wait()
    const at = this.now()
    const url = `${this.base}/v2/charts/${mint}?interval=${chartInterval(size)}&to=${at}&candles=${limit}&type=price`
    const response = await this.http(url)
    if (response.status !== 200) throw new Error(`Jupiter charts HTTP ${response.status} for ${mint}`)
    const body = (await response.json()) as { candles?: readonly ChartRow[] }
    const rows = Array.isArray(body.candles) ? body.candles : []

    // A bar that opened within the last bar-width has not closed yet.
    const closedBy = at - barSizeMs(size)

    const time: number[] = []
    const open: number[] = []
    const high: number[] = []
    const low: number[] = []
    const close: number[] = []
    const volume: number[] = []
    for (const row of rows) {
      const { time: seconds, open: o, high: h, low: l, close: c } = row
      if (typeof seconds !== 'number' || !(o! > 0 && h! > 0 && l! > 0 && c! > 0)) continue
      if (seconds * 1000 > closedBy) continue
      time.push(seconds * 1000)
      open.push(o!)
      high.push(h!)
      low.push(l!)
      close.push(c!)
      volume.push(typeof row.volume === 'number' ? row.volume : 0)
    }
    return { time, open, high, low, close, volume }
  }
}
