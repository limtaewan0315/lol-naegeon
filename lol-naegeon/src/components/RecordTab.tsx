'use client'

import { useState } from 'react'
import type { Line } from '@/lib/data'
import { LINE_ORDER, GameRecord } from '@/lib/shared'

export default function RecordTab({ records, onDelete, onClear, isAdmin }: {
  records: GameRecord[]
  onDelete: (id: number) => void
  onClear: () => void
  isAdmin: boolean
}) {
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10
  const totalPages = Math.ceil(records.length / PAGE_SIZE)
  const pagedRecords = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const total = records.length
  const blue = records.filter(r => r.winner === 'blue').length
  const red = records.filter(r => r.winner === 'red').length

  const playerMap: Record<string, { win: number; lose: number }> = {}
  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    ;[...winners, ...losers].forEach(p => { if (!playerMap[p.name]) playerMap[p.name] = { win: 0, lose: 0 } })
    winners.forEach(p => playerMap[p.name].win++)
    losers.forEach(p => playerMap[p.name].lose++)
  })
  const topPlayer = Object.entries(playerMap)
    .filter(([, s]) => s.win + s.lose >= 30)
    .sort((a, b) => (b[1].win / (b[1].win + b[1].lose)) - (a[1].win / (a[1].win + a[1].lose)))[0] ?? null

  return (
    <div>
      <div className="card">
        <div className="stat-grid">
          <div className="stat-box"><div className="stat-label">총 경기</div><div className="stat-value">{total}</div></div>
          <div className="stat-box"><div className="stat-label">블루 승</div><div className="stat-value blue-v">{blue}</div></div>
          <div className="stat-box"><div className="stat-label">레드 승</div><div className="stat-value red-v">{red}</div></div>
          <div className="stat-box">
            <div className="stat-label">🏆 최고의 소환사</div>
            {topPlayer
              ? <>
                  <div className="stat-value" style={{ fontSize: 16, marginTop: 2 }}>{topPlayer[0]}</div>
                  <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>
                    {topPlayer[1].win}승 {topPlayer[1].lose}패 
                    <span style={{ color: 'var(--gold)', fontWeight: 600 }}>
                      {Math.round(topPlayer[1].win / (topPlayer[1].win + topPlayer[1].lose) * 100)}%
                    </span>
                  </div>
                </>
              : <div className="stat-value" style={{ fontSize: 13, color: 'var(--text3)' }}>-</div>
            }
          </div>
        </div>

        <div className="card-title">경기 기록</div>
        {records.length === 0
          ? <div className="empty">아직 기록된 경기가 없어요.</div>
          : pagedRecords.map((r, i) => {
            const sortTeam = (team: {name:string; line:Line}[]) => [...team].sort((a,b) => (LINE_ORDER[a.line]??9)-(LINE_ORDER[b.line]??9))
            const renderPlayer = (p: {name:string; line:Line}, bg: string, border: string) => (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', background: bg, border: `0.5px solid ${border}`, borderRadius: 999, fontSize: 11 }}>
                <span style={{ color: 'var(--text2)', fontSize: 10 }}>{p.line}</span>
                <span style={{ color: 'var(--text)', fontWeight: 500 }}>{p.name}</span>
              </div>
            )
            return (
            <div key={r.id} style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', marginBottom: 8, border: '0.5px solid var(--border)', overflow: 'hidden' }}>
              {/* 헤더 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '0.5px solid var(--border)' }}>
                <span style={{ fontSize: 12, color: 'var(--text3)', width: 20, flexShrink: 0 }}>{records.length - ((page-1)*PAGE_SIZE + i)}</span>
                <span className={`badge ${r.winner === 'blue' ? 'b-win' : 'b-lose'}`} style={{ fontSize: 11 }}>
                  {r.winner === 'blue' ? '🔵 블루승' : '🔴 레드승'}
                </span>

                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{r.time}</span>
                {isAdmin && <button className="btn btn-danger btn-sm" onClick={() => onDelete(r.id)}>삭제</button>}
              </div>
              {/* 블루팀 */}
              <div style={{ padding: '6px 12px', borderBottom: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 600, marginBottom: 4 }}>🔵 블루팀</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {sortTeam(r.blue).map(p => renderPlayer(p, 'var(--blue-bg)', 'var(--blue-border)'))}
                </div>
              </div>
              {/* 레드팀 */}
              <div style={{ padding: '6px 12px' }}>
                <div style={{ fontSize: 10, color: 'var(--red)', fontWeight: 600, marginBottom: 4 }}>🔴 레드팀</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {sortTeam(r.red).map(p => renderPlayer(p, 'var(--red-bg)', 'var(--red-border)'))}
                </div>
              </div>
            </div>
            )
          })
        }

        {/* 페이지네이션 */}
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
    </div>
  )
}

// ── 개인 통계 탭 ──────────────────────────────────────────────
