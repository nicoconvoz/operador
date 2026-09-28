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
 * A table and not the Registro's two-line rows: five short figures fit across
 * a phone, and a day is read ACROSS — what it made, where it ended, how low and
 * how high it went — which is exactly what columns are for.
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

const cell = (align: 'left' | 'right' = 'right'): React.CSSProperties => ({
  textAlign: align,
  padding: '7px 4px',
  whiteSpace: 'nowrap',
})

export function DailyLog({ view }: { view: DailyLogView | undefined }) {
  const days = view?.days ?? []

  return (
    <section style={card()}>
      <div style={{ color: DIM, fontSize: 12, marginBottom: 8 }}>
        ganancia por día, hora de Buenos Aires — la de hoy se actualiza en cada ciclo del motor
      </div>

      {days.length === 0 ? (
        <div style={{ color: DIM, fontSize: 12 }}>
          Todavía no hay días registrados. El motor anota la ganancia al final de cada ciclo; el primer día aparece acá en
          cuanto termine una pasada.
        </div>
      ) : (
        // Scrolls sideways rather than squeezing, on a phone narrow enough to
        // need it: a figure cut in half is worse than one a swipe away.
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            <thead>
              <tr style={{ color: DIM, fontSize: 11 }}>
                <th style={{ ...cell('left'), fontWeight: 'normal' }}>Día</th>
                {/* Allowed to wrap: the longest header must not be what pushes
                    the table off a phone. */}
                <th style={{ ...cell(), fontWeight: 'normal', whiteSpace: 'normal' }}>Resultado del día</th>
                <th style={{ ...cell(), fontWeight: 'normal' }}>Acumulado</th>
                <th style={{ ...cell(), fontWeight: 'normal' }}>Mínimo</th>
                <th style={{ ...cell(), fontWeight: 'normal' }}>Máximo</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.day} style={{ borderTop: '1px solid #14181f' }}>
                  <td style={{ ...cell('left'), color: d.isToday ? '#e6edf3' : DIM }}>{dayLabel(d.day, d.isToday)}</td>
                  <td style={{ ...cell(), color: tone(d.resultUsd), fontSize: 13 }}>{signed(d.resultUsd)}</td>
                  <td style={{ ...cell(), color: tone(d.closeUsd) }}>{signed(d.closeUsd)}</td>
                  <td style={{ ...cell(), color: tone(d.minUsd) }}>{signed(d.minUsd)}</td>
                  <td style={{ ...cell(), color: tone(d.maxUsd) }}>{signed(d.maxUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* What each column IS, said once. "Resultado" and "Acumulado" are two
          readings of the same running figure, and a reader who takes one for
          the other adds a day's gain to itself. */}
      <div style={{ color: DIM, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>
        Acumulado: la ganancia total (cobrada + sin cobrar − costos) en la última lectura del día. Resultado del día: el
        acumulado menos el del día anterior; el primer día registrado se mide desde su primera lectura. Mínimo y máximo:
        lo más bajo y lo más alto que tocó el acumulado ese día.
      </div>
    </section>
  )
}
