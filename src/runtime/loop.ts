import { alert, type AlertPort, type AlertThrottle } from '../domain/notifications/alerts.js'
import { type CycleConfig, type CycleDeps, type CycleKind, type CycleResult, runCycle } from '../application/orchestrator.js'

/**
 * The supervised loop.
 *
 * Three properties a long-running trading process needs and a `setInterval`
 * does not give you:
 *
 *  1. **A cycle never overlaps itself.** Cycles take as long as the providers
 *     take; an interval that fires regardless would run two engines over the
 *     same positions.
 *  2. **A failed cycle does not kill the process.** Providers go down. The loop
 *     backs off, alerts once, and tries again — and it says so when it
 *     recovers, because an error with no "resolved" is an error you keep
 *     worrying about.
 *  3. **Shutdown is clean.** A SIGTERM mid-cycle finishes that cycle before
 *     exiting. Dying between "decided" and "persisted" is exactly the state
 *     recovery has to untangle, so not creating it is cheaper than handling it.
 */

export interface LoopOptions {
  readonly intervalMs: number
  /** First backoff after a failed cycle; doubles, capped at `maxBackoffMs`. */
  readonly backoffMs?: number
  readonly maxBackoffMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  /** Resolves when the loop should stop after finishing the current cycle. */
  readonly stopSignal?: Promise<void>
  /** Bounded number of cycles. Omitted means run until stopped. */
  readonly maxCycles?: number
  /**
   * How often a pass also goes looking for NEW tokens.
   *
   * Omitted, every pass is a full cycle — which is what this loop always did,
   * and it meant the two halves shared one clock set by the expensive one. A
   * scan is hundreds of throttled calls and about half an hour; advancing the
   * open positions is one candle request and one sell probe each.
   *
   * With it set, the passes in between are WATCH passes: recover, advance what
   * is open, checkpoint. A token you hold can rug in ten minutes; an
   * opportunity missed by an hour is only missed.
   */
  readonly scanIntervalMs?: number
}

export interface LoopReport {
  readonly cycles: number
  readonly failures: number
  readonly lastResult: CycleResult | null
  readonly stoppedBy: 'signal' | 'max-cycles'
}

export async function runLoop(
  deps: CycleDeps,
  config: CycleConfig,
  throttle: AlertThrottle,
  options: LoopOptions,
): Promise<LoopReport> {
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const baseBackoff = options.backoffMs ?? 30_000
  const maxBackoff = options.maxBackoffMs ?? 10 * 60_000

  let stop = false
  options.stopSignal?.then(() => { stop = true })

  let cycles = 0
  let lastScanAt: number | null = null
  let failures = 0
  let consecutiveFailures = 0
  let lastResult: CycleResult | null = null
  let stoppedBy: LoopReport['stoppedBy'] = 'signal'

  await deps.alerts.send(alert('engine-started', '🚀 Operador by Open Doors', 'Motor iniciado.', deps.now()))

  for (;;) {
    if (stop) break
    if (options.maxCycles !== undefined && cycles >= options.maxCycles) {
      stoppedBy = 'max-cycles'
      break
    }

    try {
      // The first pass always scans: an engine that has never looked has no
      // reason to believe the book it woke up with is the one it wants.
      const kind: CycleKind =
        options.scanIntervalMs === undefined || lastScanAt === null || deps.now() - lastScanAt >= options.scanIntervalMs
          ? 'full'
          : 'watch'

      lastResult = await runCycle(deps, config, throttle, kind)
      cycles++
      // Stamped AFTER the pass, not before: the interval is time between the
      // end of one scan and the start of the next, so a scan that took half an
      // hour does not immediately owe another one.
      if (kind === 'full') lastScanAt = deps.now()

      if (consecutiveFailures > 0) {
        // Say when it comes back. An error with no resolution is an error the
        // human keeps carrying.
        await deps.alerts.send(alert('provider-degraded', '✅ Recuperado', `De vuelta a la normalidad tras ${consecutiveFailures} ciclo(s) fallido(s).`, deps.now()))
        consecutiveFailures = 0
      }
    } catch (error) {
      failures++
      consecutiveFailures++
      const degraded = alert('provider-degraded', '⚠️ Ciclo fallido', String(error).slice(0, 300), deps.now(), { consecutiveFailures })
      if (throttle.shouldSend(degraded)) await deps.alerts.send(degraded)

      // Back off before retrying: hammering a provider that is already failing
      // is how a temporary outage becomes a rate-limit ban.
      const backoff = Math.min(baseBackoff * 2 ** (consecutiveFailures - 1), maxBackoff)
      await sleep(backoff)
      continue
    }

    // Checked again after the cycle so a stop during a long cycle takes effect
    // immediately rather than after another full interval of sleeping.
    if (stop) break
    await sleep(options.intervalMs)
  }

  await deps.alerts.send(alert('engine-started', '🛑 Motor detenido', `${cycles} ciclo(s), ${failures} fallo(s).`, deps.now()))
  return { cycles, failures, lastResult, stoppedBy }
}

/**
 * A promise that resolves on the first SIGINT or SIGTERM.
 *
 * A second signal exits immediately: if someone is pressing Ctrl-C twice they
 * want out now, and refusing would be arrogance rather than safety.
 */
export function shutdownSignal(
  on: (signal: string, handler: () => void) => void = (s, h) => { process.on(s as NodeJS.Signals, h) },
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  return new Promise((resolve) => {
    let asked = false
    const handle = () => {
      if (asked) {
        exit(1)
        return
      }
      asked = true
      resolve()
    }
    on('SIGINT', handle)
    on('SIGTERM', handle)
  })
}
