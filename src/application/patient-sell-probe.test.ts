import { describe, it, expect } from 'vitest'
import { patientSellProbe } from './patient-sell-probe.js'
import { type SellProbePort } from './scan.js'

type SellAssessment = Awaited<ReturnType<SellProbePort['assessSell']>>

/**
 * *Estuvieron sin entrar unos minutos.* The operator, about tokens drawn as
 * prime that the engine only bought a cycle or two later.
 *
 * The scan had quoted their sale; the door, seconds later, asked again and got
 * no answer — a 429 past three tries, or a slow reply the hedge gave up on —
 * so the honeypot read UNKNOWN, the safety gates failed closed, and the token
 * waited for the next cycle. His own rule for exactly this: *wait until the
 * data arrives and stop the instant it does, and give up only after a maximum
 * of sixty with nothing.*
 */

const ok: SellAssessment = { sellQuote: 'ok', priceImpactPct: 0.2 }
const unknown: SellAssessment = { sellQuote: 'unknown', priceImpactPct: null }

const rig = (answers: readonly SellAssessment[]) => {
  let asked = 0
  let slept = 0
  const probe: SellProbePort = {
    assessSell: async () => answers[Math.min(asked++, answers.length - 1)]!,
  }
  const patient = patientSellProbe(probe, { budgetMs: 60_000, backoffMs: 1_000, sleep: async (ms) => { slept += ms } })
  return { patient, asked: () => asked, slept: () => slept }
}

describe('patientSellProbe — wait for the answer, stop the instant it arrives', () => {
  it('asks once and waits for nothing when the first answer is an answer', async () => {
    const { patient, asked, slept } = rig([ok])
    expect(await patient.assessSell('T', 1n, 6, 100)).toEqual(ok)
    expect(asked()).toBe(1)
    expect(slept()).toBe(0)
  })

  it('asks again after an unanswered quote, and stops the moment one answers', async () => {
    const { patient, asked, slept } = rig([unknown, unknown, ok])
    expect(await patient.assessSell('T', 1n, 6, 100)).toEqual(ok)
    expect(asked()).toBe(3)
    // One second, then two: the polite shape for a rate limit.
    expect(slept()).toBe(3_000)
  })

  it('never retries a VERDICT — a failed sale is the answer, not silence', async () => {
    const { patient, asked } = rig([{ sellQuote: 'failed', priceImpactPct: null }, ok])
    expect((await patient.assessSell('T', 1n, 6, 100)).sellQuote).toBe('failed')
    expect(asked()).toBe(1)
  })

  it('gives up after sixty seconds with nothing, and the door then refuses closed', async () => {
    const { patient, slept } = rig([unknown])
    expect((await patient.assessSell('T', 1n, 6, 100)).sellQuote).toBe('unknown')
    // The whole budget, the last wait trimmed to what remained — never more.
    expect(slept()).toBe(60_000)
  })
})
