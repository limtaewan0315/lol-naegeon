'use client'

import type { Line } from '@/lib/data'
import { LINES } from '@/lib/data'
import { GameRecord, NameWithIdBadge } from '@/lib/shared'

export default function HallOfFameTab({ records, idPrefixMap, inactiveNames }: { records: GameRecord[]; idPrefixMap: Record<string, string>; inactiveNames: Set<string> }) {
  const totalGames = records.length
  const minGames = 70 // 전체 70판 이상
  const minLineGames = 30 // 라인별 30판 이상

  // 라인별 승률 집계 — 계정ID 기준 (동명이인이 안 섞임). 예전 기록에 계정ID가 없으면 이름으로 대체.
  const lineMap: Record<string, Record<string, { name: string; userId?: string; win: number; lose: number }>> = {}
  LINES.forEach(l => { lineMap[l] = {} })

  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    winners.forEach(p => {
      const key = p.userId ?? p.name
      if (!lineMap[p.line][key]) lineMap[p.line][key] = { name: p.name, userId: p.userId, win: 0, lose: 0 }
      lineMap[p.line][key].win++
    })
    losers.forEach(p => {
      const key = p.userId ?? p.name
      if (!lineMap[p.line][key]) lineMap[p.line][key] = { name: p.name, userId: p.userId, win: 0, lose: 0 }
      lineMap[p.line][key].lose++
    })
  })

  const medals = ['🥇', '🥈', '🥉']
  const medalColors = ['#FFD700', '#C0C0C0', '#CD7F32']
  const medalBg = ['rgba(255,215,0,0.07)', 'rgba(192,192,192,0.05)', 'rgba(205,127,50,0.05)']
  const medalBorder = ['rgba(255,215,0,0.25)', 'rgba(192,192,192,0.2)', 'rgba(205,127,50,0.18)']

  const getLineTop3 = (line: Line) => {
    return Object.entries(lineMap[line])
      .filter(([, s]) => s.win + s.lose >= minLineGames && !(s.userId && inactiveNames.has(s.userId)))
      .sort((a, b) => {
        const wA = a[1].win / (a[1].win + a[1].lose)
        const wB = b[1].win / (b[1].win + b[1].lose)
        return wB - wA
      })
      .slice(0, 3)
  }

  return (
    <div className="card">
      <div className="card-title">🏛 명예의 전당</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 14 }}>
        라인별 30판 이상 참여한 소환사 기준 · 승률 순위
      </div>

      {LINES.map(line => {
        const top3 = getLineTop3(line)
        return (
          <div key={line} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <span className="badge b-line">{line}</span>
            </div>
            {top3.length === 0
              ? <div style={{ fontSize: 12, color: 'var(--text3)', padding: '6px 10px' }}>집계 인원 부족</div>
              : top3.map(([key, s], i) => {
                const total = s.win + s.lose
                const wr = Math.round(s.win / total * 100)
                return (
                  <div key={key} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', borderRadius: 'var(--radius)',
                    marginBottom: 4,
                    background: medalBg[i],
                    border: `1px solid ${medalBorder[i]}`,
                  }}>
                    <span style={{ fontSize: 16, width: 22, flexShrink: 0 }}>{medals[i]}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#c8d8e8', flex: 1 }}>
                      <NameWithIdBadge name={s.name} idPrefixMap={idPrefixMap} userId={s.userId} />
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: medalColors[i] }}>{wr}%</span>
                    <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 4 }}>{s.win}승 {s.lose}패</span>
                  </div>
                )
              })
            }
          </div>
        )
      })}
    </div>
  )
}

// ── 전체 랭킹 탭 ──────────────────────────────────────────────
