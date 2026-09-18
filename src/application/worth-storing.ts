import { type Candidate } from '../domain/scanner/ranking.js'
import { type TokenSnapshot } from '../domain/scanner/snapshot.js'

/**
 * Which of a scan's snapshots are worth writing down.
 *
 * Measured on a live scan: **187 filtered and 108 unsafe cost 227 KB against
 * ONE kilobyte for everything the engine could actually trade.** Ninety-nine
 * percent of what was stored, read back on every poll and drawn on a phone was
 * tokens nobody will ever touch — and the same bytes are what exhausted a 5 GB
 * monthly transfer allowance in thirty-four hours.
 *
 * The operator's rule: *do not even put them on the radar.* Nothing is lost by
 * forgetting a rejection, because the universe is re-discovered from scratch on
 * every scan — if one becomes tradeable, the next pass brings it back with
 * fresh numbers rather than stale ones.
 *
 * **A HELD token is kept whatever the gates say, and that is the trap in this
 * change.** A token of ours whose mint authority came back fails every safety
 * gate, and it is the most urgent thing this screen can say — `turnedUnsafe`
 * exists for exactly that. Dropping it as "rejected" would delete the alarm and
 * leave the dashboard serenely quiet about our money sitting in something that
 * just turned.
 *
 * What is lost, stated rather than discovered later: the per-token REASONS for
 * every rejection. Tallying those across the rejected set is what found three
 * separate bugs in one day — `turnover` blocking 108 tokens alone, a history
 * gate stuck at "99 < 100", and 26 positions reddened by a rate limit. A
 * histogram of gate → count would keep that for a few hundred bytes, and is the
 * obvious next thing if diagnosing a quiet scanner ever gets hard again.
 */
export function worthStoring(
  snapshots: readonly TokenSnapshot[],
  candidates: readonly Candidate[],
  held: readonly string[],
): readonly TokenSnapshot[] {
  const keep = new Set<string>([...held, ...candidates.map((c) => c.snapshot.address)])
  return snapshots.filter((snapshot) => keep.has(snapshot.address))
}
