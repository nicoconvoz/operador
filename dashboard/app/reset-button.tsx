'use client'

import { useEffect, useState } from 'react'

/**
 * *Quiero un botón que borre y empiece de cero, con confirmación* (2026-10-11).
 *
 * Two locks before anything is sent: the control token — the same one the
 * phone's kill switch asks for, remembered on this device only — and the word
 * BORRAR typed out. What it sends is an ORDER: the engine wipes the book on its
 * next pass, a minute or two later, and the screen empties once the engine has
 * published.
 */
const TOKEN_KEY = 'operador.controlToken'
const WORD = 'BORRAR'

export function ResetButton() {
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [word, setWord] = useState('')
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    try {
      setToken(localStorage.getItem(TOKEN_KEY) ?? '')
    } catch {
      // A private window: the token is asked for every time.
    }
  }, [])

  const close = () => {
    setOpen(false)
    setWord('')
    setMessage(null)
  }

  const send = async () => {
    setSending(true)
    setMessage(null)
    try {
      const response = await fetch('/api/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token.trim()}` },
        body: JSON.stringify({ action: 'reset', confirm: word }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setMessage(`No se envió: ${body.error ?? response.status}`)
        return
      }
      try {
        localStorage.setItem(TOKEN_KEY, token.trim())
      } catch {
        // Not remembered; nothing else changes.
      }
      setWord('')
      setMessage('Orden enviada. El motor borra todo en su próxima pasada (1 o 2 minutos) y empieza de cero.')
    } catch (error) {
      setMessage(`No se envió: ${String(error)}`)
    } finally {
      setSending(false)
    }
  }

  const ready = word === WORD && token.trim().length > 0 && !sending

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ background: 'transparent', border: '1px solid #3a2a2a', color: '#ff8a8a', borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
      >
        🧹 Empezar de cero
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Borrar todo y empezar de cero"
          onClick={close}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16 }}
        >
          <div
            onClick={(event) => event.stopPropagation()}
            style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 10, padding: 18, maxWidth: 420, width: '100%' }}
          >
            <h2 style={{ fontSize: 16, margin: '0 0 8px', color: '#ff8a8a' }}>Borrar todo y empezar de cero</h2>
            <p style={{ fontSize: 13, color: '#c9d1d9', margin: '0 0 12px', lineHeight: 1.5 }}>
              Se borran todas las posiciones abiertas (sin venderlas), todas las operaciones, el registro diario y la lista negra.
              No se puede deshacer. El motor sigue funcionando y arranca de cero.
            </p>
            <label style={{ display: 'block', fontSize: 12, color: '#8b949e', marginBottom: 4 }}>Token de control</label>
            <input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 10, padding: 8, background: '#010409', border: '1px solid #30363d', borderRadius: 6, color: '#c9d1d9' }}
            />
            <label style={{ display: 'block', fontSize: 12, color: '#8b949e', marginBottom: 4 }}>Escribí {WORD} para confirmar</label>
            <input
              value={word}
              onChange={(event) => setWord(event.target.value)}
              autoComplete="off"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 12, padding: 8, background: '#010409', border: '1px solid #30363d', borderRadius: 6, color: '#c9d1d9' }}
            />
            {message && <p style={{ fontSize: 12, color: '#c9d1d9', margin: '0 0 12px' }}>{message}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={close} style={{ background: 'transparent', border: '1px solid #30363d', color: '#c9d1d9', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>
                Cancelar
              </button>
              <button
                type="button"
                disabled={!ready}
                onClick={send}
                style={{ background: ready ? '#b62324' : '#3a2a2a', border: 'none', color: '#fff', borderRadius: 6, padding: '6px 12px', cursor: ready ? 'pointer' : 'not-allowed' }}
              >
                {sending ? 'Enviando…' : 'Borrar todo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
