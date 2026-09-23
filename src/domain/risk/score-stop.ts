/**
 * A stop on the SCORE: the position leaves once its score is `points` or more
 * under the score it was bought at.
 *
 * *Cuando el puntaje cae 5 puntos, SL.* The operator, after PEPE: bought at
 * 93.2, down to 65.9 ten minutes later as its hour turned −5.7%, and still
 * held at −11.6% an hour after that.
 *
 * Stated rather than discovered later: every component the score weighs
 * today — trend, the hour's margin, the toll — is read off the price, so this
 * is a price stop by another road, and it sells at a loss. It is the
 * operator's to ask for. It stays out of the death watch, whose observation
 * type refuses any price-shaped field.
 *
 * Silence is not evidence: no score read, or no baseline, never sells.
 */
export const SCORE_STOP_COMMENT = '📉 Cae el puntaje' as const

export function scoreFell(
  input: { readonly entryScore: number | null; readonly score: number | null },
  points: number,
): boolean {
  if (!(points > 0)) return false
  if (input.entryScore === null || input.score === null) return false
  return input.entryScore - input.score >= points
}
