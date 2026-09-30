'use client'

import { useEffect, useMemo, useState } from 'react'
import type { OperationsView, PositionOperations, LadderRung } from '../../src/application/operations-view.js'
import { sortPositions, type PositionOrder } from '../../src/application/position-order.js'
import { pageOf, type Page } from '../../src/application/pagination.js'

/**
 * The broker at work.
 *
 * The universe answers "what is out there". This answers "what did we buy,
 * what is it worth, and what did it cost" — and it is deliberately plainer.
 * A screen about money should be legible at a glance on a phone at 3am, which
 * is not the moment for an animation.
 *
 * One rule runs through it: every number is shown WITH what it cost. A P&L
 * that hides its fees is the friendliest possible lie.
 */

const money = (n: number, digits = 2) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const signed = (n: number) => `${n >= 0 ? '+' : ''}${money(n)}`
const price = (n: number) => n.toPrecision(5)
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000)
  return m < 1 ? 'ahora' : m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

const UP = '#63e6a5'
const DOWN = '#ff6b6b'
const DIM = '#8b949e'

/**
 * `positions` is what the search box lets through; `view` is still the whole
 * book, and its totals stay the whole book's. A search narrows what is LISTED,
 * never what the book is worth — a total that shrank to one token's would read
 * as money that vanished.
 */
export function Operations({
  view,
  positions: given = view.positions,
  query = '',
}: {
  view: OperationsView
  positions?: readonly PositionOperations[]
  query?: string
}) {
  // By name, nearest its take-profit, or the biggest losers first — the
  // reader's pick, name by default. See `sortPositions`.
  const [order, setOrder] = useState<PositionOrder>('alphabetical')
  const positions = useMemo(() => sortPositions(given, order), [given, order])
  const [open, setOpen] = useState<string | null>(positions[0]?.id ?? null)

  // Fifty cards at a time, never the whole book: see `pageOf`. A new search
  // starts again on page one; a poll keeps the page the reader is on.
  const [pageAt, setPageAt] = useState(0)
  const page = pageOf(positions, pageAt)

  // A new search opens the first card it found, the way the first card of the
  // whole book opens without one: the token just asked for is the one to read.
  const first = positions[0]?.id ?? null
  useEffect(() => {
    setOpen(first)
    setPageAt(0)
    // Only when the QUERY changes. A poll hands over fresh objects every ten
    // seconds, and a card the reader closed must not spring open again.
  }, [query])

  // A new order starts again at the top of page one, with nothing open.
  const pick = (to: PositionOrder) => {
    setOrder(to)
    setPageAt(0)
    setOpen(null)
  }

  // Turning the page closes the open card: nothing below the fold is rendered
  // open, and the page the reader lands on starts at its top.
  const turn = (to: number) => {
    setPageAt(to)
    setOpen(null)
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 })
  }

  if (view.positions.length === 0) {
    return (
      <section style={card()}>
        <div style={{ color: DIM }}>
          Sin posiciones abiertas. El motor está escaneando; reserva un lugar para cada token que pasa los filtros de
          seguridad mientras haya capital libre, y compra de a un paso después de cada caída seguida de un rebote.
        </div>
      </section>
    )
  }

  const { totals } = view

  return (
    <>
      {/* The profit itself lives in the header now, above the tabs, so it is
          visible from the Universe too. Repeating it here would be the same
          number twice on one screen. What belongs here is the detail behind
          it: what is committed and what it is worth right now. */}
      <section style={{ ...card(), display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
        <Figure label="desplegado" value={money(totals.deployedUsd)} />
        <Figure label="valor de mercado" value={money(totals.marketValueUsd)} />
        <Figure label="pagado a la cadena" value={money(totals.costsUsd)} color={DIM} />
        <Figure label="ejecuciones" value={`${totals.buys} compra / ${totals.sells} venta`} color={DIM} />
      </section>

      {query && (
        <div style={{ color: DIM, fontSize: 12, margin: '0 0 8px', overflowWrap: 'anywhere' }}>
          mostrando {positions.length} de {view.positions.length} posiciones · los totales son de toda la cartera
        </div>
      )}

      {query && positions.length === 0 && (
        <section style={{ ...card(), marginBottom: 8 }}>
          <div style={{ color: DIM, fontSize: 13, overflowWrap: 'anywhere' }}>
            Ninguna posición abierta coincide con «{query}».
          </div>
        </section>
      )}

      <OrderPicker order={order} onPick={pick} />

      <Pager page={page} onTurn={turn} />

      {page.items.map((position) => (
        <Position key={position.id} position={position} open={open === position.id} onToggle={() => setOpen(open === position.id ? null : position.id)} />
      ))}

      <Pager page={page} onTurn={turn} />

    </>
  )
}

function Position({ position, open, onToggle }: { position: PositionOperations; open: boolean; onToggle: () => void }) {
  const pnl = position.unrealisedUsd
  const colour = pnl === null ? DIM : pnl >= 0 ? UP : DOWN
  const stage = position.deathStage === 'frozen' ? ' ❄️' : position.deathStage === 'dead' ? ' ☠️' : ''

  return (
    <section style={{ ...card(), marginBottom: 8 }}>
      {/* Two rows, never wrapping: identity above, money below. A P&L that
          reflows onto its own line is a P&L that gets misread on a phone. */}
      <button onClick={onToggle} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 15 }}>
            {position.chain === 'bsc' ? '◆' : '●'} {position.symbol}
            {stage}
            {position.hasPendingOrders ? ' ⏳' : ''}
          </span>
          {/* The dip-bounce ladder carries its count in its own box below. */}
          {!position.steps && (
            <span style={{ color: DIM, fontSize: 12 }}>{Math.max(0, position.ladder.filter((r) => r.filled).length - 1)} DCA</span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ color: DIM }}>{open ? '▾' : '▸'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4 }}>
          <span style={{ color: DIM, fontSize: 12 }}>{money(position.deployedUsd)} dentro</span>
          {/* Banked money keeps its own slot, always. A position that closed
              flat shows "—" for the open mark, and without this its realised
              gain would have nowhere to appear. */}
          {position.realisedUsd !== 0 && (
            <span style={{ fontSize: 12, color: position.realisedUsd >= 0 ? UP : DOWN }}>
              {signed(position.realisedUsd)} cobrado
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span style={{ color: colour }}>
            {pnl === null ? '—' : signed(pnl)}
            {position.unrealisedPct !== null && (
              <span style={{ fontSize: 12 }}> ({position.unrealisedPct >= 0 ? '+' : ''}{position.unrealisedPct.toFixed(1)}%)</span>
            )}
          </span>
        </div>
      </button>

      {/* The ladder, always visible: it is the shape of the position. The
          dip-bounce ladder is ONE box with its count, never a box per step. */}
      {position.steps ? <Steps steps={position.steps} /> : <Ladder rungs={position.ladder} />}

      {/* Why the next rung is not firing. A ladder that is correctly waiting
          and a ladder that is broken looked exactly alike, which makes the
          correct one impossible to trust — so the blocking lock is always on
          screen, not buried behind a tap. */}
      {position.locks && position.locks.some((l) => !l.held) && (
        <div style={{ color: DIM, fontSize: 11, marginTop: 4 }}>
          ⏸ {position.locks.find((l) => !l.held)!.detail}
        </div>
      )}

      {/* Where the whole holding sells. Always on screen, beside what the next
          buy waits for: the two lines a position lives between. */}
      {position.takeProfit && (
        <div style={{ color: DIM, fontSize: 11, marginTop: 2 }}>
          🎯 {position.takeProfit.detail}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <Line label="costo promedio" value={position.avgCostUsd === null ? '—' : price(position.avgCostUsd)} />
          <Line label="último precio" value={position.lastPriceUsd === null ? '—' : price(position.lastPriceUsd)} />
          <Line label="valor de mercado" value={position.marketValueUsd === null ? '—' : money(position.marketValueUsd)} />
          {position.locks && (
            <div style={{ margin: '8px 0' }}>
              <div style={{ color: DIM, fontSize: 12, marginBottom: 4 }}>
                {position.locks.length === 1 ? 'qué espera el próximo peldaño' : `cerrojos del próximo peldaño — los ${position.locks.length} tienen que ceder`}
              </div>
              {position.locks.map((lock) => (
                <div key={lock.name} style={{ display: 'flex', gap: 6, fontSize: 12, padding: '2px 0' }}>
                  <span>{lock.held ? '✅' : '⏸'}</span>
                  <span style={{ color: lock.held ? UP : DIM }}>{lock.detail}</span>
                </div>
              ))}
            </div>
          )}
          <Line label="ganancia cobrada" value={signed(position.realisedUsd)} />
          <Line label="pagado a la cadena" value={money(position.costsUsd, 3)} />
          <Line label="capital asignado" value={money(position.capitalUsd, 0)} />
          <Line label="abierta hace" value={ago(position.openedAt)} />

          {position.fills.length > 0 && (
            <>
              <div style={{ color: DIM, fontSize: 12, margin: '10px 0 4px' }}>ejecuciones</div>
              {position.fills.map((fill) => (
                <div key={fill.idempotencyKey} style={{ display: 'flex', gap: 8, fontSize: 12, color: DIM }}>
                  <span style={{ width: 34 }}>{ago(fill.time)}</span>
                  <span style={{ color: fill.side === 'buy' ? UP : DOWN, width: 42 }}>
                    {fill.side === 'buy' ? 'compra' : 'venta'}
                  </span>
                  <span style={{ width: 58 }}>{fill.orderId}</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>{price(fill.price)}</span>
                  <span style={{ width: 70, textAlign: 'right' }}>{money(fill.price * fill.qty)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/**
 * The dip-bounce ladder as ONE box: the buys made, of the most it may make.
 *
 * *No vayas a poner 50 casilleros por token por los DCA, sólo dejá un
 * casillero con el número de DCA.* The operator. No row of rungs and no bar of
 * cells: a single box with the count, and under it the dollars in them. What
 * the next dollar waits for is the watch line drawn below it, in words.
 */
function Steps({ steps }: { steps: NonNullable<PositionOperations['steps']> }) {
  const full = steps.bought >= steps.max
  return (
    <div style={{ marginTop: 10 }}>
      <div
        title={`compras: ${steps.bought} de ${steps.max}`}
        style={{
          display: 'inline-block',
          padding: '3px 10px',
          borderRadius: 3,
          border: `1px solid ${steps.bought > 0 ? UP : '#21262d'}`,
          background: steps.bought > 0 ? 'rgba(99,230,165,0.18)' : 'transparent',
          color: full ? UP : '#e6e6e6',
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        DCA {steps.bought} / {steps.max}
      </div>
      <div style={{ color: DIM, fontSize: 11, marginTop: 4 }}>
        compras: {steps.bought} de {steps.max} · {money(steps.investedUsd)} invertidos
      </div>
    </div>
  )
}

/**
 * The DCA ladder as a row of rungs.
 *
 * Filled rungs are solid, the one being waited on pulses, the rest are
 * outlines — and the ones past `pyramiding` are struck through, because the
 * strategy keeps signalling levels the venue will never fill and pretending
 * otherwise would overstate how much dry powder is left.
 */
function Ladder({ rungs }: { rungs: readonly LadderRung[] }) {
  return (
    <div style={{ display: 'flex', gap: 3, marginTop: 10, alignItems: 'flex-end' }}>
      {rungs.map((rung) => {
        const title = rung.filled
          ? `N${rung.level} ejecutado a ${price(rung.fillPrice!)} · ${money(rung.fillUsd!)}`
          : rung.triggerPrice === null
            ? `N${rung.level} entrada`
            : `N${rung.level} se arma en ${price(rung.triggerPrice)} · ${money(rung.nominalUsd, 0)} nominal`
        return (
          <div
            key={rung.level}
            title={title}
            style={{
              flex: 1,
              height: 22,
              borderRadius: 3,
              border: `1px solid ${rung.filled ? UP : rung.pending ? '#ffd166' : '#21262d'}`,
              background: rung.filled ? 'rgba(99,230,165,0.35)' : rung.pending ? 'rgba(255,209,102,0.18)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              color: rung.filled ? '#e6e6e6' : DIM,
            }}
          >
            {rung.level}
          </div>
        )
      })}
    </div>
  )
}

const Figure = ({ label, value, color }: { label: string; value: string; color?: string }) => (
  <div>
    <div style={{ color: DIM, fontSize: 11 }}>{label}</div>
    <div style={{ fontSize: 17, color: color ?? '#e6e6e6' }}>{value}</div>
  </div>
)

const Line = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
    <span style={{ color: DIM }}>{label}</span>
    <span>{value}</span>
  </div>
)

const card = (): React.CSSProperties => ({
  border: '1px solid #21262d',
  borderRadius: 10,
  padding: 14,
  background: 'rgba(13,17,23,0.6)',
})

/**
 * « Anterior · página 2 de 5 (51–100 de 250) · Siguiente ». Drawn above and
 * below the cards; nothing at all when the book fits on one page. Buttons are
 * 44 px tall so a thumb finds them.
 */
/**
 * The three orders the book can be read in. *Un filtro por orden alfabético,
 * por mayor ganancia — más cerca del 12.5% — y otro para las más perdedoras.*
 */
const ORDERS: readonly { readonly order: PositionOrder; readonly label: string }[] = [
  { order: 'alphabetical', label: 'A–Z' },
  { order: 'nearestTp', label: 'Más cerca del TP' },
  { order: 'losers', label: 'Más perdedoras' },
]

function OrderPicker({ order, onPick }: { order: PositionOrder; onPick: (to: PositionOrder) => void }) {
  return (
    <div role="group" aria-label="Ordenar posiciones" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 8px' }}>
      {ORDERS.map((o) => {
        const on = o.order === order
        return (
          <button
            key={o.order}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(o.order)}
            style={{
              minHeight: 44,
              padding: '0 14px',
              borderRadius: 999,
              border: `1px solid ${on ? '#63e6a5' : '#30363d'}`,
              background: on ? 'rgba(99,230,165,0.12)' : 'rgba(22,27,34,0.9)',
              color: on ? '#63e6a5' : '#e6edf3',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Pager({ page, onTurn }: { page: Page<PositionOperations>; onTurn: (to: number) => void }) {
  if (page.pages <= 1) return null
  const button = (label: string, to: number, enabled: boolean) => (
    <button
      type="button"
      disabled={!enabled}
      onClick={() => onTurn(to)}
      style={{
        minHeight: 44,
        minWidth: 44,
        padding: '0 14px',
        borderRadius: 8,
        border: '1px solid #30363d',
        background: enabled ? 'rgba(22,27,34,0.9)' : 'transparent',
        color: enabled ? '#e6edf3' : '#484f58',
        fontSize: 14,
        cursor: enabled ? 'pointer' : 'default',
      }}
    >
      {label}
    </button>
  )
  return (
    <nav aria-label="Páginas de posiciones" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '8px 0' }}>
      {button('« Anterior', page.page - 1, page.page > 0)}
      <span style={{ color: DIM, fontSize: 12, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        página {page.page + 1} de {page.pages}
        <br />
        {page.from}–{page.to} de {page.total}
      </span>
      {button('Siguiente »', page.page + 1, page.page < page.pages - 1)}
    </nav>
  )
}
