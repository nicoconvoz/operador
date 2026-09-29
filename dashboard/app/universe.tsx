'use client'

import { useMemo } from 'react'
import type { UniverseView } from '../../src/application/universe-view.js'
import { matchesToken } from '../../src/application/token-search.js'
import { marketBreadth, type MarketBreadth } from '../../src/application/market-breadth.js'

/**
 * The universe, as one study instead of a sky.
 *
 * *Se va a trabar la pantalla de tanto brillar si hay 250 tokens en el
 * universo. Anulá esa vista y en el universo poné, haciendo un estudio de todos
 * los tokens, una barra de rojo a verde.* And then, of a list proposed in its
 * place: *quitá todos los puntos, sólo dejá la barra.* The operator. The orbit
 * canvas drew every token as a glowing body sixty times a second, and a book of
 * 250 is a phone that stalls.
 *
 * So this is a title, one bar and one line of counts, and it does no work
 * between polls. The bar says which way the universe went in the LAST HOUR:
 * the dot runs right into the green as the share of risers grows and left
 * through orange into the red as the fallers take over. `marketBreadth`
 * counts it, over exactly the tokens the search lets through.
 */

const UP = '#63e6a5'
const DOWN = '#ff6b6b'
const DIM = '#8b949e'
// The Log's day bar, at full strength: red through yellow at the middle to
// green. The same palette on both bars, so "left is bad, right is good" is
// learned once.
const BAR_RED = '#ff1744'
const BAR_ORANGE = '#ff9100'
const BAR_YELLOW = '#ffea00'
const BAR_LIME = '#76ff03'
const BAR_GREEN = '#00e676'

/** A share as a percent, to one decimal only when it has one: 75%, 66.7%. */
const share = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`

/** `query` is the page's search box, shared by every tab; empty studies everything. */
export function Universe({ view, query = '' }: { view: UniverseView; query?: string }) {
  const q = query.trim()
  // Over what the search lets through: a search for one token studies that token.
  const found = useMemo(() => view.tokens.filter((t) => matchesToken(q, t)), [view.tokens, q])
  const breadth = useMemo(() => marketBreadth(found.map((t) => t.change1hPct)), [found])

  const count = found.length
  if (count === 0) {
    return (
      <section style={{ color: DIM, fontSize: 13, overflowWrap: 'anywhere' }}>
        {q !== '' ? `Ningún token coincide con «${q}».` : 'Todavía no hay tokens en el universo: aparecen con el primer escaneo.'}
      </section>
    )
  }

  const tokens = count === 1 ? 'Estudio de 1 token' : `Estudio de los ${count} tokens`
  const title = q !== '' ? `${tokens} que ${count === 1 ? 'coincide' : 'coinciden'} con «${q}»` : `${tokens} del universo`
  const moved = breadth.up + breadth.down

  return (
    <section style={{ minWidth: 0 }}>
      <div style={{ color: '#e6edf3', fontSize: 14, fontWeight: 600, marginBottom: 14, overflowWrap: 'anywhere' }}>{title}</div>
      <BreadthBar breadth={breadth} />
      <div style={{ color: DIM, fontSize: 12, marginTop: 12, lineHeight: 1.6 }}>
        Última hora: <span style={{ color: UP }}>suben {breadth.up}</span> · <span style={{ color: DOWN }}>bajan {breadth.down}</span> ·
        sin cambio {breadth.flat} · sin dato {breadth.unknown} —{' '}
        {/* With nothing moving the dot sits in the middle, and "50% suben" would
            be a claim about tokens that did not move. */}
        {moved > 0 ? `${share(breadth.upShare)} de los que se movieron suben` : 'ninguno se movió'}
      </div>
    </section>
  )
}

/**
 * Which way the hour went, as a place on a bar whose MIDDLE is even: the dot
 * runs right into the green as more of the movers rise, and left through
 * orange into the red as more of them fall. Its glow says which side holds the
 * majority, so a 52% reads as a green lean rather than as "the middle".
 */
function BreadthBar({ breadth }: { breadth: MarketBreadth }) {
  const glow = breadth.up > breadth.down ? UP : breadth.down > breadth.up ? DOWN : BAR_YELLOW
  const said =
    breadth.up + breadth.down > 0
      ? `${share(breadth.upShare)} de los tokens que se movieron en la última hora suben`
      : 'ningún token se movió en la última hora'
  return (
    // Nine pixels of room on each side, so the dot at either end stays on the screen.
    <div style={{ padding: '4px 9px' }}>
      <div
        role="img"
        aria-label={said}
        style={{
          position: 'relative',
          height: 10,
          borderRadius: 5,
          background: `linear-gradient(90deg, ${BAR_RED} 0%, ${BAR_ORANGE} 28%, ${BAR_YELLOW} 50%, ${BAR_LIME} 72%, ${BAR_GREEN} 100%)`,
        }}
      >
        <div style={{ position: 'absolute', left: 'calc(50% - 1px)', top: -4, width: 2, height: 18, borderRadius: 1, background: 'rgba(230,237,243,0.4)' }} />
        <div
          style={{
            position: 'absolute', top: -4, left: `calc(${breadth.at}% - 9px)`, width: 18, height: 18, borderRadius: '50%',
            background: '#ffffff', border: '3px solid #0d1117', boxShadow: `0 0 10px 2px ${glow}`, boxSizing: 'border-box',
          }}
        />
      </div>
    </div>
  )
}
