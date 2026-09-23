'use client'

import { useState } from 'react'
import type { OperationsView } from '../../src/application/operations-view.js'
import type { CloseAllOrder } from '../../src/domain/strategy/state.js'

/**
 * The tape, in a room of its own.
 *
 * It used to sit under the positions in Operaciones, where it grew without
 * bound while the screen did not — a page whose top nobody reached, and on a
 * phone that was the whole page. Operaciones is about what is OPEN; this is
 * about what HAPPENED, and they are different questions asked at different
 * moments.
 *
 * Thirty rows, and a file for the rest. Capping the screen without offering the
 * remainder would be deleting the audit trail from the only place the operator
 * looks at it — so the download sits at the TOP, before the rows, because
 * somebody who came here for the file should not have to scroll past thirty
 * lines to find it.
 */

const money = (n: number, digits = 2) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
// Five significant figures, not two decimals: these are micro-caps, and
// 0.0016426 shown as "0.00" makes every row of the tape the same number.
const price = (n: number) => n.toPrecision(5)
/**
 * The order comments, in the interface's language.
 *
 * Translated HERE and never in the domain: `CloseAllOrder['comment']` is a
 * typed union the parity harness compares against TradingView's own trade
 * list, so `🏁 Exit` is EVIDENCE. The project's rule is that code and
 * identifiers stay English while the interface is Spanish, and this is exactly
 * the seam between them.
 */
/**
 * Keyed by the TYPED union, not by `string`, and that is a wiring guarantee
 * rather than tidiness.
 *
 * As `Record<string, string>` the table was free to be incomplete, and it
 * was: `🛑 Stop` and `🔄 Cambio` had both been added to
 * `CloseAllOrder['comment']` and neither reached here, so the one screen the
 * operator reads was about to print English at him on what is now the most
 * frequent exit in the book. Nothing failed — a missing key simply falls
 * through to the raw comment, which is the right behaviour for an UNKNOWN
 * string and exactly the wrong one for a known member of a closed union.
 *
 * Now `tsc` refuses the omission. The same rule the engine already runs on:
 * a required field catches what a test cannot, because nobody writes the test
 * for the case they forgot existed.
 */
const SPANISH: Record<CloseAllOrder['comment'], string> = {
  '🏁 Exit': '🏁 Salida',
  '⚖️ BE Exit': '⚖️ Salida a la par',
  '☠️ Death Exit': '☠️ Salida por muerte',
  '❄️ Salida por congelamiento': '❄️ Salida por congelamiento',
  // The allocator's, and it says WHY in the word: the coin stopped qualifying
  // and the money went to one that does. Not a death — it is not blacklisted.
  '🔁 Rotación': '🔁 Rotación por filtros',
  // The only exit in the engine caused by a PRICE. It says "de más" because
  // the reader's next question is always *how much did it fall* — and the
  // answer is that it barely did, which is the whole point of the rule.
  '🛑 Stop': '🛑 Corte por caída',
  // The bounded swap: barely under water, and something better was waiting.
  '🔄 Cambio': '🔄 Cambio por una mejor',
  // A position that reached its target and was on its way to a loss. It left
  // at zero instead of at the stop, which is the whole reason it exists.
  '🔒 Break-even': '🔒 Salida en break-even',
  '📉 Sin compradores': '📉 Salida sin compradores',
}
// A DCA rung arrives as "➕ DCA-2" and an entry as "🟢 Entry" — neither is a
// `closeAll` comment, so neither is in the union above. Anything unknown is
// shown as it came rather than blanked, because an unrecognised comment is
// still the truth about what the engine did.
const OTHER: Record<string, string> = { '🟢 Entry': '🟢 Entrada' }
const spanish = (comment: string) =>
  SPANISH[comment as CloseAllOrder['comment']] ?? OTHER[comment] ?? comment

/**
 * The rung of the ladder, as a rung.
 *
 * `orderId` is `Entry` or `DCA-3`, and it appeared raw beside a line that
 * already said VENTA — so a sale read as "Entry", which is both English and
 * backwards. It is neither: it names WHICH RUNG the fill belongs to, and a
 * close-all produces one line per open rung, which is exactly why it earns a
 * column at all.
 */
const rung = (orderId: string): string => {
  if (orderId === 'Entry') return 'paso 0'
  const dca = /^DCA-(\d+)$/.exec(orderId)
  return dca ? `paso ${dca[1]}` : orderId
}

// 24h and no "a. m.": the twelve-hour form spent four characters saying
// something the number already says, and on a phone those four characters were
// what pushed the row onto a third line.
const stamp = (ms: number) =>
  new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

const UP = '#63e6a5'
const DOWN = '#ff6b6b'
const DIM = '#8b949e'

const card = (): React.CSSProperties => ({
  border: '1px solid #21262d',
  borderRadius: 10,
  padding: 14,
  background: 'rgba(13,17,23,0.6)',
})

const field = (): React.CSSProperties => ({
  background: '#0d1117',
  border: '1px solid #21262d',
  borderRadius: 6,
  color: '#e6edf3',
  fontSize: 12,
  padding: '5px 7px',
  colorScheme: 'dark',
})

export function Registry({ view }: { view: OperationsView }) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // Empty ends mean "no bound", which is what an untouched picker should mean:
  // arriving here and pressing download must give the whole history, not an
  // error about a form nobody filled in.
  const query = new URLSearchParams()
  if (from) query.set('from', from)
  if (to) query.set('to', to)
  const href = query.toString() ? `/api/fills?${query}` : '/api/fills'

  return (
    <>
      <section style={{ ...card(), marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: DIM }}>
            desde
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={field()} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: DIM }}>
            hasta
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={field()} />
          </label>
          <a
            href={href}
            download
            style={{
              marginLeft: 'auto',
              border: '1px solid #21262d',
              borderRadius: 6,
              padding: '7px 12px',
              fontSize: 12,
              color: UP,
              textDecoration: 'none',
              background: 'rgba(99,230,165,0.08)',
            }}
          >
            ⤓ descargar registro
          </a>
        </div>
        <div style={{ color: DIM, fontSize: 11, marginTop: 8 }}>
          Sin fechas descarga todo. Ambos extremos incluyen el día entero.
        </div>
      </section>

      <section style={card()}>
        <div style={{ color: DIM, fontSize: 12, marginBottom: 8 }}>
          últimas {view.recentFills.length} operaciones
        </div>

        {view.recentFills.length === 0 ? (
          <div style={{ color: DIM, fontSize: 12 }}>
            Todavía no hay compras ni ventas. El motor abre una posición cuando un token pasa todos los filtros y se
            disparan las condiciones de entrada.
          </div>
        ) : (
          view.recentFills.map((fill) => (
            /*
             * TWO LINES, not one row of fixed columns.
             *
             * The columns were sized for a desktop and wrapped on a phone, so a
             * single fill spilled across three or four ragged lines and the
             * screen read as noise. Nine values do not fit across 380 pixels at
             * any font size worth reading — so they stop competing for one row.
             *
             * What a reader comes here for goes on top, big enough to scan:
             * WHEN, which side, which token, and what it MADE. Everything else
             * is the detail line underneath, dimmer and smaller, where it can
             * wrap without breaking the rhythm of the list.
             */
            <div
              key={fill.idempotencyKey}
              style={{ padding: '7px 0', borderBottom: '1px solid #14181f' }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                <span style={{ color: DIM, whiteSpace: 'nowrap' }}>{stamp(fill.time)}</span>
                <span style={{ color: fill.side === 'buy' ? UP : DOWN, whiteSpace: 'nowrap' }}>
                  {fill.side === 'buy' ? 'COMPRA' : 'VENTA'}
                </span>
                {/* Truncated rather than wrapped: a long name must not be what
                    pushes the result off the line. */}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fill.symbol}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    whiteSpace: 'nowrap',
                    color: fill.realisedUsd === null ? DIM : fill.realisedUsd >= 0 ? UP : DOWN,
                  }}
                >
                  {fill.realisedUsd === null ? money(fill.price * fill.qty) : `${fill.realisedUsd >= 0 ? '+' : ''}${money(fill.realisedUsd)}`}
                </span>
              </div>
              <div style={{ color: DIM, fontSize: 11, marginTop: 2 }}>
                {spanish(fill.comment)} · {rung(fill.orderId)} · {price(fill.price)}
                {fill.realisedUsd !== null && ` · ${money(fill.price * fill.qty)}`}
              </div>
            </div>
          ))
        )}
      </section>
    </>
  )
}
