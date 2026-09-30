import { keepGainLock } from '../risk/gain-lock.js'
import { keepLiquidityWatch } from '../strategy/liquidity-brake.js'
import { keepPriceLow } from '../strategy/deep-rung.js'
import { keepDipWatch } from '../strategy/dip-bounce.js'
import { type PersistedPosition } from './store.js'

/** A position's real-time DCA scale as a whole pair, or null. */
const readingOf = (position: PersistedPosition | undefined): { scale: number; at: number } | null =>
  position?.dcaScaleNow !== null && position?.dcaScaleNow !== undefined &&
  position.dcaScaleNowAt !== null && position.dcaScaleNowAt !== undefined
    ? { scale: position.dcaScaleNow, at: position.dcaScaleNowAt }
    : null

/**
 * What a store KEEPS when a position is saved over the one it holds — the
 * ratchets the Postgres upsert spells out in SQL, in one place.
 *
 * Every step of the cycle writes the whole row back from a snapshot read
 * earlier, so a save is not the row as it will stand: the break-even stays
 * armed once armed, the entry score and the DCA scale are written once, and
 * the gain lock, the real-time scale, the liquidity watch, the price low and
 * the dip-bounce watch each keep the newer or stronger of the two. The
 * reference store and the engine's in-memory book both fold a save through
 * this, so neither can drift from the other or from the SQL.
 */
export function mergeSavedPosition(stored: PersistedPosition | undefined, position: PersistedPosition): PersistedPosition {
  // The break-even ratchet.
  const armed = stored?.breakEvenArmed === true || position.breakEvenArmed === true
  // The score baseline: the first non-null value, never moved by a later save.
  const entryScore = stored?.entryScore ?? position.entryScore ?? null
  // The DCA scale, by the same rule: measured once, never erased.
  const dcaScale = stored?.dcaScale ?? position.dcaScale ?? null
  // The gain lock, by the rule the upsert spells out in its CASE.
  const gainLock = keepGainLock(stored?.gainLock, position.gainLock)
  // The real-time DCA scale: the NEWER pair wins, and a half pair is no reading.
  const written = readingOf(position)
  const kept = readingOf(stored)
  const now = written !== null && (kept === null || written.at > kept.at) ? written : kept
  // The liquidity watch: the NEWER watch wins, and a write carrying none keeps what is stored.
  const liquidityWatch = keepLiquidityWatch(stored?.liquidityWatch, position.liquidityWatch)
  // The price low: the same holding keeps the LOWER price, a newer holding's
  // replaces it, and a write carrying none keeps what is stored.
  const priceLow = keepPriceLow(stored?.priceLow, position.priceLow)
  // The dip-bounce watch: the NEWER watch wins, and a write carrying none keeps what is stored.
  const dipWatch = keepDipWatch(stored?.dipWatch, position.dipWatch)
  return {
    ...position, breakEvenArmed: armed, entryScore, dcaScale, gainLock,
    dcaScaleNow: now?.scale ?? null, dcaScaleNowAt: now?.at ?? null,
    liquidityWatch, priceLow, dipWatch,
  }
}
