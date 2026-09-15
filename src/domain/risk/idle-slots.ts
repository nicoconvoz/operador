/**
 * Slots that are not earning them.
 *
 * The portfolio hands a slot and its capital to a token BEFORE the strategy
 * enters it: the scanner says "worth running the machine on", and CASCADE DCA
 * then waits for its own gates. Two ways that stops being a good deal:
 *
 *  1. The gates never line up, and the position sits at level 0 indefinitely.
 *     Measured live at five hours and twenty minutes, holding $285 and one of
 *     five slots while candidates scoring 76 and 72 waited outside.
 *  2. It takes its profit, goes flat, and the token is no longer what it was
 *     when it was chosen — or something better has appeared since.
 *
 * Both are the same situation wearing different clothes, and the rule that
 * covers both is about what the position HOLDS, not what it has done:
 *
 *   A position holding tokens is a COMMITMENT. The slot cannot come back
 *   without selling, and selling is the strategy's decision, never the
 *   allocator's.
 *
 *   A position holding NOTHING is a RESERVATION. Handing it on costs nothing,
 *   because nothing is in it.
 *
 * A token that has TRADED is re-examined the moment it goes flat. One that
 * never entered waits out the window first: it was chosen by this same ranking
 * minutes ago, and judging it against a ranking that moves bar to bar would
 * open a position and close it on the next scan.
 */

export interface IdleSlotPolicy {
  /**
   * How long a reservation that has never traded may sit before the slot can
   * go to someone else. Long enough that the entry gates had a fair chance,
   * short enough that a dead reservation is not a permanent tax on the book.
   */
  readonly idleAfterMs: number
  /**
   * How much better a waiting candidate must score to take an idle slot.
   *
   * Not zero, and the margin is the whole reason it is here: the opportunity
   * score is a heuristic that moves bar to bar, so swapping on any difference
   * at all would trade the book against its own noise and pay gas for the
   * privilege.
   */
  readonly minScoreEdge: number
}

/** Three hours: twelve bars at 15m, most of the 20-bar swing-high window. */
export const DEFAULT_IDLE_SLOT_POLICY: IdleSlotPolicy = { idleAfterMs: 3 * 3_600_000, minScoreEdge: 10 }

export interface SlotHolder {
  readonly id: string
  readonly chain: string
  readonly tokenAddress: string
  readonly symbol: string
  readonly openedAt: number
  /**
   * Units still held, from the FILLS — never from the cascade level. A machine
   * can sit at level 1 believing it holds something the broker refused, and a
   * reservation dressed as a position is the case this must not misread.
   */
  readonly openQty: number
  /** Whether anything was ever bought. Different from holding something now. */
  readonly hasFills: boolean
  /**
   * What the scanner thinks of this token RIGHT NOW, or null when it is not
   * among the candidates at all.
   *
   * Null covers two things — it stopped clearing the gates, or it ranked below
   * the watch-slot cut — and the reason text must not claim which. Both mean
   * the same thing to an allocator holding an empty slot: the scanner would not
   * choose this token today.
   */
  readonly score: number | null
}

export interface SlotDecision {
  readonly holder: SlotHolder
  /** Why it is being handed on, for the alert and the log. */
  readonly reason: string
}

/**
 * Which slots should change hands, weakest first.
 *
 * `waiting` caps the answer because freeing a slot into an empty queue is pure
 * loss: the incumbent might yet enter, and nothing else can use what it gives
 * up. A slot is only worth taking back when somebody is there to take it.
 */
export function releasableSlots(
  holders: readonly SlotHolder[],
  waiting: readonly number[],
  now: number,
  policy: IdleSlotPolicy = DEFAULT_IDLE_SLOT_POLICY,
): readonly SlotDecision[] {
  if (waiting.length === 0) return []
  const best = Math.max(...waiting)

  const decisions: SlotDecision[] = []
  for (const holder of holders) {
    // Holding something is the end of the conversation. Everything below is
    // about slots with nothing in them.
    if (holder.openQty > 0) continue

    // A slot that has never traded is NOT re-examined yet. It was chosen by
    // this same ranking minutes ago, and the ranking moves bar to bar: acting
    // on it immediately would open a position and close it on the next scan,
    // which is churn wearing the costume of discipline. It gets the window
    // first, and only then is it judged.
    const proven = holder.hasFills
    const waited = now - holder.openedAt >= policy.idleAfterMs
    if (!proven && !waited) continue

    if (holder.score === null) {
      decisions.push({ holder, reason: 'el escáner ya no lo tiene entre sus candidatos' })
      continue
    }
    if (best >= holder.score + policy.minScoreEdge) {
      decisions.push({ holder, reason: `hay un candidato ${(best - holder.score).toFixed(0)} puntos mejor esperando` })
      continue
    }
    if (!proven && waited) {
      decisions.push({ holder, reason: `reservó una ranura y ${Math.round((now - holder.openedAt) / 3_600_000)}h después no compró nada` })
    }
  }

  // Weakest first: if only two slots can change hands, they should be the two
  // least deserving of one.
  return decisions
    .sort((a, b) => (a.holder.score ?? -1) - (b.holder.score ?? -1))
    .slice(0, waiting.length)
}
