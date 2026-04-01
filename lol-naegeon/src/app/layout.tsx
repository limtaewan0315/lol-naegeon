import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '롤 내전 매니저',
  description: '티어/라인 기반 내전 팀 균형 매칭 + 전적 기록',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  )
}
