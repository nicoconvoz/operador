'use client'

import { useState } from 'react'
import type { OperationsView, PositionOperations, LadderRung } from '../../src/application/operations-view.js'

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

export function Operations({ view }: { view: OperationsView }) {
  const [open, setOpen] = useState<string | null>(view.positions[0]?.id ?? null)

  if (view.positions.length === 0) {
    return (
      <section style={card()}>
        <div style={{ color: DIM }}>
          Sin posiciones abiertas. El motor está escaneando; abre una cuando un token pasa todos los filtros Y se
          disparan las condiciones de entrada de la estrategia: una caída del 10% desde el máximo reciente dentro de
          una zona lateral.
        </div>
      </section>
    )
  }

  const { totals } = view

  return (
    <>
      {/* GANANCIA first, and on its own line, because it is the question the
          whole system exists to answer. It was missing entirely: a position
          that sold everything showed nothing at all, so the only money the
          system had genuinely made appeared nowhere. */}
      <section style={{ ...card(), marginBottom: 12 }}>
        <div style={{ color: DIM, fontSize: 12 }}>ganancia — realizada + abierta − costos</div>
        <div style={{ fontSize: 30, marginTop: 2, color: totals.netUsd >= 0 ? UP : DOWN }}>{signed(totals.netUsd)}</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 10 }}>
          <Figure label="cobrada" value={signed(totals.realisedUsd)} color={totals.realisedUsd >= 0 ? UP : DOWN} />
          <Figure label="sin cobrar" value={signed(totals.unrealisedUsd)} color={totals.unrealisedUsd >= 0 ? UP : DOWN} />
          {/* Costs sit beside P&L on purpose: they are the same story, and on
              small caps they are the reason most strategies lose. */}
          <Figure label="pagado a la cadena" value={money(totals.costsUsd)} color={DIM} />
        </div>
      </section>

      <section style={{ ...card(), display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 12 }}>
        <Figure label="desplegado" value={money(totals.deployedUsd)} />
        <Figure label="valor de mercado" value={money(totals.marketValueUsd)} />
        <Figure label="ejecuciones" value={`${totals.buys} compra / ${totals.sells} venta`} color={DIM} />
      </section>

      {view.positions.map((position) => (
        <Position key={position.id} position={position} open={open === position.id} onToggle={() => setOpen(open === position.id ? null : position.id)} />
      ))}

      {view.recentFills.length > 0 && (
        <section style={{ ...card(), marginTop: 12 }}>
          <div style={{ color: DIM, fontSize: 12, marginBottom: 8 }}>cinta</div>
          {view.recentFills.map((fill) => (
            <div
              key={fill.idempotencyKey}
              style={{ display: 'flex', gap: 8, fontSize: 12, padding: '3px 0', borderBottom: '1px solid #14181f' }}
            >
              <span style={{ color: DIM, width: 34 }}>{ago(fill.time)}</span>
              <span style={{ color: fill.side === 'buy' ? UP : DOWN, width: 34 }}>{fill.side === 'buy' ? 'COMPRA' : 'VENTA'}</span>
              <span style={{ width: 70 }}>{fill.symbol}</span>
              <span style={{ color: DIM, width: 58 }}>{fill.orderId}</span>
              <span style={{ flex: 1, textAlign: 'right' }}>{price(fill.price)}</span>
              <span style={{ width: 74, textAlign: 'right' }}>{money(fill.price * fill.qty)}</span>
              <span style={{ width: 62, textAlign: 'right', color: DIM }}>−{money(fill.costUsd, 3)}</span>
            </div>
          ))}
        </section>
      )}
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
          <span style={{ color: DIM, fontSize: 12 }}>{Math.max(0, position.ladder.filter((r) => r.filled).length - 1)} DCA</span>
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

      {/* The ladder, always visible: it is the shape of the position. */}
      <Ladder rungs={position.ladder} />

      {open && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          <Line label="costo promedio" value={position.avgCostUsd === null ? '—' : price(position.avgCostUsd)} />
          <Line label="último precio" value={position.lastPriceUsd === null ? '—' : price(position.lastPriceUsd)} />
          <Line label="valor de mercado" value={position.marketValueUsd === null ? '—' : money(position.marketValueUsd)} />
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
              opacity: rung.beyondPyramiding ? 0.25 : 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              color: rung.filled ? '#e6e6e6' : DIM,
              textDecoration: rung.beyondPyramiding ? 'line-through' : 'none',
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
