import { type SecurityReport } from './snapshot.js'

/**
 * Merges security reports from several sources, field by field.
 *
 * The rule is simple and deliberately conservative: the FIRST source that
 * knows a fact wins, and any source reporting DANGER on a boolean wins over
 * a source reporting safety — a rug only has to be caught once.
 *
 * Numeric facts (tax, LP lock, concentration) take the first known value;
 * sources are ordered by trust, so put the most reliable first.
 */
export function mergeSecurity(...reports: readonly Partial<SecurityReport>[]): SecurityReport {
  const dangerWins = (key: 'honeypot' | 'mintAuthorityActive' | 'freezeAuthorityActive' | 'hasBlacklist' | 'isProxy'): boolean | null => {
    let known: boolean | null = null
    for (const r of reports) {
      const v = r[key]
      if (v === true) return true
      if (v === false) known = false
    }
    return known
  }
  const firstKnown = <K extends keyof SecurityReport>(key: K): SecurityReport[K] | null => {
    for (const r of reports) {
      const v = r[key]
      if (v !== null && v !== undefined) return v
    }
    return null
  }

  return {
    honeypot: dangerWins('honeypot'),
    mintAuthorityActive: dangerWins('mintAuthorityActive'),
    freezeAuthorityActive: dangerWins('freezeAuthorityActive'),
    hasBlacklist: dangerWins('hasBlacklist'),
    isProxy: dangerWins('isProxy'),
    transferTaxPct: firstKnown('transferTaxPct'),
    lpLockedPct: firstKnown('lpLockedPct'),
    topHoldersPct: firstKnown('topHoldersPct'),
    creatorPct: firstKnown('creatorPct'),
    // verifiedSource is a safety claim, so the pessimistic reading wins.
    verifiedSource: reports.some((r) => r.verifiedSource === false) ? false : firstKnown('verifiedSource'),
  }
}
