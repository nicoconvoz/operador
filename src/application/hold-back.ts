import type { HoldBack } from './universe-view.js'

/** A percentage as a door states it: whole where it is whole, one decimal where it is not. */
const doorPct = (fraction: number): string => String(Number((fraction * 100).toFixed(1)))

/**
 * One held-back door in the operator's words: what the token read and what the
 * door asks — *presión compradora 7.3% (pide > 10%)*. A filtered token with no
 * reason on it once sent the operator hunting for a bug that was a 49% against
 * a 50%; this is the sentence that says so.
 *
 * Here rather than in the web app, because the screen has no tests and the one
 * sentence that explains a refusal is worth having one — and alone in its file,
 * with nothing but a type imported, so the browser bundle that draws it does not
 * carry the gates and the scorer along.
 */
export function describeHoldBack(door: HoldBack, labels: Readonly<Record<string, string>>): string {
  if (door.kind === 'slots') return `sin lugar libre: el capital toma ${door.floor} y hay candidatas más baratas de operar (${labels[door.name] ?? door.name} ${(door.value * 100).toFixed(1)}%)`
  if (door.kind === 'score') return `puntaje ${door.value.toFixed(1)} (la puerta pide ${door.floor})`
  const asks = door.kind === 'entry' ? 'la primera compra pide' : 'pide'
  return `${labels[door.name] ?? door.name} ${(door.value * 100).toFixed(1)}% (${asks} ${door.strict ? '>' : '≥'} ${doorPct(door.floor)}%)`
}
