import { type TokenSnapshot } from '../scanner/snapshot.js'

/**
 * How much ONE buy puts into a token, by how dangerous it looks.
 *
 * *Si el token es más peligroso le asignamos 5 USD, si es normal 10, si es muy
 * bueno 15 y si es seguro seguro 25 — una sola compra.* The operator, and the
 * table he took:
 *
 * | Class | Rule | Buy |
 * |---|---|---|
 * | dangerous | liquidity under $250k, or the top ten holding more than 50% | $5 |
 * | normal | liquidity $250k – $1M | $10 |
 * | good | liquidity $1M – $5M | $25 |
 * | safe | liquidity over $5M, top ten under 30%, more than 30 days old | $50 |
 *
 * Then *a las que valen 25 ponele 50 y a las que valen 15 ponele 25*: very
 * good went from $15 to $25 and safe from $25 to $50.
 *
 * Concentration nobody measured is dangerous: silence takes the smaller bet. A
 * pool over $5M that misses the holders or the age is `good`, never `safe`.
 *
 * Pure: the snapshot's own clock is the "now" the age is read against.
 */

export type TokenTier = 'dangerous' | 'normal' | 'good' | 'safe'

export const TIER_USD: Readonly<Record<TokenTier, number>> = { dangerous: 5, normal: 10, good: 25, safe: 50 }

const DAY_MS = 86_400_000

export function tierOf(snapshot: TokenSnapshot): TokenTier {
  const liquidity = snapshot.liquidityUsd
  const top = snapshot.security?.topHoldersPct ?? null
  if (liquidity < 250_000 || top === null || top > 50) return 'dangerous'
  if (liquidity < 1_000_000) return 'normal'
  const ageDays = snapshot.pairCreatedAt === null ? null : (snapshot.observedAt - snapshot.pairCreatedAt) / DAY_MS
  if (liquidity > 5_000_000 && top < 30 && ageDays !== null && ageDays > 30) return 'safe'
  return 'good'
}

/** What one buy puts into this token. */
export const tierUsd = (snapshot: TokenSnapshot): number => TIER_USD[tierOf(snapshot)]

const RANK: Readonly<Record<TokenTier, number>> = { dangerous: 0, normal: 1, good: 2, safe: 3 }

/** Whether a word names a class. */
export const isTokenTier = (value: string): value is TokenTier => value in RANK

/**
 * What one buy puts into this token if its class is `lowest` or better, and
 * zero otherwise. *De todas las monedas dejame las que califiquen como 15 y
 * 25* — from `good` up.
 */
export const admittedUsd = (snapshot: TokenSnapshot, lowest: TokenTier): number => {
  const tier = tierOf(snapshot)
  return RANK[tier] >= RANK[lowest] ? TIER_USD[tier] : 0
}
