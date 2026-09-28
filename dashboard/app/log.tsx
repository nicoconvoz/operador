'use client'

import type { DailyLogView } from '../../src/application/daily-log.js'

/**
 * The Log: what the book made, day by day.
 *
 * *Un nuevo botón que funcione de Log, para llevar el control de cuánto va
 * ganando cada día, el mínimo y el máximo de ese día también.* The headline
 * answers "how are we NOW" and moves on every poll; a running total cannot say
 * how Tuesday went. This can, because the engine writes the headline's own
 * figure down every cycle, into the row of the day it was taken on.
 *
 * Nothing here is computed from the money. The rows are what the ENGINE
 * recorded with the same function the headline is drawn with; this component
 * only lays them out. A second calculation of "how much are we up" on the
 * screen is the drift this project keeps paying for.
 *
 * One CARD per day, not a table row. It started as a five-column table, and
 * the operator read it off his screen: *se ve todo muy junto, muy pegado, y
 * para cantidades más grandes de dinero ni siquiera va a entrar.* Five figures
 * across a phone leave each one about sixty pixels, which a four-digit profit
 * with its sign and cents already overflows. So the day's result leads, large,
 * and the three readings under it sit in boxes that wrap to fewer columns when
 * the screen is narrow — a figure never has to share its line with four others.
 */

const UP = '#63e6a5'
const DOWN = '#ff6b6b'
const DIM = '#8b949e'

// Cents, kept, and a real minus sign — the headline's own formatting, so a
// figure copied from one to the other reads the same.
const exact = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${exact(n)}`
// Coloured by SIGN, like the headline: green is ahead, red is behind.
const tone = (n: number) => (n >= 0 ? UP : DOWN)

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

/**
 * `2026-09-28` as `lun 28/09`, or `hoy 28/09`.
 *
 * Read as a CALENDAR date, never parsed as an instant: `new Date('2026-09-28')`
 * is midnight UTC, which is the evening before in Buenos Aires, and the row
 * would be labelled with the wrong day of the week.
 */
const dayLabel = (day: string, isToday: boolean) => {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7))
  const date = Number(day.slice(8, 10))
  const weekday = isToday ? 'hoy' : (WEEKDAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()] ?? '')
  return `${weekday} ${day.slice(8, 10)}/${day.slice(5, 7)}`
}

const card = (): React.CSSProperties => ({
  border: '1px solid #21262d',
  borderRadius: 10,
  padding: 14,
  background: 'rgba(13,17,23,0.6)',
})

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

/** One reading under the day's result: a label, and room for any amount. */
function Reading({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid #1b2129', borderRadius: 8, padding: '10px 12px', background: 'rgba(22,27,34,0.55)', minWidth: 0 }}>
      <div style={{ color: DIM, fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      <div style={{ color: tone(value), fontSize: 16, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
        {signed(value)}
      </div>
    </div>
  )
}

/**
 * Where the day ended between its low and its high. A bar, because "it closed
 * near the top of its range" is a shape, and three numbers make the reader
 * draw it in their head. Nothing when the day never moved.
 */
function Range({ min, max, close }: { min: number; max: number; close: number }) {
  const span = max - min
  if (!(span > 0)) return null
  const at = Math.min(100, Math.max(0, ((close - min) / span) * 100))
  return (
    <div aria-hidden style={{ position: 'relative', height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${DOWN}55, ${UP}55)` }}>
      <div style={{ position: 'absolute', top: -3, left: `calc(${at}% - 6px)`, width: 12, height: 12, borderRadius: '50%', background: '#e6edf3', border: '2px solid #0d1117' }} />
    </div>
  )
}

export function DailyLog({ view }: { view: DailyLogView | undefined }) {
  const days = view?.days ?? []

  return (
    <section style={card()}>
      <div style={{ color: DIM, fontSize: 12, marginBottom: 14 }}>
        ganancia por día, hora de Buenos Aires — la de hoy se actualiza en cada ciclo del motor
      </div>

      {days.length === 0 ? (
        <div style={{ color: DIM, fontSize: 12 }}>
          Todavía no hay días registrados. El motor anota la ganancia al final de cada ciclo; el primer día aparece acá en
          cuanto termine una pasada.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {days.map((d) => (
            <article
              key={d.day}
              style={{
                border: `1px solid ${d.isToday ? '#2d3a45' : '#1b2129'}`,
                borderRadius: 10,
                padding: 16,
                display: 'grid',
                gap: 14,
                background: d.isToday ? 'rgba(99,230,165,0.04)' : 'transparent',
              }}
            >
              {/* The day and what it made, on one line that wraps before it
                  squeezes: a long result drops under the date instead of
                  overflowing the card. */}
              <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: '6px 16px' }}>
                <div style={{ color: d.isToday ? '#e6edf3' : DIM, fontSize: 14, fontWeight: 600 }}>{dayLabel(d.day, d.isToday)}</div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ color: DIM, fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Resultado del día</div>
                  <div style={{ color: tone(d.resultUsd), fontSize: 22, fontWeight: 700, fontFamily: MONO, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' }}>
                    {signed(d.resultUsd)}
                  </div>
                </div>
              </header>

              {/* Three boxes that fall to two, then one, as the screen narrows —
                  never five figures sharing a phone's width. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                <Reading label="Acumulado" value={d.closeUsd} />
                <Reading label="Mínimo" value={d.minUsd} />
                <Reading label="Máximo" value={d.maxUsd} />
              </div>

              <Range min={d.minUsd} max={d.maxUsd} close={d.closeUsd} />
            </article>
          ))}
        </div>
      )}

      {/* What each figure IS, said once. "Resultado" and "Acumulado" are two
          readings of the same running figure, and a reader who takes one for
          the other adds a day's gain to itself. */}
      <div style={{ color: DIM, fontSize: 11, marginTop: 14, lineHeight: 1.6 }}>
        Acumulado: la ganancia total (cobrada + sin cobrar − costos) en la última lectura del día. Resultado del día: el
        acumulado menos el del día anterior; el primer día registrado se mide desde su primera lectura. Mínimo y máximo:
        lo más bajo y lo más alto que tocó el acumulado ese día; la barra marca dónde cerró el día entre los dos.
      </div>
    </section>
  )
}
