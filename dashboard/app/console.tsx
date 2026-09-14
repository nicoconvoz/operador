'use client'

import { useState } from 'react'
import { Universe } from './universe.js'
import { Operations } from './operations.js'
import type { UniverseView } from '../../src/application/universe-view.js'
import type { OperationsView } from '../../src/application/operations-view.js'

/**
 * Two questions, two screens.
 *
 * "What is out there" and "what are we doing about it" are different
 * questions, and a single screen answering both answers neither well. They are
 * tabs rather than sections because the universe is a running canvas: switching
 * away unmounts it, and an unmounted canvas costs a phone nothing.
 */
export function Console({ universe, operations }: { universe: UniverseView; operations: OperationsView }) {
  const [tab, setTab] = useState<'universe' | 'operations'>('universe')
  const open = operations.positions.length

  return (
    <>
      <nav style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <Tab active={tab === 'universe'} onClick={() => setTab('universe')}>
          Universo <Count>{universe.tokens.length}</Count>
        </Tab>
        <Tab active={tab === 'operations'} onClick={() => setTab('operations')}>
          Operaciones {open > 0 && <Count>{open}</Count>}
        </Tab>
      </nav>

      {tab === 'universe' ? <Universe view={universe} /> : <Operations view={operations} />}
    </>
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
