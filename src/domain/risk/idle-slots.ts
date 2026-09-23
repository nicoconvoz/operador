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
  /**
   * How much of a loss the allocator may accept to move a slot to a better
   * token, in percent. Absent means it may accept none.
   *
   * The operator's rule: *si el token ha perdido menos del 1.2% y la moneda
   * está en un puntaje bajo, cambiarla por una mejor y asumir esa pequeña
   * pérdida.*
   *
   * ## It is a TOLL, not a trigger, and the difference is the whole design
   *
   * A stop loss exits because the PRICE fell. This exits because the token
   * stopped being the best use of the slot — a ranking decision — and the
   * percentage is the most the move is allowed to COST, never the reason for
   * making it. A position down 1% that still ranks well is not touched, and no
   * amount of falling makes this fire on its own.
   *
   * That distinction is what keeps it out of the path the death watch's type
   * system protects. A price cannot cause this sale; a better candidate can.
   *
   * ## What it changes, stated rather than discovered later
   *
   * This file has refused to touch a slot holding tokens since it was written,
   * for a reason worth repeating: a position with fills is a COMMITMENT, the
   * slot cannot come back without selling, and selling is the strategy's
   * decision and never the allocator's.
   *
   * The operator has now made it the allocator's, bounded. The bound is what
   * makes it survivable: at 1.2% the worst a churn can cost is 1.2% a move,
   * where an unbounded version would let the allocator realise any loss it
   * liked in pursuit of a score that moves bar to bar.
   */
  readonly maxSwapLossPct?: number
  /**
   * Whether a slot HOLDING tokens may be sold for a better token at all.
   * Absent means yes, which is how this file has worked since the operator
   * made it the allocator's call; false returns the decision to the position's
   * own exits. *No me cortes por cambio por una mejor — sólo dejá que, si el
   * TP que habíamos puesto se activa, cierre; si no, no.*
   */
  readonly swapHolders?: boolean
}

/** Three hours: twelve bars at 15m, most of the 20-bar swing-high window. */
/** The operator number: a move may cost at most this much. */
export const DEFAULT_MAX_SWAP_LOSS_PCT = 1.2

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
   * Whether the death watch has frozen this slot's ladder.
   *
   * A frozen slot cannot BUY — that is what freezing means — so a frozen slot
   * holding nothing is waiting for something that cannot happen.
   */
  readonly frozen?: boolean
  /**
   * Whether the death watch has CONDEMNED this token.
   *
   * Terminal in a way nothing else here is: the token is blacklisted and can
   * never be opened again, by this slot or any other. So unlike every other
   * case in this file, there is no version of the future where the incumbent
   * makes use of what it is holding.
   */
  readonly dead?: boolean
  /**
   * Where the position stands against what was paid, in percent. Negative is
   * under water. Null when there is no live price to judge it by.
   *
   * It exists for one case and is read nowhere else: a slot HOLDING something
   * that is no longer the best use of the money. See `maxSwapLossPct`.
   */
  readonly unrealisedPct?: number | null
  /**
   * What this position's whole round trip costs, in percent of what it
   * deployed — fees already paid plus the cost of selling now. A winner must
   * be up MORE than this to be swapped. Null: nobody could measure it.
   */
  readonly tollPct?: number | null
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
  const decisions: SlotDecision[] = []

  // ── Slots nobody can ever use again ──────────────────────────────────────
  //
  // Decided BEFORE the empty-queue cap below, and the reason is that cap's own
  // argument: a slot is only worth taking back when somebody is there to take
  // it, because *the incumbent might yet enter*.
  //
  // For these two that is simply false. A DEAD token is blacklisted and can
  // never be opened again by anyone. A FROZEN one cannot buy either — freezing
  // blocks entries, which is the whole definition of stage one — and holds
  // nothing to sell. Neither incumbent is going to enter, so nothing is lost
  // by letting the row go, and what was lost by keeping it is a slot, a line
  // on the screen and a notification about a position that will never act.
  //
  // Reported from the live book: *hay una que murió y una congelada, y aunque
  // no tengo dinero en ellas quedaron atrapadas en mi lista sin poderlas
  // sacar.* Both were stuck on `waiting.length === 0`.
  for (const holder of holders) {
    // Holding something ends the conversation here too, and a death exit does
    // not suspend it: a slot with tokens in it cannot come back without
    // selling, and selling is never the allocator's decision. A death exit
    // that could not complete leaves exactly this state, and the position must
    // stay visible rather than be quietly retired with the money still inside.
    if (holder.openQty > 0) continue
    if (holder.dead === true) {
      decisions.push({ holder, reason: 'el token está muerto y vetado — la ranura no puede servirle a nada' })
      continue
    }
    if (holder.frozen === true) {
      decisions.push({ holder, reason: 'congelada sin haber comprado nada — no puede entrar ni tiene qué vender' })
    }
  }

  // ── Everything else needs somebody waiting for the slot ──────────────────
  if (waiting.length === 0) return decisions
  const best = Math.max(...waiting)

  const terminal = new Set(decisions.map((d) => d.holder.id))
  // ── Slots HOLDING something, which is the operator's later exception ─────
  //
  // Everything below this refuses a slot with tokens in it. This does not, and
  // it is the one case he asked for: a position barely under water in a token
  // that no longer ranks, while something better waits outside.
  //
  // Both halves are required and neither is sufficient. A low score alone does
  // not sell — the slot keeps its token. A small loss alone does not sell —
  // there has to be somewhere better for the money to go. It is a swap, and a
  // swap needs both ends.
  const tolerance = policy.maxSwapLossPct ?? 0
  for (const holder of holders) {
    if (terminal.has(holder.id) || holder.openQty <= 0) continue
    if (policy.swapHolders === false) continue
    // No live price, no verdict. Selling on a number no second source
    // confirmed is how a $15 position once left at a tenth of a cent.
    const standing = holder.unrealisedPct
    if (standing === null || standing === undefined) continue
    if (holder.score !== null && best < holder.score + policy.minScoreEdge) continue
    // A WINNER whose score fell behind a clearly better one takes its gain and
    // makes room: *la que esté en ganancia y caiga su puntaje, rotar a otra con
    // mejor.* It owes no toll, so it needs none configured — and the no-loss
    // guard still refuses the sale if leaving would cost more than the gain.
    if (standing > 0) {
      // *Veinte centavos no: si hay más plata en juego debe ser más el piso, y
      // debe ser un porcentaje que contemple la comisión.* Up by more than the
      // whole round trip costs, or it would close in the red after fees.
      const toll = holder.tollPct
      if (toll === null || toll === undefined || standing <= toll) continue
      decisions.push({
        holder,
        reason:
          holder.score === null
            ? `está en ganancia (+${standing.toFixed(2)}%, más que el ${toll.toFixed(2)}% que cuesta el viaje) y ya no está entre los candidatos — rota a una mejor`
            : `está en ganancia (+${standing.toFixed(2)}%, más que el ${toll.toFixed(2)}% que cuesta el viaje) y hay un candidato ${(best - holder.score).toFixed(0)} puntos mejor`,
      })
      continue
    }
    if (tolerance <= 0) continue
    if (standing < -tolerance) continue
    decisions.push({
      holder,
      reason:
        holder.score === null
          ? `ya no está entre los candidatos y pierde solo ${Math.abs(standing).toFixed(2)}% — se cambia por una mejor`
          : `hay un candidato ${(best - holder.score).toFixed(0)} puntos mejor y esta pierde solo ${Math.abs(standing).toFixed(2)}%`,
    })
  }
  const swapped = new Set(decisions.map((d) => d.holder.id))

  for (const holder of holders) {
    if (terminal.has(holder.id) || swapped.has(holder.id)) continue
    // Holding something is the end of the conversation. Everything below is
    // about slots with nothing in them.
    if (holder.openQty > 0) continue

    // A slot that has never traded is NOT re-examined yet. It was chosen by
    // this same ranking minutes ago, and the ranking moves bar to bar: acting
    // on it immediately would open a position and close it on the next scan,
    // which is churn wearing the costume of discipline. It gets the window
    // first, and only then is it judged.
    // A FROZEN reservation is judged at once, window or no window.
    //
    // The window exists so a slot chosen by this same ranking minutes ago is
    // not condemned before its setup had a chance. A frozen one had no chance
    // and will get none: freezing blocks entries, so it cannot buy, and it
    // holds nothing to sell. Waiting three hours buys nothing at all.
    //
    // Six sat like that at once, each holding a slot and the capital for a
    // ladder that could never fire.
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
