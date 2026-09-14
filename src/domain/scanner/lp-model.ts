/**
 * How a venue represents liquidity — because "is the LP locked?" only means
 * something where LP tokens exist.
 *
 *  lp-token      classic constant-product pools (Raydium AMM v4 / CPMM,
 *                PumpSwap, PancakeSwap). The provider holds LP tokens; if they
 *                are burned or locked, liquidity cannot be pulled.
 *  concentrated  Orca Whirlpools, Raydium CLMM, Meteora DLMM. Positions are
 *                NFTs; there is no LP token to lock. The rug vector is the
 *                provider withdrawing, which no lock prevents — the defenses
 *                are the liquidity gate at entry and the death exit's
 *                continuous liquidity monitoring.
 *
 * The lpLocked gate applies to the first model and is skipped for the second.
 * It does NOT pass the second by pretending a lock exists.
 */
export type LpModel = 'lp-token' | 'concentrated'

export function lpModelOf(dexId: string | undefined, labels: readonly string[] = []): LpModel {
  const id = (dexId ?? '').toLowerCase()
  const tags = labels.map((l) => l.toUpperCase())
  if (id === 'orca') return 'concentrated'
  if (id === 'raydium' && tags.includes('CLMM')) return 'concentrated'
  if (id.startsWith('meteora') && (tags.includes('DLMM') || id === 'meteora')) return 'concentrated'
  return 'lp-token'
}
