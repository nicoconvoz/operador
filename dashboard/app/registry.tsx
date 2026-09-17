'use client'

import { useState } from 'react'
import type { OperationsView } from '../../src/application/operations-view.js'

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
const SPANISH: Record<string, string> = {
  '🟢 Entry': '🟢 Entrada',
  '🏁 Exit': '🏁 Salida',
  '⚖️ BE Exit': '⚖️ Salida a la par',
  '☠️ Death Exit': '☠️ Salida por muerte',
  '❄️ Salida por congelamiento': '❄️ Salida por congelamiento',
}
// A DCA rung arrives as "➕ DCA-2" and needs no translating; anything unknown is
// shown as it came rather than blanked, because an unrecognised comment is
// still the truth about what the engine did.
const spanish = (comment: string) => SPANISH[comment] ?? comment

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
  if (orderId === 'Entry') return 'peldaño 0'
  const dca = /^DCA-(\d+)$/.exec(orderId)
  return dca ? `peldaño ${dca[1]}` : orderId
}

const stamp = (ms: number) =>
  new Date(ms).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

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
            <div
              key={fill.idempotencyKey}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                fontSize: 12,
                padding: '6px 0',
                borderBottom: '1px solid #14181f',
              }}
            >
              <span style={{ color: DIM, width: 84 }}>{stamp(fill.time)}</span>
              <span style={{ color: fill.side === 'buy' ? UP : DOWN, width: 52 }}>
                {fill.side === 'buy' ? 'COMPRA' : 'VENTA'}
              </span>
              <span style={{ width: 70 }}>{fill.symbol}</span>
              <span style={{ color: DIM, width: 72 }}>{rung(fill.orderId)}</span>
              <span style={{ color: DIM, flex: 1, minWidth: 90 }}>{spanish(fill.comment)}</span>
              <span style={{ width: 90, textAlign: 'right', color: DIM }}>{price(fill.price)}</span>
              <span style={{ width: 82, textAlign: 'right' }}>{money(fill.price * fill.qty)}</span>
              {/* The per-fill COST is not here on purpose. It is a real number
                  and it stays in the CSV and in the header's total, where it is
                  subtracted once and visibly. Repeated on thirty rows at three
                  decimals it was thirty red figures shouting about tenths of a
                  cent, and it crowded out the one column a reader comes to this
                  screen for. */}
              {/* What the SALE made. A line that says VENTA and does not say
                  whether it was a win is the one line on this screen that
                  answers nothing. A buy gets a dash: it has made nothing yet,
                  and a zero there would read as a trade that broke even. */}
              <span
                style={{
                  width: 74,
                  textAlign: 'right',
                  color: fill.realisedUsd === null ? DIM : fill.realisedUsd >= 0 ? UP : DOWN,
                }}
              >
                {fill.realisedUsd === null ? '—' : `${fill.realisedUsd >= 0 ? '+' : ''}${money(fill.realisedUsd)}`}
              </span>
            </div>
          ))
        )}
      </section>
    </>
  )
}
