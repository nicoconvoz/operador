'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { UniverseToken, UniverseView, TokenTier } from '../../src/application/universe-view.js'

/**
 * The universe.
 *
 * Every mark on screen is a real measurement, not decoration:
 *
 *   ring position  ← tier: held at the centre, dead drifting at the edge
 *   size           ← liquidity (log scale, or a memecoin and a bluechip
 *                    cannot share a screen)
 *   colour         ← tier
 *   glow           ← money is in it
 *   ripples        ← opportunity score: more rings, faster, for better scores
 *   orbit speed    ← 24h volatility
 *   chain          ← Solana draws round, BSC draws as a diamond
 *
 * PERFORMANCE, because this has to run on a phone in someone's pocket:
 *
 *  - Glows are pre-rendered ONCE into sprites. A radial gradient per body per
 *    frame is the single most expensive thing a canvas can do, and it is pure
 *    waste when the image never changes.
 *  - The body count is capped by screen size. Two hundred nodes on a 380px
 *    phone is an unreadable smear that costs battery to draw.
 *  - Rendering stops when the tab is hidden. A background tab painting 60fps
 *    is a battery leak nobody ever sees.
 *  - `prefers-reduced-motion` renders one still frame. Motion is the point,
 *    but not at the cost of somebody's vestibular system.
 */

const TIER_STYLE: Record<TokenTier, { core: string; halo: string; label: string; ring: number }> = {
  held: { core: '#63e6a5', halo: '99,230,165', label: 'IN POSITION', ring: 0.2 },
  prime: { core: '#ffd166', halo: '255,209,102', label: 'PRIME', ring: 0.42 },
  eligible: { core: '#5aa9e6', halo: '90,169,230', label: 'ELIGIBLE', ring: 0.62 },
  filtered: { core: '#5c6773', halo: '92,103,115', label: 'FILTERED', ring: 0.8 },
  unsafe: { core: '#ff6b6b', halo: '255,107,107', label: 'UNSAFE', ring: 0.93 },
  dead: { core: '#3a2030', halo: '90,40,60', label: 'DEAD', ring: 1.02 },
}

const TIER_ORDER: TokenTier[] = ['held', 'prime', 'eligible', 'filtered', 'unsafe', 'dead']

interface Body {
  readonly token: UniverseToken
  readonly orbit: number
  angle: number
  readonly speed: number
  readonly radius: number
  readonly phase: number
  readonly ripples: number
  readonly strength: number
  x: number
  y: number
}

/** Stable pseudo-random from a string, so a token never jumps between renders. */
const hash = (text: string): number => {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 10000) / 10000
}

const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`

/**
 * A glow, drawn once into an offscreen canvas and reused every frame.
 * Costs one gradient at startup instead of one per body per frame.
 */
function makeGlowSprite(rgb: string, size: number): HTMLCanvasElement {
  const sprite = document.createElement('canvas')
  sprite.width = sprite.height = size * 2
  const ctx = sprite.getContext('2d')!
  const gradient = ctx.createRadialGradient(size, size, 0, size, size, size)
  gradient.addColorStop(0, `rgba(${rgb},0.55)`)
  gradient.addColorStop(0.45, `rgba(${rgb},0.16)`)
  gradient.addColorStop(1, `rgba(${rgb},0)`)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, size * 2, size * 2)
  return sprite
}

export function Universe({ view }: { view: UniverseView }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState<UniverseToken | null>(null)
  const [hovered, setHovered] = useState<UniverseToken | null>(null)
  const [chainFilter, setChainFilter] = useState<string | 'all'>('all')
  const [tierFilter, setTierFilter] = useState<TokenTier | 'all'>('all')
  const [paused, setPaused] = useState(false)
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    const check = () => setCompact(window.innerWidth < 700)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const visible = useMemo(() => {
    const filtered = view.tokens.filter(
      (t) => (chainFilter === 'all' || t.chain === chainFilter) && (tierFilter === 'all' || t.tier === tierFilter),
    )
    // Tokens arrive brightest-first, so a cap keeps what matters and drops the
    // noise a small screen could not render legibly anyway.
    return filtered.slice(0, compact ? 60 : 200)
  }, [view.tokens, chainFilter, tierFilter, compact])

  const bodies = useMemo<Body[]>(() => {
    // Random angles clump: three tokens landing within a few degrees become
    // one unreadable blob. Spacing them evenly around their own ring, with a
    // little jitter so it does not look like a clock face, keeps every body
    // reachable by a fingertip.
    const perTier = new Map<TokenTier, number>()
    for (const token of visible) perTier.set(token.tier, (perTier.get(token.tier) ?? 0) + 1)
    const seen = new Map<TokenTier, number>()

    return visible.map((token) => {
        const seed = hash(token.id)
        const style = TIER_STYLE[token.tier]
        const index = seen.get(token.tier) ?? 0
        seen.set(token.tier, index + 1)
        const slots = perTier.get(token.tier) ?? 1
        const spread = (index / slots) * Math.PI * 2 + (seed - 0.5) * (Math.PI / slots)
        // Liquidity spans six orders of magnitude; log keeps a $40k pool and a
        // $5M pool on the same screen without one becoming a dot.
        const size = Math.log10(Math.max(token.liquidityUsd, 1_000)) - 3
        const volatility = Math.abs(token.change24hPct ?? 0)
        const strength = token.tier === 'held' ? 1 : token.score / 100
        return {
          token,
          orbit: style.ring + (seed - 0.5) * 0.07,
          angle: spread,
          // Lively tokens orbit faster; held ones barely drift, so they anchor.
          speed: (token.tier === 'held' ? 0.04 : 0.11) * (0.35 + Math.min(volatility, 40) / 40) * (seed > 0.5 ? 1 : -1),
          radius: (compact ? 3 : 4) + size * (compact ? 2.4 : 3.4),
          phase: seed * Math.PI * 2,
          strength,
          ripples: token.tier === 'dead' || token.tier === 'unsafe' ? 0 : Math.floor(strength * (compact ? 2.2 : 3.4)),
          x: 0,
          y: 0,
        }
    })
  }, [visible, compact])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    // One sprite per tier, made once. Sized for the largest glow we ever draw.
    const glows = new Map(TIER_ORDER.map((tier) => [tier, makeGlowSprite(TIER_STYLE[tier].halo, 80)]))
    const frozenGlow = makeGlowSprite('120,200,255', 80)

    let raf = 0
    let t = 0
    let running = true

    const resize = () => {
      // Capped device pixel ratio: a 3x phone screen triples the fill cost for
      // a difference nobody can see on a glow.
      const dpr = Math.min(window.devicePixelRatio || 1, compact ? 1.5 : 2)
      canvas.width = Math.floor(canvas.clientWidth * dpr)
      canvas.height = Math.floor(canvas.clientHeight * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const onVisibility = () => {
      running = !document.hidden
      if (running && !still) raf = requestAnimationFrame(draw)
    }
    document.addEventListener('visibilitychange', onVisibility)

    function draw() {
      const w = canvas!.clientWidth
      const h = canvas!.clientHeight
      const cx = w / 2
      const cy = h / 2
      const unit = Math.min(w, h) / 2 - (compact ? 18 : 30)

      ctx!.fillStyle = '#070910'
      ctx!.fillRect(0, 0, w, h)

      // The sun is the engine itself. Drawn first, underneath everything, so
      // it never hides a position.
      const corePulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.03)
      const sunReach = (compact ? 30 : 40) + corePulse * 8
      ctx!.drawImage(glows.get('prime')!, cx - sunReach, cy - sunReach, sunReach * 2, sunReach * 2)

      // Faint orbit guides, so the rings read as tiers rather than as chaos.
      ctx!.strokeStyle = 'rgba(255,255,255,0.035)'
      ctx!.lineWidth = 1
      for (const tier of TIER_ORDER) {
        ctx!.beginPath()
        ctx!.arc(cx, cy, TIER_STYLE[tier].ring * unit, 0, Math.PI * 2)
        ctx!.stroke()
      }

      for (const body of bodies) {
        if (!paused && !still) body.angle += body.speed * 0.004
        const r = body.orbit * unit
        body.x = cx + Math.cos(body.angle) * r
        body.y = cy + Math.sin(body.angle) * r * 0.82 // slight tilt, so it reads as a disc

        const { token } = body
        const style = TIER_STYLE[token.tier]
        const isSelected = selected?.id === token.id
        const isHovered = hovered?.id === token.id

        // ── Ripples: how good the opportunity is, made visible ──────────────
        for (let i = 0; i < body.ripples; i++) {
          const progress = (t * (0.5 + body.strength) * 0.012 + body.phase + i / body.ripples) % 1
          ctx!.beginPath()
          ctx!.arc(body.x, body.y, body.radius + progress * (18 + body.strength * 30), 0, Math.PI * 2)
          ctx!.strokeStyle = `rgba(${style.halo},${(0.34 * (1 - progress) * body.strength).toFixed(3)})`
          ctx!.lineWidth = 1.4
          ctx!.stroke()
        }

        // ── Glow: money is in it. One blit, no gradient. ────────────────────
        if (token.tier === 'held') {
          const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.05 + body.phase)
          const reach = body.radius * (5 + pulse * 2.5)
          const sprite = token.position?.deathStage === 'frozen' ? frozenGlow : glows.get('held')!
          ctx!.drawImage(sprite, body.x - reach, body.y - reach, reach * 2, reach * 2)
        }

        if (isSelected || isHovered) {
          ctx!.beginPath()
          ctx!.arc(body.x, body.y, body.radius + 9, 0, Math.PI * 2)
          ctx!.strokeStyle = '#ffffff'
          ctx!.lineWidth = isSelected ? 2 : 1
          ctx!.stroke()
        }

        // ── The body: round for Solana, diamond for BSC ─────────────────────
        ctx!.globalAlpha = token.tier === 'dead' ? 0.5 : token.tier === 'filtered' ? 0.65 : 1
        ctx!.fillStyle = style.core
        ctx!.beginPath()
        if (token.chain === 'bsc') {
          const s = body.radius
          ctx!.moveTo(body.x, body.y - s)
          ctx!.lineTo(body.x + s, body.y)
          ctx!.lineTo(body.x, body.y + s)
          ctx!.lineTo(body.x - s, body.y)
          ctx!.closePath()
        } else {
          ctx!.arc(body.x, body.y, body.radius, 0, Math.PI * 2)
        }
        ctx!.fill()
        ctx!.globalAlpha = 1

        // Labels only where they can be read. On a phone, only what is touched.
        const labelled = isHovered || isSelected || token.tier === 'held' || (!compact && token.tier === 'prime')
        if (labelled) {
          ctx!.fillStyle = 'rgba(230,230,230,0.85)'
          ctx!.font = `${compact ? 10 : 11}px ui-monospace, monospace`
          ctx!.textAlign = 'center'
          ctx!.fillText(token.symbol.slice(0, 12), body.x, body.y + body.radius + 14)
        }
      }

      t += 1
      if (running && !still) raf = requestAnimationFrame(draw)
    }

    if (still) draw()
    else raf = requestAnimationFrame(draw)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [bodies, selected, hovered, paused, compact])

  const pickAt = (clientX: number, clientY: number, rect: DOMRect): UniverseToken | null => {
    const x = clientX - rect.left
    const y = clientY - rect.top
    let best: { body: Body; distance: number } | null = null
    for (const body of bodies) {
      const distance = Math.hypot(body.x - x, body.y - y)
      // A generous radius on touch: fingers are not mice.
      const reach = body.radius + (compact ? 22 : 10)
      if (distance < reach && (!best || distance < best.distance)) best = { body, distance }
    }
    return best?.body.token ?? null
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <Chip active={chainFilter === 'all'} onClick={() => setChainFilter('all')}>
          all
        </Chip>
        {view.chains.map((chain) => (
          <Chip key={chain} active={chainFilter === chain} onClick={() => setChainFilter(chain)}>
            {chain === 'bsc' ? '◆ bsc' : '● sol'}
          </Chip>
        ))}
        <span style={{ width: 8 }} />
        {TIER_ORDER.filter((tier) => view.counts[tier] > 0).map((tier) => (
          <Chip
            key={tier}
            active={tierFilter === tier}
            onClick={() => setTierFilter(tierFilter === tier ? 'all' : tier)}
            color={TIER_STYLE[tier].core}
          >
            {compact ? TIER_STYLE[tier].label.split(' ')[0]!.toLowerCase() : TIER_STYLE[tier].label.toLowerCase()} {view.counts[tier]}
          </Chip>
        ))}
        <span style={{ flex: 1 }} />
        <Chip active={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? '▶' : '❚❚'}
        </Chip>
      </div>

      <canvas
        ref={canvasRef}
        onMouseMove={(e) => !compact && setHovered(pickAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()))}
        onMouseLeave={() => setHovered(null)}
        onClick={(e) => setSelected(pickAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()))}
        onTouchStart={(e) => {
          const touch = e.touches[0]
          if (touch) setSelected(pickAt(touch.clientX, touch.clientY, e.currentTarget.getBoundingClientRect()))
        }}
        style={{
          width: '100%',
          // Tall enough to read on a phone, short enough that the detail panel
          // never buries the thing it is describing.
          height: compact ? '62vh' : 'min(72vh, 700px)',
          display: 'block',
          borderRadius: 12,
          background: '#070910',
          cursor: hovered ? 'pointer' : 'default',
          // The canvas is the interaction surface; let it own the gesture.
          touchAction: 'manipulation',
        }}
      />

      {selected && <Detail token={selected} compact={compact} onClose={() => setSelected(null)} />}
      {!selected && hovered && <Hint token={hovered} />}
    </div>
  )
}

function Chip({ children, active, onClick, color }: { children: React.ReactNode; active: boolean; onClick: () => void; color?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: `1px solid ${active ? color ?? '#e6e6e6' : '#21262d'}`,
        background: active ? 'rgba(255,255,255,0.08)' : 'transparent',
        color: color ?? '#e6e6e6',
        borderRadius: 999,
        padding: '6px 12px',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
        // Comfortable to tap without a magnifying glass.
        minHeight: 32,
      }}
    >
      {children}
    </button>
  )
}

function Hint({ token }: { token: UniverseToken }) {
  return (
    <div style={panel(10, false)}>
      <strong style={{ color: TIER_STYLE[token.tier].core }}>{token.symbol}</strong>{' '}
      <span style={{ color: '#8b949e' }}>
        {TIER_STYLE[token.tier].label} · {token.score.toFixed(0)} · {money(token.liquidityUsd)}
      </span>
    </div>
  )
}

function Detail({ token, compact, onClose }: { token: UniverseToken; compact: boolean; onClose: () => void }) {
  const style = TIER_STYLE[token.tier]
  return (
    <div style={{ ...panel(14, compact), maxHeight: compact ? '34vh' : 'none', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ color: style.core, fontSize: 16 }}>
          {token.chain === 'bsc' ? '◆' : '●'} {token.symbol}
        </strong>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', font: 'inherit', fontSize: 18, minWidth: 32, minHeight: 32 }}
        >
          ✕
        </button>
      </div>
      <div style={{ color: style.core, fontSize: 12, marginBottom: 10 }}>{style.label}</div>

      {token.position && (
        <div style={{ marginBottom: 10 }}>
          ${token.position.capitalUsd.toFixed(0)} · {token.position.filledDcas} DCA
          {token.position.deathStage !== 'healthy' && <span> · {token.position.deathStage === 'frozen' ? '❄️ frozen' : '☠️ dead'}</span>}
        </div>
      )}

      <Row label="score" value={token.score.toFixed(1)} />
      <Row label="liquidity" value={money(token.liquidityUsd)} />
      <Row label="24h volume" value={money(token.volume24hUsd)} />
      <Row label="24h change" value={token.change24hPct === null ? '—' : `${token.change24hPct.toFixed(1)}%`} />
      <Row label="age" value={token.ageHours === null ? '—' : `${(token.ageHours / 24).toFixed(1)}d`} />
      <Row label="round trip" value={`${token.frictionPct.toFixed(2)}%`} />

      <div style={{ marginTop: 12, marginBottom: 6, color: '#8b949e', fontSize: 12 }}>why this score</div>
      {Object.entries(token.components).map(([name, value]) => (
        <Bar key={name} label={name} value={value} color={style.core} />
      ))}

      {token.blockers.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 4 }}>blocked by</div>
          {token.blockers.map((blocker) => (
            <div key={blocker} style={{ color: '#ff6b6b', fontSize: 12 }}>
              • {blocker}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const Row = ({ label, value }: { label: string; value: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
    <span style={{ color: '#8b949e' }}>{label}</span>
    <span>{value}</span>
  </div>
)

function Bar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, marginBottom: 3 }}>
      <span style={{ color: '#8b949e', width: 104, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 5, background: '#21262d', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: '100%', background: color }} />
      </div>
    </div>
  )
}

/** On a phone the panel spans the width; on a desktop it floats in a corner. */
const panel = (padding: number, compact: boolean): React.CSSProperties => ({
  position: 'absolute',
  bottom: compact ? 8 : 16,
  left: compact ? 8 : 16,
  right: compact ? 8 : 'auto',
  maxWidth: compact ? 'none' : 420,
  background: 'rgba(10,13,20,0.94)',
  border: '1px solid #21262d',
  borderRadius: 10,
  padding,
  backdropFilter: 'blur(8px)',
})
