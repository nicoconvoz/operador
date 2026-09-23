import { type SellProbePort } from './scan.js'

/**
 * A sell probe that WAITS for an answer instead of reporting silence.
 *
 * *Estuvieron sin entrar unos minutos.* Tokens drawn as prime were bought a
 * cycle or two late: the scan had quoted their sale, and the door, seconds
 * later, asked again and got nothing — a 429 past Jupiter's three tries, or a
 * slow reply the hedge gave up on. An unanswered quote reads as an UNKNOWN
 * honeypot, the safety gates fail closed, and the token waits for the next
 * cycle.
 *
 * The operator's rule for exactly this, already written down for the candle
 * feed: *wait until the data arrives and stop the instant it does — sometimes
 * three seconds, sometimes forty — and give up only after a maximum of sixty
 * with nothing.* A budget of TIME, not a count of tries.
 *
 * Only silence is retried. A failed or implausible quote is a VERDICT about the
 * token, and asking again until it says otherwise would be shopping for the
 * answer we want. Out of budget, the last unknown is returned and the door
 * refuses closed, exactly as before — this changes how long it listens, never
 * what it concludes.
 *
 * The waits are counted, never read off a clock, so a test with an instant
 * `sleep` cannot spin for ever — and the last one is trimmed to what remains,
 * because the unspent half of a budget is exactly where a slow provider
 * would have answered.
 */
export function patientSellProbe(
  probe: SellProbePort,
  options: { readonly budgetMs: number; readonly backoffMs: number; readonly sleep: (ms: number) => Promise<void> },
): SellProbePort {
  return {
    async assessSell(token, amountRaw, decimals, expectedUsd) {
      let waited = 0
      for (let attempt = 0; ; attempt++) {
        const answer = await probe.assessSell(token, amountRaw, decimals, expectedUsd)
        const remaining = options.budgetMs - waited
        if (answer.sellQuote !== 'unknown' || remaining <= 0) return answer
        const wait = Math.min(options.backoffMs * 2 ** attempt, remaining)
        waited += wait
        await options.sleep(wait)
      }
    },
  }
}
