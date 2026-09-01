'use client'

import { useState } from 'react'
import { GameRecord, NameWithIdBadge } from '@/lib/shared'

export default function RankingTab({ records, idPrefixMap, inactiveNames }: { records: GameRecord[]; idPrefixMap: Record<string, string>; inactiveNames: Set<string> }) {
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10

  // 계정ID 기준으로 집계 (동명이인이 안 섞임). 예전 기록에 계정ID가 없으면 이름으로 대체.
  const playerMap: Record<string, { name: string; userId?: string; win: number; lose: number }> = {}
  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    ;[...winners, ...losers].forEach(p => {
      const key = p.userId ?? p.name
      if (!playerMap[key]) playerMap[key] = { name: p.name, userId: p.userId, win: 0, lose: 0 }
    })
    winners.forEach(p => { playerMap[p.userId ?? p.name].win++ })
    losers.forEach(p => { playerMap[p.userId ?? p.name].lose++ })
  })

  const entries = Object.entries(playerMap)
    .filter(([key, s]) => s.win + s.lose >= 70 && !(s.userId && inactiveNames.has(s.userId)))
    .sort((a, b) => {
      const wA = a[1].win / (a[1].win + a[1].lose)
      const wB = b[1].win / (b[1].win + b[1].lose)
      return wB - wA
    })

  const totalPages = Math.ceil(entries.length / PAGE_SIZE)
  const pagedEntries = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const medals = ['🥇', '🥈', '🥉']

  return (
    <div className="card">
      <div className="card-title">전체 랭킹</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>
        🏆 70판 이상 참가한 소환사만 집계돼요
      </div>
      {entries.length === 0
        ? <div className="empty">70판 이상 참가한 소환사가 없어요. 경기를 더 쌓아보세요!</div>
        : pagedEntries.map(([key, s], i) => {
          const globalIdx = (page - 1) * PAGE_SIZE + i
          const total = s.win + s.lose
          const wr = Math.round(s.win / total * 100)
          const medal = medals[globalIdx] ?? null
          const isTop3 = globalIdx < 3

          return (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px', marginBottom: 8,
              background: isTop3 ? (
                globalIdx === 0 ? 'rgba(255,215,0,0.07)' :
                globalIdx === 1 ? 'rgba(192,192,192,0.07)' :
                'rgba(205,127,50,0.07)'
              ) : 'var(--bg3)',
              borderRadius: 'var(--radius)',
              border: '0.5px solid ' + (isTop3 ? (
                globalIdx === 0 ? 'rgba(255,215,0,0.3)' :
                globalIdx === 1 ? 'rgba(192,192,192,0.3)' :
                'rgba(205,127,50,0.3)'
              ) : 'var(--border)'),
            }}>
              <div style={{ width: 32, textAlign: 'center', flexShrink: 0 }}>
                {medal
                  ? <span style={{ fontSize: 22 }}>{medal}</span>
                  : <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text3)' }}>{globalIdx + 1}</span>
                }
              </div>
              <span style={{ fontWeight: 700, fontSize: 14, flex: '0 0 90px' }}>
                <NameWithIdBadge name={s.name} idPrefixMap={idPrefixMap} userId={s.userId} />
              </span>
              <span className="badge b-win">{s.win}승</span>
              <span className="badge b-lose">{s.lose}패</span>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>{s.win}승 {s.lose}패</span>
              <div className="wr-bar-bg" style={{ flex: 1, marginLeft: 4 }}>
                <div className="wr-bar" style={{
                  width: `${wr}%`,
                  background: globalIdx === 0 ? '#FFD700' : globalIdx === 1 ? '#C0C0C0' : globalIdx === 2 ? '#CD7F32' : 'var(--blue)'
                }} />
              </div>
              <span style={{
                fontSize: 15, fontWeight: 700, minWidth: 40, textAlign: 'right',
                color: globalIdx === 0 ? '#FFD700' : globalIdx === 1 ? '#C0C0C0' : globalIdx === 2 ? '#CD7F32' : 'var(--text)'
              }}>{wr}%</span>
            </div>
          )
        })
      }
      {totalPages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => setPage(1)} disabled={page === 1}>{'<<'}</button>
          <button className="btn btn-sm" onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1}>{'<'}</button>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
            .reduce((acc: (number|string)[], p, idx, arr) => {
              if (idx > 0 && (p as number) - (arr[idx-1] as number) > 1) acc.push('...')
              acc.push(p)
              return acc
            }, [])
            .map((p, idx) => typeof p === 'string'
              ? <span key={idx} style={{ fontSize: 12, color: 'var(--text3)' }}>...</span>
              : <button key={idx} className="btn btn-sm" onClick={() => setPage(p as number)}
                  style={{ background: page === p ? 'var(--blue2)' : undefined, color: page === p ? '#fff' : undefined }}>
                  {p}
                </button>
            )
          }
          <button className="btn btn-sm" onClick={() => setPage(p => Math.min(totalPages, p+1))} disabled={page === totalPages}>{'>'}</button>
          <button className="btn btn-sm" onClick={() => setPage(totalPages)} disabled={page === totalPages}>{'>>'}</button>
          <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 4 }}>{page}/{totalPages}페이지</span>
        </div>
      )}
    </div>
  )
}

// ── 계정 ID 유틸 ──────────────────────────────────────────────
// 자유 아이디: 영문/숫자/언더스코어, 5~20자
