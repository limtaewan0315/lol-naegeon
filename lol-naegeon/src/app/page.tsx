'use client'

import { useState, useEffect, useCallback } from 'react'
import { TIERS, LINES, getScore, shuffle } from '@/lib/data'
import type { Line } from '@/lib/data'
import type { Player, GameRecord, BalanceResult } from '@/lib/types'

const LINE_ORDER: Record<string, number> = { 탑: 0, 정글: 1, 미드: 2, 원딜: 3, 서포터: 4 }

// ── 팀 뽑기 탭 ──────────────────────────────────────────────
function TeamTab({
  onRecord,
}: {
  onRecord: (r: { winner: 'blue' | 'red'; blue: string[]; red: string[] }) => void
}) {
  const [players, setPlayers] = useState<Player[]>([])
  const [name, setName] = useState('')
  const [tier, setTier] = useState('골드2')
  const [line, setLine] = useState<Line>('탑')
  const [error, setError] = useState('')
  const [result, setResult] = useState<BalanceResult | null>(null)
  const [recorded, setRecorded] = useState<'blue' | 'red' | null>(null)

  const addPlayer = () => {
    const n = name.trim()
    if (!n) { setError('소환사명을 입력해주세요.'); return }
    if (players.find(p => p.name === n)) { setError('이미 추가된 소환사입니다.'); return }
    if (players.length >= 10) { setError('최대 10명까지만 추가 가능해요.'); return }
    setError('')
    setPlayers(prev => [...prev, { name: n, tier, line, score: getScore(tier, line) }])
    setName('')
  }

  const removePlayer = (n: string) => {
    setPlayers(prev => prev.filter(p => p.name !== n))
    setResult(null)
  }

  const balance = useCallback(() => {
    setError('')
    setRecorded(null)
    if (players.length !== 10) { setError(`정확히 10명이 필요해요. (현재 ${players.length}명)`); return }
    const missing = LINES.filter(l => players.filter(p => p.line === l).length < 2)
    if (missing.length) { setError(`각 라인에 최소 2명 필요해요. 부족: ${missing.join(', ')}`); return }

    let best: BalanceResult | null = null
    let bestDiff = Infinity

    for (let i = 0; i < 3000; i++) {
      const t1: Player[] = [], t2: Player[] = []
      let valid = true
      for (const l of LINES) {
        const pool = shuffle(players.filter(p => p.line === l))
        if (pool.length < 2) { valid = false; break }
        t1.push(pool[0]); t2.push(pool[1])
      }
      if (!valid) continue
      const used = new Set([...t1, ...t2])
      const rest = shuffle(players.filter(p => !used.has(p)))
      const half = Math.ceil(rest.length / 2)
      rest.slice(0, half).forEach(p => t1.push(p))
      rest.slice(half).forEach(p => t2.push(p))
      if (t1.length !== 5 || t2.length !== 5) continue
      const s1 = t1.reduce((a, p) => a + p.score, 0)
      const s2 = t2.reduce((a, p) => a + p.score, 0)
      const diff = Math.abs(s1 - s2)
      if (diff < bestDiff) { bestDiff = diff; best = { team1: [...t1], team2: [...t2], s1, s2 } }
      if (diff === 0) break
    }

    if (!best) { setError('팀 구성 실패. 참가자 구성을 확인해주세요.'); return }
    setResult(best)
  }, [players])

  const recordWin = (winner: 'blue' | 'red') => {
    if (!result) return
    onRecord({ winner, blue: result.team1.map(p => p.name), red: result.team2.map(p => p.name) })
    setRecorded(winner)
  }

  const sortByLine = (arr: Player[]) => [...arr].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))

  return (
    <div>
      <div className="card">
        <div className="card-title">참가자 추가</div>
        <div className="add-row">
          <input
            value={name} onChange={e => setName(e.target.value)}
            placeholder="소환사명"
            onKeyDown={e => e.key === 'Enter' && addPlayer()}
          />
          <select value={tier} onChange={e => setTier(e.target.value)}>
            {TIERS.map(t => <option key={t}>{t}</option>)}
          </select>
          <select value={line} onChange={e => setLine(e.target.value as Line)}>
            {LINES.map(l => <option key={l}>{l}</option>)}
          </select>
          <button className="btn" onClick={addPlayer}>추가</button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="count-bar">참가자: <span>{players.length}</span> / 10명</div>
        {players.length === 0
          ? <div className="empty">참가자를 추가해주세요</div>
          : players.map(p => (
            <div key={p.name} className="player-row">
              <span style={{ flex: 1, fontWeight: 500 }}>{p.name}</span>
              <span className="badge b-tier">{p.tier}</span>
              <span className="badge b-line">{p.line}</span>
              <span className="badge b-score">{p.score}점</span>
              <button className="btn btn-danger" onClick={() => removePlayer(p.name)}>삭제</button>
            </div>
          ))
        }
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-gold" onClick={balance}>팀 균형 맞추기</button>
          <button className="btn" onClick={() => { setPlayers([]); setResult(null); setError('') }}>초기화</button>
        </div>
      </div>

      {result && (
        <>
          <div className="teams-grid">
            {[
              { label: '🔵 블루팀', players: sortByLine(result.team1), score: result.s1, cls: 'blue' },
              { label: '🔴 레드팀', players: sortByLine(result.team2), score: result.s2, cls: 'red' },
            ].map(team => (
              <div key={team.cls} className={`team-card ${team.cls}`}>
                <div className="team-header">
                  <span style={{ fontWeight: 700 }}>{team.label}</span>
                  <span style={{ fontSize: 13, color: 'var(--text2)' }}>{team.score.toFixed(1)}점</span>
                </div>
                {team.players.map(p => (
                  <div key={p.name} className="team-player">
                    <span style={{ width: 32, fontSize: 11, fontWeight: 500, color: 'var(--text2)', flexShrink: 0 }}>{p.line}</span>
                    <span style={{ flex: 1, fontWeight: 500 }}>{p.name}</span>
                    <span className="badge b-tier" style={{ fontSize: 10 }}>{p.tier}</span>
                    <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 4 }}>{p.score}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--text2)', marginBottom: 8 }}>
            점수 차이: <strong style={{ color: 'var(--gold)' }}>{Math.abs(result.s1 - result.s2).toFixed(1)}점</strong>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 12 }}>
            <button className="btn" onClick={balance}>다시 섞기</button>
          </div>

          <div className="card" style={{ textAlign: 'center' }}>
            <div className="card-title" style={{ marginBottom: 8 }}>경기 결과 기록</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 12 }}>어느 팀이 이겼나요?</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-blue" onClick={() => recordWin('blue')} disabled={!!recorded}>🔵 블루팀 승리</button>
              <button className="btn btn-red" onClick={() => recordWin('red')} disabled={!!recorded}>🔴 레드팀 승리</button>
            </div>
            {recorded && (
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--green)' }}>
                {recorded === 'blue' ? '🔵 블루팀 승리' : '🔴 레드팀 승리'}로 기록되었어요!
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

// ── 전적 기록 탭 ──────────────────────────────────────────────
function RecordTab({ records, onDelete, onClear }: {
  records: GameRecord[]
  onDelete: (id: number) => void
  onClear: () => void
}) {
  const total = records.length
  const blue = records.filter(r => r.winner === 'blue').length
  const red = records.filter(r => r.winner === 'red').length
  const wr = total ? Math.round(blue / total * 100) : null

  return (
    <div>
      <div className="card">
        <div className="stat-grid">
          <div className="stat-box"><div className="stat-label">총 경기</div><div className="stat-value">{total}</div></div>
          <div className="stat-box"><div className="stat-label">블루 승</div><div className="stat-value blue-v">{blue}</div></div>
          <div className="stat-box"><div className="stat-label">레드 승</div><div className="stat-value red-v">{red}</div></div>
          <div className="stat-box"><div className="stat-label">블루 승률</div><div className="stat-value">{wr !== null ? `${wr}%` : '-'}</div></div>
        </div>

        <div className="card-title">경기 기록</div>
        {records.length === 0
          ? <div className="empty">아직 기록된 경기가 없어요.</div>
          : records.map((r, i) => (
            <div key={r.id} className="record-row">
              <span style={{ fontSize: 12, color: 'var(--text3)', width: 20, flexShrink: 0 }}>{records.length - i}</span>
              <span className={`badge ${r.winner === 'blue' ? 'b-win' : 'b-lose'}`} style={{ fontSize: 12 }}>
                {r.winner === 'blue' ? '🔵 블루승' : '🔴 레드승'}
              </span>
              <span style={{ flex: 1, fontSize: 11, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: 'var(--blue)' }}>{r.blue.join(', ')}</span>
                <span style={{ margin: '0 4px' }}>vs</span>
                <span style={{ color: 'var(--red)' }}>{r.red.join(', ')}</span>
              </span>
              <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>{r.time}</span>
              <button className="btn btn-danger btn-sm" onClick={() => onDelete(r.id)}>삭제</button>
            </div>
          ))
        }

        {records.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-danger" onClick={onClear}>전체 기록 삭제</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 개인 통계 탭 ──────────────────────────────────────────────
function StatsTab({ records }: { records: GameRecord[] }) {
  const playerMap: Record<string, { win: number; lose: number }> = {}
  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    ;[...winners, ...losers].forEach(n => { if (!playerMap[n]) playerMap[n] = { win: 0, lose: 0 } })
    winners.forEach(n => playerMap[n].win++)
    losers.forEach(n => playerMap[n].lose++)
  })

  const entries = Object.entries(playerMap).sort((a, b) => {
    const wA = a[1].win / (a[1].win + a[1].lose)
    const wB = b[1].win / (b[1].win + b[1].lose)
    return wB - wA
  })

  return (
    <div className="card">
      <div className="card-title">소환사별 승률</div>
      {entries.length === 0
        ? <div className="empty">경기 기록이 쌓이면 통계가 나타나요.</div>
        : entries.map(([name, s]) => {
          const total = s.win + s.lose
          const wr = Math.round(s.win / total * 100)
          return (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ flex: '0 0 90px', fontWeight: 500, fontSize: 13 }}>{name}</span>
              <span className="badge b-win">{s.win}승</span>
              <span className="badge b-lose" style={{ marginLeft: 4 }}>{s.lose}패</span>
              <div className="wr-bar-bg" style={{ marginLeft: 8 }}>
                <div className="wr-bar" style={{ width: `${wr}%` }} />
              </div>
              <span style={{ fontSize: 13, fontWeight: 500, minWidth: 36, textAlign: 'right' }}>{wr}%</span>
            </div>
          )
        })
      }
    </div>
  )
}

// ── 메인 페이지 ──────────────────────────────────────────────
export default function Home() {
  const [tab, setTab] = useState<'team' | 'record' | 'stats'>('team')
  const [records, setRecords] = useState<GameRecord[]>([])

  // localStorage에서 불러오기
  useEffect(() => {
    try {
      const saved = localStorage.getItem('lol-naegeon-records')
      if (saved) setRecords(JSON.parse(saved))
    } catch {}
  }, [])

  // localStorage에 저장
  const saveRecords = (r: GameRecord[]) => {
    setRecords(r)
    try { localStorage.setItem('lol-naegeon-records', JSON.stringify(r)) } catch {}
  }

  const addRecord = ({ winner, blue, red }: { winner: 'blue' | 'red'; blue: string[]; red: string[] }) => {
    const now = new Date()
    const time = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    saveRecords([{ id: Date.now(), winner, blue, red, time }, ...records])
  }

  const deleteRecord = (id: number) => saveRecords(records.filter(r => r.id !== id))

  const clearRecords = () => {
    if (!confirm('전체 기록을 삭제할까요?')) return
    saveRecords([])
  }

  return (
    <div className="layout">
      <div className="header">
        <div className="header-title">⚔ 내전 매니저</div>
        <div className="header-sub">티어·라인 기반 팀 균형 매칭 + 전적 기록</div>
      </div>

      <div className="tabs">
        {(['team', 'record', 'stats'] as const).map((t, i) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {['팀 뽑기', '전적 기록', '개인 통계'][i]}
          </button>
        ))}
      </div>

      {tab === 'team' && <TeamTab onRecord={addRecord} />}
      {tab === 'record' && <RecordTab records={records} onDelete={deleteRecord} onClear={clearRecords} />}
      {tab === 'stats' && <StatsTab records={records} />}
    </div>
  )
}
