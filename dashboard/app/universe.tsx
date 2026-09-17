'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { UniverseToken, UniverseView, TokenTier } from '../../src/application/universe-view.js'

/**
 * The universe.
 *
 * Every mark on screen is a real measurement, not decoration:
 *
 *   colour + glow  ← tier. NOT the distance from the centre: the sky is mixed
 *                    on purpose, so a position sits among the candidates
 *                    instead of on a lane of its own
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

/**
 * `short` is a separate field, not the first word of `label`.
 *
 * Truncating at the space turned "SIN REVISAR" into "sin" and "EN POSICIÓN"
 * into "en" — chips that read as nothing at all. A shorter name is a different
 * name, not a prefix of the longer one.
 */
const TIER_STYLE: Record<TokenTier, { core: string; halo: string; label: string; short: string }> = {
  held: { core: '#63e6a5', halo: '99,230,165', label: 'EN POSICIÓN', short: 'operando' },
  prime: { core: '#ffd166', halo: '255,209,102', label: 'ÓPTIMA', short: 'óptima' },
  eligible: { core: '#5aa9e6', halo: '90,169,230', label: 'ELEGIBLE', short: 'elegible' },
  // Violet, between eligible and filtered: it is queued, not judged.
  pending: { core: '#9d7cd8', halo: '157,124,216', label: 'SIN REVISAR', short: 'pendiente' },
  filtered: { core: '#5c6773', halo: '92,103,115', label: 'FILTRADA', short: 'filtrada' },
  unsafe: { core: '#ff6b6b', halo: '255,107,107', label: 'INSEGURA', short: 'insegura' },
  dead: { core: '#3a2030', halo: '90,40,60', label: 'MUERTA', short: 'muerta' },
}

/** The score's own vocabulary, in the language the reader speaks. */
const COMPONENT_LABEL: Record<string, string> = {
  volumeExpansion: 'expansión de volumen',
  buyPressure: 'presión compradora',
  liquidityGrowth: 'crecimiento de liquidez',
  activity: 'actividad',
  volatility: 'volatilidad',
  // Not the same question as volatility, and the pair has to be readable
  // together: one says how much it MOVED, the other says which way.
  momentum: 'tendencia reciente',
  costEfficiency: 'eficiencia de costo',
}

/**
 * How many bodies the canvas will draw.
 *
 * Every body costs a glow blit and a ripple arc per frame, so this is a
 * rendering budget and not an opinion about how many tokens matter. Anything
 * past it is counted and reported rather than quietly discarded.
 */
const BODY_CAP = 400
const BODY_CAP_COMPACT = 120

const TIER_ORDER: TokenTier[] = ['held', 'prime', 'eligible', 'pending', 'filtered', 'unsafe', 'dead']

/**
 * Tiers drawn as ONE body per chain instead of one per token.
 *
 * A cycle turns up a hundred tokens nobody has examined and a few dozen that
 * failed a safety gate. Drawing each of them spends the canvas — and a
 * fingertip's worth of screen — on the two groups you will never act on, while
 * the handful that matter get the same dot each.
 *
 * Collapsed, not hidden: the cluster carries its count, and tapping it filters
 * to exactly those tokens so they expand again. Nothing becomes unreachable.
 */
const COLLAPSED_TIERS: readonly TokenTier[] = ['pending', 'unsafe', 'filtered']

interface Cluster {
  readonly tier: TokenTier
  readonly chain: string
  readonly count: number
}

interface Body {
  /** null for a cluster — the count stands in for the tokens. */
  readonly token: UniverseToken | null
  readonly cluster: Cluster | null
  /** Stable across refreshes, so the orbit is remembered. */
  readonly key: string
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
  // Selection is an ID, not the token object. The view is replaced wholesale
  // every time fresh data arrives, and a selection holding the OLD object
  // would either vanish or quietly keep showing stale numbers.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  /**
   * Where each body is on its orbit, kept across data refreshes.
   *
   * Without this every poll snaps the whole sky back to its starting angles —
   * which reads as the screen flinching once a minute for no reason a viewer
   * can connect to anything.
   */
  const anglesRef = useRef<Map<string, number>>(new Map())
  const [chainFilter, setChainFilter] = useState<string | 'all'>('all')
  /**
   * Zoom and pan, in a ref rather than in state.
   *
   * The draw loop reads them sixty times a second; putting them in state would
   * tear down and rebuild the whole animation effect on every pinch frame, and
   * the sky would stutter exactly while being looked at closely.
   */
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 })
  const [zoomLabel, setZoomLabel] = useState(1)
  const pinchRef = useRef<{ distance: number; zoom: number } | null>(null)
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: number } | null>(null)

  const MIN_ZOOM = 1
  const MAX_ZOOM = 6

  /** Zoom about a point, so what is under the finger stays under the finger. */
  const zoomTo = (next: number, aboutX?: number, aboutY?: number) => {
    const view = viewRef.current
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
    if (aboutX !== undefined && aboutY !== undefined) {
      const ratio = clamped / view.zoom
      view.panX = aboutX - (aboutX - view.panX) * ratio
      view.panY = aboutY - (aboutY - view.panY) * ratio
    }
    view.zoom = clamped
    // At rest the sky is centred; a pan that survives a zoom-out strands it.
    if (clamped === MIN_ZOOM) { view.panX = 0; view.panY = 0 }
    setZoomLabel(clamped)
  }
  const [tierFilter, setTierFilter] = useState<TokenTier | 'all'>('all')
  const [paused, setPaused] = useState(false)
  const [compact, setCompact] = useState(false)

  useEffect(() => {
    const check = () => setCompact(window.innerWidth < 700)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const matches = (t: UniverseToken) =>
    (chainFilter === 'all' || t.chain === chainFilter) && (tierFilter === 'all' || t.tier === tierFilter)

  const visible = useMemo(() => {
    const filtered = view.tokens.filter(
      // Filtering TO a collapsed tier expands it: that is the whole point of
      // the cluster being tappable.
      (t) => matches(t) && !(COLLAPSED_TIERS.includes(t.tier) && tierFilter !== t.tier),
    )
    // Tokens arrive brightest-first, so a cap keeps what matters and drops the
    // noise a small screen could not render legibly anyway. The count of what
    // it dropped is shown, because a screen that silently renders a third of
    // the universe is telling you the scanner found a third of the universe.
    return filtered.slice(0, compact ? BODY_CAP_COMPACT : BODY_CAP)
  }, [view.tokens, chainFilter, tierFilter, compact])

  const clusters = useMemo<Cluster[]>(() => {
    const counted = new Map<string, Cluster>()
    for (const token of view.tokens) {
      if (!COLLAPSED_TIERS.includes(token.tier) || tierFilter === token.tier) continue
      if (!matches(token)) continue
      const key = `${token.tier}:${token.chain}`
      const held = counted.get(key)
      counted.set(key, { tier: token.tier, chain: token.chain, count: (held?.count ?? 0) + 1 })
    }
    // Biggest first, so the ring reads left to right by weight.
    return [...counted.values()].sort((a, b) => b.count - a.count)
  }, [view.tokens, chainFilter, tierFilter])

  const matching = useMemo(() => view.tokens.filter(matches).length, [view.tokens, chainFilter, tierFilter])
  // What the CAP dropped. Clustered tokens are represented, not hidden.
  const clustered = clusters.reduce((sum, c) => sum + c.count, 0)
  const hidden = matching - visible.length - clustered

  // Resolved against the current view, so an open detail panel shows the
  // latest numbers rather than the ones that were on screen when it opened —
  // and closes by itself if the token leaves the universe.
  const selected = useMemo(() => view.tokens.find((t) => t.id === selectedId) ?? null, [view.tokens, selectedId])
  const hovered = useMemo(() => view.tokens.find((t) => t.id === hoveredId) ?? null, [view.tokens, hoveredId])
  const hoveredCluster = useMemo(
    () => (hoveredId?.startsWith('cluster:') ? clusters.find((c) => `cluster:${c.tier}:${c.chain}` === hoveredId) ?? null : null),
    [clusters, hoveredId],
  )

  const bodies = useMemo<Body[]>(() => {
    // Random angles clump: three tokens landing within a few degrees become
    // one unreadable blob. Spacing them evenly around their own ring, with a
    // little jitter so it does not look like a clock face, keeps every body
    // reachable by a fingertip.
    const seen = new Map<TokenTier, number>()

    // One at a dozen bodies, shrinking on the square root of the count beyond
    // it — area is what crowds a canvas, not radius, so the radius has to move
    // as the root. Floored, because a dot nobody can tap is not a dot.
    const crowd = Math.max(0.55, Math.sqrt(12 / Math.max(visible.length + clusters.length, 12)))

    const tokenBodies: Body[] = visible.map((token, index) => {
        const seed = hash(token.id)
        const style = TIER_STYLE[token.tier]
        seen.set(token.tier, (seen.get(token.tier) ?? 0) + 1)
        // Spread around the whole disc rather than around a tier's own ring.
        // Evenly by index so three tokens cannot land in the same few degrees
        // and become one unreadable blob, with a little jitter so it does not
        // read as a clock face.
        const spread =
          (index / Math.max(visible.length, 1)) * Math.PI * 2 + (seed - 0.5) * (Math.PI / Math.max(visible.length, 1))
        // Liquidity spans six orders of magnitude; log keeps a $40k pool and a
        // $5M pool on the same screen without one becoming a dot.
        const size = Math.log10(Math.max(token.liquidityUsd, 1_000)) - 3
        const volatility = Math.abs(token.change24hPct ?? 0)
        const strength = token.tier === 'held' ? 1 : token.score / 100
        return {
          token,
          cluster: null,
          key: token.id,
          // Radius comes from the TOKEN, not from its tier: the sky is mixed, so
          // a position sits among the candidates instead of on a lane of its
          // own. sqrt because a uniform radius clumps everything at the centre
          // — area grows with r², so the radius has to grow with its root.
          orbit: Math.sqrt(hash(`${token.id}:r`)) * 0.94 + 0.06,
          angle: anglesRef.current.get(token.id) ?? spread,
          // Lively tokens orbit faster; held ones barely drift, so they anchor.
          speed: (token.tier === 'held' ? 0.04 : 0.11) * (0.35 + Math.min(volatility, 40) / 40) * (seed > 0.5 ? 1 : -1),
          // Smaller, and smaller again as the sky fills. A two-rung ladder
          // doubles the book — twenty-nine positions on $1,500 instead of
          // fourteen — and dots sized for fourteen become one green smear at
          // twenty-nine. The crowd factor is the honest response: the
          // overlap is a function of COUNT, so the answer has to be too.
          radius: ((compact ? 2.5 : 3) + size * (compact ? 1.7 : 2.4)) * crowd,
          phase: seed * Math.PI * 2,
          strength,
          ripples: token.tier === 'dead' || token.tier === 'unsafe' ? 0 : Math.floor(strength * (compact ? 2.2 : 3.4)),
          x: 0,
          y: 0,
        }
    })

    // One body per cluster, on its tier's ring, spaced apart. Sized by count
    // on a log scale so "3 unsafe" and "300" are visibly different without the
    // large one swallowing the screen.
    const clusterBodies: Body[] = clusters.map((cluster, index) => {
      const style = TIER_STYLE[cluster.tier]
      const key = `cluster:${cluster.tier}:${cluster.chain}`
      return {
        token: null,
        cluster,
        key,
        // Kept to the outside: a cluster is a summary of things not worth
        // looking at individually, and it is big enough to hide what is.
        orbit: 0.82 + hash(key) * 0.14,
        angle: anglesRef.current.get(key) ?? (index / Math.max(clusters.length, 1)) * Math.PI * 2 + 0.6,
        speed: 0.03,
        radius: ((compact ? 7 : 9) + Math.log10(Math.max(cluster.count, 1)) * (compact ? 3 : 4.5)) * crowd,
        phase: index,
        ripples: 0,
        strength: 0.3,
        x: 0,
        y: 0,
      }
    })

    return [...tokenBodies, ...clusterBodies]
  }, [visible, clusters, compact])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    // One sprite per tier, made once. Sized for the largest glow we ever draw.
    const glows = new Map(TIER_ORDER.map((tier) => [tier, makeGlowSprite(TIER_STYLE[tier].halo, 80)]))
    const frozenGlow = makeGlowSprite('120,200,255', 80)
    // Our money, in something that just failed a safety gate. It keeps the glow
    // — there IS money in it — and loses the colour that says everything is
    // fine. Both facts at once, which is what the tier alone cannot say.
    const alarmGlow = makeGlowSprite('255,107,107', 80)

    // Four glowing positions already touch at full reach; twenty-nine are a
    // single smear. Tightened on the root of the count, for the same reason
    // the bodies are.
    const heldCount = bodies.filter((b) => (b.token?.tier ?? b.cluster?.tier) === 'held').length
    const heldSpread = Math.max(0.42, Math.sqrt(6 / Math.max(heldCount, 6)))
    // The same crowd factor the bodies were sized with, recomputed here
    // because the draw loop is a different closure from the layout memo.
    const crowd = Math.max(0.55, Math.sqrt(12 / Math.max(bodies.length, 12)))

    const angles = anglesRef.current
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
      const view = viewRef.current
      const cx = w / 2 + view.panX
      const cy = h / 2 + view.panY
      const unit = (Math.min(w, h) / 2 - (compact ? 18 : 30)) * view.zoom

      ctx!.fillStyle = '#070910'
      ctx!.fillRect(0, 0, w, h)

      // The sun is the engine itself. Drawn first, underneath everything, so
      // it never hides a position.
      const corePulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.03)
      const sunReach = (compact ? 30 : 40) + corePulse * 8
      ctx!.drawImage(glows.get('prime')!, cx - sunReach, cy - sunReach, sunReach * 2, sunReach * 2)

      // No ring guides any more. They drew the TIER lanes, and the sky is
      // mixed now: a guide under a disc nobody is sorted into would be a line
      // pretending to mean something.

      for (const body of bodies) {
        if (!paused && !still) {
          body.angle += body.speed * 0.004
          // Remembered so the next batch of data resumes the orbit instead of
          // restarting it.
          angles.set(body.key, body.angle)
        }
        // The bodies grow with the zoom, but slower than the distances do:
        // magnifying a dot to the size of a coin is not what zoom is for.
        const scale = Math.sqrt(view.zoom)
        const r = body.orbit * unit
        body.x = cx + Math.cos(body.angle) * r
        body.y = cy + Math.sin(body.angle) * r * 0.82 // slight tilt, so it reads as a disc

        const { token, cluster } = body
        const tier = token?.tier ?? cluster!.tier
        const chain = token?.chain ?? cluster!.chain
        const style = TIER_STYLE[tier]
        const drawn = body.radius * scale
        const isSelected = selectedId === body.key
        const isHovered = hoveredId === body.key

        // ── Ripples: how good the opportunity is, made visible ──────────────
        for (let i = 0; i < body.ripples; i++) {
          const progress = (t * (0.5 + body.strength) * 0.012 + body.phase + i / body.ripples) % 1
          ctx!.beginPath()
          ctx!.arc(body.x, body.y, drawn + progress * (18 + body.strength * 30) * scale, 0, Math.PI * 2)
          ctx!.strokeStyle = `rgba(${style.halo},${(0.34 * (1 - progress) * body.strength).toFixed(3)})`
          ctx!.lineWidth = 1.4
          ctx!.stroke()
        }

        // ── Glow: money is in it. One blit, no gradient. ────────────────────
        const alarmed = token?.turnedUnsafe === true
        if (tier === 'held') {
          const pulse = still ? 0.5 : 0.5 + 0.5 * Math.sin(t * (alarmed ? 0.12 : 0.05) + body.phase)
          // The halo is what floods, not the dot: at radius × 7.5 each, four
          // green positions already touch. Held tokens are drawn TIGHTER the
          // more of them there are — the alarm keeps its full reach, because
          // the one that turned must not shrink into the crowd it is in.
          const reach = drawn * (alarmed ? 5 + pulse * 4 : (5 + pulse * 2.5) * heldSpread)
          const sprite = alarmed ? alarmGlow : token?.position?.deathStage === 'frozen' ? frozenGlow : glows.get('held')!
          ctx!.drawImage(sprite, body.x - reach, body.y - reach, reach * 2, reach * 2)

          // A ring that breathes faster than anything else on the screen. The
          // engine will act on this by itself; the point of drawing it is that
          // the person watching should not find out afterwards.
          if (alarmed) {
            ctx!.beginPath()
            ctx!.arc(body.x, body.y, drawn + 6 + pulse * 7, 0, Math.PI * 2)
            ctx!.strokeStyle = `rgba(255,107,107,${(0.5 + pulse * 0.5).toFixed(2)})`
            ctx!.lineWidth = 2
            ctx!.stroke()
          }
        }

        if (isSelected || isHovered) {
          ctx!.beginPath()
          ctx!.arc(body.x, body.y, drawn + 9, 0, Math.PI * 2)
          ctx!.strokeStyle = '#ffffff'
          ctx!.lineWidth = isSelected ? 2 : 1
          ctx!.stroke()
        }

        // ── The body: round for Solana, diamond for BSC ─────────────────────
        ctx!.globalAlpha = tier === 'dead' ? 0.5 : tier === 'filtered' ? 0.65 : 1
        // Green means ours and well. Ours and NOT well is red, because that is
        // the distinction anybody glancing at this screen is actually looking
        // for, and the tier keeps saying 'held' either way.
        ctx!.fillStyle = alarmed ? TIER_STYLE.unsafe.core : style.core
        ctx!.beginPath()
        if (chain === 'bsc') {
          const s = drawn
          ctx!.moveTo(body.x, body.y - s)
          ctx!.lineTo(body.x + s, body.y)
          ctx!.lineTo(body.x, body.y + s)
          ctx!.lineTo(body.x - s, body.y)
          ctx!.closePath()
        } else {
          ctx!.arc(body.x, body.y, drawn, 0, Math.PI * 2)
        }
        ctx!.fill()
        ctx!.globalAlpha = 1

        // A cluster is ONLY useful with its number. A shape that stands for
        // ninety tokens and says nothing is just a bigger dot.
        if (cluster) {
          ctx!.textAlign = 'center'
          ctx!.fillStyle = style.core
          ctx!.font = `${compact ? 13 : 15}px ui-monospace, monospace`
          ctx!.fillText(String(cluster.count), body.x, body.y + drawn + 16)
          ctx!.fillStyle = 'rgba(200,200,210,0.7)'
          ctx!.font = `${compact ? 9 : 10}px ui-monospace, monospace`
          ctx!.fillText(
            `${chain === 'bsc' ? 'BSC' : 'SOL'} ${style.short}`,
            body.x,
            body.y + drawn + (compact ? 28 : 31),
          )
          continue
        }

        // Named: everything the executor is allowed to act on.
        //
        // The label used to be reserved for held tokens and, on a wide screen,
        // for prime — so an ÓPTIMA and an ELEGIBLE were anonymous dots, and
        // "which one is that" needed a tap. They are the shortlist; a shortlist
        // whose members have no names is a picture of a shortlist.
        //
        // The clutter that argument was protecting against is now navigable:
        // the sky zooms, and the tiers that come in dozens are collapsed into
        // clusters rather than drawn one by one.
        const NAMED: readonly TokenTier[] = ['held', 'prime', 'eligible']
        const labelled = isHovered || isSelected || alarmed || NAMED.includes(tier)
        if (labelled) {
          // Held keeps the brightest label: it is the only tier with money in
          // it, and at a glance that distinction has to survive the crowd.
          ctx!.fillStyle = alarmed ? '#ff6b6b' : tier === 'held' ? 'rgba(235,235,235,0.92)' : 'rgba(210,214,222,0.62)'
          // Thirty names at one size collide. They shrink with the crowd and
          // grow back as you zoom in, which is what the zoom is FOR — rather
          // than dropping the names, which was the request before last.
          const type = Math.max(7, (compact ? 10 : 11) * crowd * Math.min(scale, 2))
          ctx!.font = `${type}px ui-monospace, monospace`
          ctx!.textAlign = 'center'
          ctx!.fillText(token!.symbol.slice(0, 12), body.x, body.y + drawn + type + 3)
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
  }, [bodies, selectedId, hoveredId, paused, compact])

  const pickAt = (clientX: number, clientY: number, rect: DOMRect): Body | null => {
    const x = clientX - rect.left
    const y = clientY - rect.top
    let best: { body: Body; distance: number } | null = null
    for (const body of bodies) {
      const distance = Math.hypot(body.x - x, body.y - y)
      // A generous radius on touch: fingers are not mice.
      const reach = body.radius * Math.sqrt(viewRef.current.zoom) + (compact ? 22 : 10)
      if (distance < reach && (!best || distance < best.distance)) best = { body, distance }
    }
    return best?.body ?? null
  }

  /**
   * A tap on a cluster EXPANDS it — filters to exactly those tokens, which
   * makes the collapse a summary rather than a wall. A tap on a token selects
   * it as before.
   */
  const tap = (body: Body | null) => {
    if (body?.cluster) {
      setChainFilter(body.cluster.chain)
      setTierFilter(body.cluster.tier)
      setSelectedId(null)
      return
    }
    setSelectedId(body?.token?.id ?? null)
  }

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {/*
          A full reset, not just the chain.

          Tapping a cluster sets BOTH filters, so a "todas" that cleared only
          one left the view filtered while claiming to show everything — and
          the word, unqualified, promises everything. The escape hatch has to
          mean what it says or people stop trusting the other controls too.
        */}
        <Chip
          active={chainFilter === 'all' && tierFilter === 'all'}
          onClick={() => {
            setChainFilter('all')
            setTierFilter('all')
          }}
        >
          todas
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
            {TIER_STYLE[tier].short} {view.counts[tier]}
          </Chip>
        ))}
        <span style={{ flex: 1 }} />
        {hidden > 0 && (
          <span style={{ color: '#8b949e', fontSize: 11 }} title="Superan lo que el lienzo dibuja; siguen escaneados y operables.">
            +{hidden} sin dibujar
          </span>
        )}
        <Chip active={paused} onClick={() => setPaused((p) => !p)}>
          {paused ? '▶' : '❚❚'}
        </Chip>
        {/* Buttons as well as gestures. A pinch is not discoverable, and on a
            trackpad it is not available at all. */}
        <Chip active={false} onClick={() => zoomTo(viewRef.current.zoom * 1.5)}>＋</Chip>
        <Chip active={false} onClick={() => zoomTo(viewRef.current.zoom / 1.5)}>－</Chip>
        {zoomLabel > 1 && (
          <Chip active onClick={() => zoomTo(1)}>
            {zoomLabel.toFixed(1)}× ✕
          </Chip>
        )}
      </div>

      <canvas
        ref={canvasRef}
        onWheel={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          zoomTo(viewRef.current.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - rect.left, e.clientY - rect.top)
        }}
        onMouseMove={(e) => !compact && setHoveredId(pickAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect())?.key ?? null)}
        onMouseLeave={() => setHoveredId(null)}
        onClick={(e) => tap(pickAt(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect()))}
        onTouchStart={(e) => {
          if (e.touches.length === 2) {
            const [a, b] = [e.touches[0]!, e.touches[1]!]
            pinchRef.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: viewRef.current.zoom }
            dragRef.current = null
            return
          }
          const touch = e.touches[0]
          if (!touch) return
          // A drag and a tap start identically. Which one it was is decided at
          // the END, by how far the finger travelled — otherwise panning the
          // sky would open a detail sheet every time.
          dragRef.current = { x: touch.clientX, y: touch.clientY, panX: viewRef.current.panX, panY: viewRef.current.panY, moved: 0 }
        }}
        onTouchMove={(e) => {
          if (e.touches.length === 2 && pinchRef.current) {
            const [a, b] = [e.touches[0]!, e.touches[1]!]
            const rect = e.currentTarget.getBoundingClientRect()
            const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
            zoomTo(
              pinchRef.current.zoom * (distance / pinchRef.current.distance),
              (a.clientX + b.clientX) / 2 - rect.left,
              (a.clientY + b.clientY) / 2 - rect.top,
            )
            return
          }
          const touch = e.touches[0]
          const drag = dragRef.current
          if (!touch || !drag || viewRef.current.zoom <= MIN_ZOOM) return
          const dx = touch.clientX - drag.x
          const dy = touch.clientY - drag.y
          drag.moved = Math.max(drag.moved, Math.hypot(dx, dy))
          viewRef.current.panX = drag.panX + dx
          viewRef.current.panY = drag.panY + dy
        }}
        onTouchEnd={(e) => {
          pinchRef.current = null
          const drag = dragRef.current
          dragRef.current = null
          // Eight pixels of slack: a finger never holds perfectly still, and a
          // tap that needs stillness is a tap that keeps missing.
          if (!drag || drag.moved > 8) return
          tap(pickAt(drag.x, drag.y, e.currentTarget.getBoundingClientRect()))
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
          // The canvas owns every gesture: pinch to zoom, drag to pan. Letting
          // the browser keep them would scroll the page instead.
          touchAction: 'none',
        }}
      />

      {selected && <Detail token={selected} compact={compact} onClose={() => setSelectedId(null)} />}
      {!selected && hovered && <Hint token={hovered} />}
      {!selected && hoveredCluster && (
        <div style={{ ...panel(10, compact), fontSize: 12 }}>
          <b style={{ color: TIER_STYLE[hoveredCluster.tier].core }}>
            {hoveredCluster.count} {TIER_STYLE[hoveredCluster.tier].short}
          </b>{' '}
          en {hoveredCluster.chain === 'bsc' ? 'BSC' : 'Solana'} · tocá para verlas
        </div>
      )}
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

/**
 * The token's own screen, and a sheet you throw away.
 *
 * It used to be a panel under the canvas with a 34vh cap on a phone, so the
 * thing you had just tapped to read about was the thing you had to scroll
 * inside a letterbox to read. Full screen costs nothing here — the sky is not
 * being watched while a token is being read — and it buys every row at a
 * legible size.
 *
 * Dismissed by dragging DOWN, because that is the gesture the shape already
 * promises: a sheet that came up from the bottom goes back down. The ✕ stays
 * for pointers and for anyone who does not know the gesture.
 */
function Detail({ token, compact, onClose }: { token: UniverseToken; compact: boolean; onClose: () => void }) {
  const style = TIER_STYLE[token.tier]
  const [dragY, setDragY] = useState(0)
  const startRef = useRef<number | null>(null)

  // Only from the top of the sheet, and only downward: a drag that started
  // halfway down a scrolled list is someone scrolling, not someone leaving.
  const scrollRef = useRef<HTMLDivElement | null>(null)

  return (
    <div
      role="dialog"
      aria-label={token.symbol}
      onTouchStart={(e) => {
        if ((scrollRef.current?.scrollTop ?? 0) > 0) return
        startRef.current = e.touches[0]?.clientY ?? null
      }}
      onTouchMove={(e) => {
        const start = startRef.current
        const y = e.touches[0]?.clientY
        if (start === null || y === undefined) return
        setDragY(Math.max(0, y - start))
      }}
      onTouchEnd={() => {
        // A quarter of the screen. Less and a scroll that overshoots the top
        // throws the sheet away; more and the gesture stops feeling like one.
        if (dragY > window.innerHeight * 0.25) onClose()
        setDragY(0)
        startRef.current = null
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 40,
        background: '#0b0e16',
        transform: `translateY(${dragY}px)`,
        transition: dragY === 0 ? 'transform 180ms ease-out' : 'none',
        display: 'flex',
        flexDirection: 'column',
        overscrollBehavior: 'contain',
      }}
    >
      {/* The handle is the instruction. Nobody reads "swipe down to close". */}
      <div style={{ padding: '10px 0 4px', display: 'flex', justifyContent: 'center', flex: '0 0 auto' }}>
        <div style={{ width: 44, height: 5, borderRadius: 3, background: '#2a3240' }} />
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: compact ? '4px 16px 28px' : '4px 22px 28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong style={{ color: style.core, fontSize: 22 }}>
          {token.chain === 'bsc' ? '◆' : '●'} {token.symbol}
        </strong>
        <button
          onClick={onClose}
          aria-label="cerrar"
          style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer', font: 'inherit', fontSize: 22, minWidth: 44, minHeight: 44 }}
        >
          ✕
        </button>
      </div>
      <div style={{ color: token.turnedUnsafe ? '#ff6b6b' : style.core, fontSize: 12, marginBottom: 10 }}>
        {token.turnedUnsafe ? 'EN POSICIÓN · SE VOLVIÓ INSEGURA' : style.label}
      </div>

      {token.turnedUnsafe && (
        // Above everything else it knows. A position that failed a safety gate
        // is not one more fact about the token, it is the only one that matters
        // until it is resolved.
        <div style={{ border: '1px solid #ff6b6b', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
          <div style={{ color: '#ff6b6b', fontSize: 13, marginBottom: 4 }}>⚠️ Falló una compuerta de seguridad con plata adentro</div>
          <div style={{ fontSize: 12, color: '#c9d1d9' }}>
            La vigilancia de muerte ya la está evaluando y puede salir a pérdida si lo confirma — vender un activo que
            dejó de ser un activo no es un stop loss. Necesita {''}
            <b>tres observaciones consecutivas</b> antes de actuar, para que una sola lectura mala no liquide una
            posición sana.
          </div>
        </div>
      )}

      {token.position && (
        <div style={{ marginBottom: 10 }}>
          ${token.position.capitalUsd.toFixed(0)} · {token.position.filledDcas} DCA
          {token.position.deathStage !== 'healthy' && <span> · {token.position.deathStage === 'frozen' ? '❄️ congelada' : '☠️ muerta'}</span>}
          {/* WHY. A snowflake with no reason is a state nobody can act on: only
              the operator can decide whether the token really died or the
              engine is wrong about it, and the label answers neither. The
              evidence was recorded, persisted and extracted all along, and
              rendered nowhere. */}
          {token.position.deathSignals.length > 0 && (
            <div style={{ marginTop: 4, fontSize: 11, opacity: 0.75, lineHeight: 1.5 }}>
              {token.position.deathSignals.map((signal, i) => (
                <div key={i}>· {signal}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <Row label="puntaje" value={token.score.toFixed(1)} />
      <Row label="liquidez" value={money(token.liquidityUsd)} />
      <Row label="volumen 24h" value={money(token.volume24hUsd)} />
      <Row label="cambio 24h" value={token.change24hPct === null ? '—' : `${token.change24hPct.toFixed(1)}%`} />
      <Row label="antigüedad" value={token.ageHours === null ? '—' : `${(token.ageHours / 24).toFixed(1)}d`} />
      <Row label="ida y vuelta" value={`${token.frictionPct.toFixed(2)}%`} />

      <div style={{ marginTop: 12, marginBottom: 6, color: '#8b949e', fontSize: 12 }}>por qué este puntaje</div>
      {Object.entries(token.components).map(([name, value]) => (
        <Bar key={name} label={COMPONENT_LABEL[name] ?? name} value={value} color={style.core} />
      ))}

      {token.blockers.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 4 }}>bloqueada por</div>
          {token.blockers.map((blocker) => (
            <div key={blocker} style={{ color: '#ff6b6b', fontSize: 12 }}>
              • {blocker}
            </div>
          ))}
        </div>
      )}
      </div>
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
