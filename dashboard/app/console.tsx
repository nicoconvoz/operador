'use client'

import { useEffect, useRef, useState } from 'react'
import { Universe } from './universe.js'
import { Operations } from './operations.js'
import { Registry } from './registry.js'
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
  /**
   * When the fills behind every dollar figure were actually read, or null.
   *
   * It exists because the reading can be older than the request and the
   * difference looks like money moving. `cacheFor` is a module cache and
   * Vercel runs many instances, so a poll every ten seconds lands on different
   * ones holding answers up to two minutes apart — and a cumulative profit
   * that appears to drop is the most alarming shape a screen can take.
   *
   * Nothing in the process can close that gap; a cache in memory is not shared
   * by processes that do not share memory. Saying the age turns the flicker
   * from a fact about the MONEY into a fact about the READING.
   */
  readonly moneyReadAt?: number | null
}

// Ten seconds, not twenty. The profit figure follows the live market price
// now, so the poll rate IS how often the number can move — and a page that
// updates three times a minute does not feel like it is watching anything.
//
// Affordable because of what one poll costs: a single read of the database and
// one batched DexScreener request per chain, thirty addresses at a time,
// against a limit of three hundred a minute.
const REFRESH_MS = 10_000

/**
 * Where the viewer was, kept across a page load.
 *
 * The data refresh never reloads — that was the whole point of the poller — but
 * a page load can still happen for reasons the page does not control: Android
 * recreating the Activity, a deploy invalidating the chunk an open tab is
 * holding, the OS reclaiming a backgrounded WebView. Every one of those dropped
 * the reader back on Universo mid-read, which looks exactly like the app
 * reopening on its own.
 *
 * sessionStorage rather than localStorage: this is "where I was just now", not
 * a preference. A tab opened tomorrow should start at the sky.
 *
 * Wrapped, because a private window or blocked site data makes these THROW
 * rather than return null, and a dashboard that will not render because it
 * could not remember a tab has traded the whole page for a nicety.
 */
const TAB_KEY = 'operador:tab'
const SCROLL_KEY = 'operador:scroll'
type Tab = 'universe' | 'operations' | 'registry'

const rememberedTab = (): Tab | null => {
  try {
    const saved = sessionStorage.getItem(TAB_KEY)
    return saved === 'operations' || saved === 'universe' || saved === 'registry' ? saved : null
  } catch {
    return null
  }
}

export function Console({ initial, live = true }: { initial: ConsoleData; live?: boolean }) {
  const [tab, setTab] = useState<Tab>('universe')

  // Read AFTER mounting, never during render: the server has no sessionStorage,
  // so reading it in the initial state would render one tree on the server and
  // a different one in the browser, and React would throw out the hydration.
  useEffect(() => {
    const saved = rememberedTab()
    if (saved) setTab(saved)

    // And back to where they were reading. After the tab is restored, so the
    // page is the right height to scroll within.
    try {
      const y = Number(sessionStorage.getItem(SCROLL_KEY))
      if (Number.isFinite(y) && y > 0) requestAnimationFrame(() => window.scrollTo(0, y))
    } catch {
      // Nothing to restore. The top is a fine place to start.
    }
  }, [])

  // Written on a timer rather than on every scroll event: a phone fires
  // hundreds of those a second, and sessionStorage writes are synchronous.
  useEffect(() => {
    const remember = () => {
      try {
        sessionStorage.setItem(SCROLL_KEY, String(window.scrollY))
      } catch {
        // Per-viewer convenience. Losing it costs nothing.
      }
    }
    const timer = setInterval(remember, 1_000)
    window.addEventListener('pagehide', remember)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', remember)
    }
  }, [])

  const showTab = (next: Tab) => {
    setTab(next)
    try {
      sessionStorage.setItem(TAB_KEY, next)
    } catch {
      // Remembering is a convenience; failing to remember is not an error.
    }
  }
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

  // Which way it last moved, so the figure can be SEEN changing.
  //
  // The number now follows the live market price instead of the last closed
  // bar, so it breathes on every poll — but a digit quietly replacing another
  // digit is a change nobody notices. The tint says "that just moved, and in
  // which direction"; it fades on its own so the screen does not end up
  // permanently coloured by something that happened a minute ago.
  const [pulse, setPulse] = useState<'up' | 'down' | null>(null)
  const lastNet = useRef(netUsd)
  useEffect(() => {
    if (netUsd === lastNet.current) return
    setPulse(netUsd > lastNet.current ? 'up' : 'down')
    lastNet.current = netUsd
    const clear = setTimeout(() => setPulse(null), 900)
    return () => clearTimeout(clear)
  }, [netUsd])

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
        <div
          style={{
            fontSize: 34,
            lineHeight: 1.1,
            marginTop: 2,
            color: netUsd >= 0 ? '#63e6a5' : '#ff6b6b',
            // The SIGN keeps the colour; the pulse is a background, so a figure
            // that is negative and rising still reads as negative.
            background: pulse === null ? 'transparent' : pulse === 'up' ? 'rgba(99,230,165,0.16)' : 'rgba(255,107,107,0.16)',
            borderRadius: 6,
            padding: '0 6px',
            marginLeft: -6,
            transition: 'background 700ms ease-out',
            display: 'inline-block',
          }}
        >
          {signed(netUsd)}{' '}
          {/* The arrow is coloured by DIRECTION, the number by its SIGN — and
              they are different questions. Inheriting the number's colour put a
              GREEN ▼ on a profit that was falling, which says the opposite of
              what just happened. A figure can be positive and getting worse. */}
          {pulse !== null && (
            <span style={{ color: pulse === 'up' ? '#63e6a5' : '#ff6b6b' }}>
              {pulse === 'up' ? '▲' : '▼'}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
          <span style={{ color: realisedUsd >= 0 ? '#63e6a5' : '#ff6b6b' }}>{signed(realisedUsd)} cobrada</span>
          <span style={{ color: unrealisedUsd >= 0 ? '#63e6a5' : '#ff6b6b' }}>{signed(unrealisedUsd)} sin cobrar</span>
          {/* The minus is not decoration. Without it this term sat in a row of
              signed figures wearing no sign at all, so the row read as three
              things being added and the total looked wrong by exactly the cost
              — which is the one number a small-cap strategy dies of. A term
              that gets subtracted has to LOOK subtracted. */}
          <span style={{ color: '#8b949e' }}>−{exact(costsUsd)} a la cadena</span>
          <span style={{ color: '#8b949e' }}>
            {operations.totals.buys} compra / {operations.totals.sells} venta
          </span>
          {/* Shown only when the reading is OLD enough to explain a difference.
              A timestamp on every frame would be noise; one that appears when
              the number could disagree with itself is a diagnosis. */}
          {data.moneyReadAt != null && Date.now() - data.moneyReadAt > 20_000 && (
            <span style={{ color: '#8b949e' }} title="Las cifras salen de esta lectura. Si dos pantallas difieren, la más nueva es la buena.">
              al {new Date(data.moneyReadAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
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
        <Tab active={tab === 'universe'} onClick={() => showTab('universe')}>
          Universo <Count>{universe.tokens.length}</Count>
        </Tab>
        <Tab active={tab === 'operations'} onClick={() => showTab('operations')}>
          Operaciones {open > 0 && <Count>{open}</Count>}
        </Tab>
        <Tab active={tab === 'registry'} onClick={() => showTab('registry')}>
          Registro {operations.recentFills.length > 0 && <Count>{operations.recentFills.length}</Count>}
        </Tab>
      </nav>

      {tab === 'universe' ? (
        <Universe view={universe} />
      ) : tab === 'operations' ? (
        <Operations view={operations} />
      ) : (
        <Registry view={operations} />
      )}

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
