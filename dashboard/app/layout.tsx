import type { ReactNode } from 'react'

export const metadata = {
  title: 'Operador by Open Doors',
  description: 'Read-only view of the trading engine',
}

/** Fit the notch, and do not let a phone zoom the canvas out of place. */
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover' as const,
  themeColor: '#070910',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      {/*
        No meta refresh.

        There used to be one here — `content="60"` — from before the page could
        update itself, with the comment "a trading view nobody reloads is a
        lie". The reasoning was right and the mechanism outlived it: the console
        has polled /api/view every twenty seconds since, swapping the data
        underneath without a reload, precisely so the canvas keeps turning and
        the reader keeps their place.

        The two then fought for months. Every sixty seconds, mid-read, the
        browser threw the whole page away and rebuilt it: back to the Universo
        tab, scrolled to the top, orbits restarted, selection gone. From the
        outside it looked exactly like the app reopening by itself, because it
        was. It happened in the Android shell and on the web alike, which is
        what finally located it — nothing in Kotlin could do that to a browser.

        A fix that survives its own replacement stops being a fix.
      */}
      <body
        style={{
          margin: 0,
          background: '#0b0e14',
          color: '#e6e6e6',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 14,
          lineHeight: 1.55,
          WebkitTextSizeAdjust: '100%',
        }}
      >
        <main
          style={{
            maxWidth: 1100,
            margin: '0 auto',
            padding: '20px max(12px, env(safe-area-inset-left)) max(20px, env(safe-area-inset-bottom))',
          }}
        >
          {children}
        </main>
      </body>
    </html>
  )
}
