import type { ReactNode } from 'react'

export const metadata = {
  title: 'Operador by Open Doors',
  description: 'Read-only view of the trading engine',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#0b0e14',
          color: '#e6e6e6',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 16px' }}>{children}</main>
      </body>
    </html>
  )
}
