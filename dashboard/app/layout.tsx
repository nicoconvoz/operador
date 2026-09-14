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
      <head>
        {/* The page refreshes itself; a trading view nobody reloads is a lie. */}
        <meta httpEquiv="refresh" content="60" />
      </head>
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
