'use client'

import { useEffect, useRef, useState } from 'react'
import { Universe } from './universe.js'
import { Operations } from './operations.js'
import type { DashboardView } from '../../src/application/dashboard.js'
import type { UniverseView } from '../../src/application/universe-view.js'
import type { OperationsView } from '../../src/application/operations-view.js'

/**
 * The whole screen, and the thing that keeps it current.
 *
 * Two questions, two tabs: "what is out there" and "what are we doing about
 * it". They are tabs rather than sections because the universe is a running
 * canvas, and an unmounted canvas costs a phone nothing.
 *
 * The refresh is a FETCH, never a reload. Reloading the page wiped the canvas,
 * snapped every orbit back to its starting angle and dropped whatever the
 * viewer had selected — a flinch once a minute that communicated nothing.
 * Swapping the data underneath leaves the sky turning and the panel open.
 */

export interface ConsoleData {
  readonly dashboard: DashboardView
  readonly universe: UniverseView
  readonly operations: OperationsView
}

const REFRESH_MS = 20_000

export function Console({ initial, live = true }: { initial: ConsoleData; live?: boolean }) {
  const [tab, setTab] = useState<'universe' | 'operations'>('universe')
  const [data, setData] = useState(initial)
  /** null while everything is fine; the reason when it is not. */
  const [staleReason, setStaleReason] = useState<string | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    if (!live) return

    const pull = async () => {
      // A slow response must not stack requests on a free-tier database.
      if (inFlight.current || document.hidden) return
      inFlight.current = true
      try {
        const response = await fetch('/api/view', { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setData((await response.json()) as ConsoleData)
        setStaleReason(null)
      } catch (error) {
        // Say so. A dashboard that silently keeps showing the last good data
        // is a dashboard that reads "all healthy" during an outage.
        setStaleReason(String(error).slice(0, 120))
      } finally {
        inFlight.current = false
      }
    }

    const timer = setInterval(pull, REFRESH_MS)
    // Coming back to the tab should show the present, not what was on screen
    // when it was hidden.
    document.addEventListener('visibilitychange', pull)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', pull)
    }
  }, [live])

  const { dashboard, universe, operations } = data
  const open = operations.positions.length
  const { realisedUsd, unrealisedUsd, netUsd, costsUsd } = operations.totals

  return (
    <>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <h1 style={{ fontSize: 17, margin: 0 }}>Operador by Open Doors</h1>
        <span style={{ color: dashboard.killSwitchEngaged ? '#ff6b6b' : '#63e6a5' }}>
          {dashboard.killSwitchEngaged ? '🛑 DETENIDO' : '▶️ Funcionando'}
        </span>
      </header>

      {/* The profit, directly under the engine's state, on every tab.
          It used to live inside Operaciones, which meant the one number the
          system exists to produce was two taps away — and while the Universe
          tab was open, invisible. */}
      <section style={{ border: '1px solid #1f2630', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
        <div style={{ color: '#8b949e', fontSize: 12 }}>ganancia — cobrada + sin cobrar − costos</div>
        <div style={{ fontSize: 34, lineHeight: 1.1, marginTop: 2, color: netUsd >= 0 ? '#63e6a5' : '#ff6b6b' }}>
          {signed(netUsd)}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
          <span style={{ color: realisedUsd >= 0 ? '#63e6a5' : '#ff6b6b' }}>{signed(realisedUsd)} cobrada</span>
          <span style={{ color: unrealisedUsd >= 0 ? '#63e6a5' : '#ff6b6b' }}>{signed(unrealisedUsd)} sin cobrar</span>
          {/* Costs never get netted away in silence: on small caps the chain
              taking more than the edge is the most common way to lose. */}
          <span style={{ color: '#8b949e' }}>{exact(costsUsd)} a la cadena</span>
          <span style={{ color: '#8b949e' }}>
            {operations.totals.buys} compra / {operations.totals.sells} venta
          </span>
        </div>
      </section>

      {staleReason !== null && (
        <section style={{ border: '1px solid #ff6b6b', borderRadius: 8, padding: '8px 14px', marginBottom: 12, color: '#ff6b6b', fontSize: 13 }}>
          ⚠️ Datos congelados — no se pudo actualizar: {staleReason}
        </section>
      )}

      {dashboard.warnings.length > 0 && (
        <section style={{ border: '1px solid #ffb454', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
          {dashboard.warnings.map((warning) => (
            <div key={warning} style={{ color: '#ffb454', fontSize: 13 }}>
              ⚠️ {warning}
            </div>
          ))}
        </section>
      )}

      <section style={{ display: 'flex', gap: 22, marginBottom: 14, flexWrap: 'wrap' }}>
        <Stat label="Posiciones" value={String(dashboard.totals.positions)} />
        <Stat label="Comprometido" value={money(dashboard.totals.committedUsd)} />
        <Stat label="Universo" value={String(universe.tokens.length)} />
        <Stat label="Congeladas" value={String(dashboard.totals.frozen)} />
        <Stat label="En lista negra" value={String(dashboard.blacklistedCount)} />
      </section>

      <nav style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <Tab active={tab === 'universe'} onClick={() => setTab('universe')}>
          Universo <Count>{universe.tokens.length}</Count>
        </Tab>
        <Tab active={tab === 'operations'} onClick={() => setTab('operations')}>
          Operaciones {open > 0 && <Count>{open}</Count>}
        </Tab>
      </nav>

      {tab === 'universe' ? <Universe view={universe} /> : <Operations view={operations} />}

      <footer style={{ marginTop: 18, color: '#8b949e', fontSize: 12 }}>
        {universe.scannedAt ? `Escaneado ${ago(universe.scannedAt)}` : 'Todavía no se registró ningún escaneo'}
        {' · tamaño = liquidez · anillos = oportunidad · brillo = en posición · solo lectura'}
      </footer>
    </>
  )
}

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

/**
 * Cents, kept. The whole-dollar formatter above is right for committed capital
 * and wrong for profit: on a $15 ladder a gain of $6.02 rounds to "$6" and
 * $0.83 of chain costs round to "$0", which is the difference between a cost
 * being visible and being invisible.
 */
const exact = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${exact(n)}`

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 60) return `hace ${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `hace ${hours}h` : `hace ${Math.round(hours / 24)}d`
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ color: '#8b949e', fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 19, color }}>{value}</div>
    </div>
  )
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '7px 14px',
        borderRadius: 8,
        fontSize: 13,
        border: `1px solid ${active ? '#58a6ff' : '#21262d'}`,
        background: active ? 'rgba(88,166,255,0.12)' : 'transparent',
        color: active ? '#e6e6e6' : '#8b949e',
      }}
    >
      {children}
    </button>
  )
}

const Count = ({ children }: { children: React.ReactNode }) => (
  <span style={{ color: '#8b949e', fontSize: 11 }}>({children})</span>
)
