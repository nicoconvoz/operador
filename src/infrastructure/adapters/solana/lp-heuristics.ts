import { type SecurityReport } from '../../../domain/scanner/snapshot.js'

/**
 * LP lock on Solana, when no source reports it.
 *
 * Neither GoPlus nor Jupiter exposes LP holders for Solana pools, and the
 * on-chain read (LP mint supply vs burned/locked balances, per DEX layout)
 * is not built yet. One fact IS reliable by protocol design: pools created
 * by pump.fun's migration — PumpSwap, and the Raydium pools it seeded — have
 * their LP burned at creation. Nobody holds LP tokens to pull.
 *
 * This is a HEURISTIC, tagged as such so the audit log can show where a
 * number came from. Every other venue stays unknown, and unknown fails
 * closed at the gate.
 */
const PROTOCOL_BURNED_LP = new Set(['pumpswap', 'pumpfun'])

export function lpLockFromVenue(dexId: string | undefined): Partial<SecurityReport> {
  if (dexId && PROTOCOL_BURNED_LP.has(dexId.toLowerCase())) return { lpLockedPct: 100 }
  return {}
}
