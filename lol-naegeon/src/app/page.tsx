'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import { TIERS, LINES, getScore, shuffle } from '@/lib/data'
import type { Line } from '@/lib/data'
import type { GameRecord } from '@/lib/types'

type TeamPlayer = { name: string; tier: string; line: Line; score: number }
interface BalanceResult { team1: TeamPlayer[]; team2: TeamPlayer[]; s1: number; s2: number }

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const LINE_ORDER: Record<string, number> = { 탑: 0, 정글: 1, 미드: 2, 원딜: 3, 서포터: 4 }

// summoners 테이블: { name, line, tier } (name+line 복합키)
// SummonerMap: name -> { line -> tier }
type SummonerMap = Record<string, Record<Line, string>>

// 팀 뽑기용 플레이어 (모스트1/2 포함)
interface PlayerEntry {
  name: string
  most1: Line
  most2: Line | null
  // 매칭 결정 후 확정 라인/점수
  assignedLine?: Line
  assignedScore?: number
}

function tierUp(tier: string): string {
  const idx = TIERS.indexOf(tier)
  if (idx <= 0) return TIERS[0]
  return TIERS[idx - 1]
}
function tierDown(tier: string): string {
  const idx = TIERS.indexOf(tier)
  if (idx < 0 || idx >= TIERS.length - 1) return TIERS[TIERS.length - 1]
  return TIERS[idx + 1]
}

// ── 소환사 관리 탭 ──────────────────────────────────────────────
function SummonerTab({ summoners, onRefresh }: { summoners: SummonerMap; onRefresh: () => void }) {
  const [name, setName] = useState('')
  const [tier, setTier] = useState('골드2')
  const [line, setLine] = useState<Line>('탑')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ name: string; line: Line } | null>(null)
  const [editTier, setEditTier] = useState('')

  // 등록: name+line 복합키로 upsert
  const add = async () => {
    const n = name.trim()
    if (!n) { setError('소환사명을 입력해주세요.'); return }
    setError('')
    await supabase.from('summoners').upsert({ name: n, line, tier }, { onConflict: 'name,line' })
    setName('')
    onRefresh()
  }

  const remove = async (n: string, l: Line) => {
    await supabase.from('summoners').delete().eq('name', n).eq('line', l)
    onRefresh()
  }

  const startEdit = (n: string, l: Line) => {
    setEditing({ name: n, line: l })
    setEditTier(summoners[n][l])
  }

  const saveEdit = async () => {
    if (!editing) return
    await supabase.from('summoners').update({ tier: editTier }).eq('name', editing.name).eq('line', editing.line)
    setEditing(null)
    onRefresh()
  }

  // 소환사 전체 삭제
  const removeSummoner = async (n: string) => {
    await supabase.from('summoners').delete().eq('name', n)
    onRefresh()
  }

  const summonerNames = Object.keys(summoners).sort()

  return (
    <div>
      <div className="card">
        <div className="card-title">소환사 라인 등록</div>
        <div className="add-row">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="소환사명" onKeyDown={e => e.key === 'Enter' && add()} />
          <select value={line} onChange={e => setLine(e.target.value as Line)}>
            {LINES.map(l => <option key={l}>{l}</option>)}
          </select>
          <select value={tier} onChange={e => setTier(e.target.value)}>
            {TIERS.map(t => <option key={t}>{t}</option>)}
          </select>
          <button className="btn btn-gold" onClick={add}>등록</button>
        </div>
        {error && <div className="error">{error}</div>}
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>
          💡 같은 소환사명으로 라인별로 여러 번 등록할 수 있어요
        </div>
      </div>

      <div className="card">
        <div className="card-title">등록된 소환사 ({summonerNames.length}명)</div>
        {summonerNames.length === 0
          ? <div className="empty">등록된 소환사가 없어요.</div>
          : summonerNames.map(n => {
            const lines = summoners[n]
            const sortedLines = (Object.keys(lines) as Line[]).sort((a, b) => LINE_ORDER[a] - LINE_ORDER[b])
            return (
              <div key={n} style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{n}</span>
                  <button className="btn btn-danger btn-sm" onClick={() => removeSummoner(n)}>전체삭제</button>
                </div>
                {sortedLines.map(l => (
                  <div key={l} className="player-row" style={{ marginBottom: 4, padding: '6px 10px' }}>
                    <span className="badge b-line" style={{ width: 52, textAlign: 'center' }}>{l}</span>
                    {editing?.name === n && editing?.line === l ? (
                      <>
                        <select value={editTier} onChange={e => setEditTier(e.target.value)} style={{ flex: 1 }}>
                          {TIERS.map(t => <option key={t}>{t}</option>)}
                        </select>
                        <button className="btn btn-gold btn-sm" onClick={saveEdit}>저장</button>
                        <button className="btn btn-sm" onClick={() => setEditing(null)}>취소</button>
                      </>
                    ) : (
                      <>
                        <span className="badge b-tier" style={{ flex: 1 }}>{lines[l]}</span>
                        <button className="btn btn-sm" onClick={() => startEdit(n, l)}>수정</button>
                        <button className="btn btn-danger btn-sm" onClick={() => remove(n, l)}>삭제</button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )
          })
        }
      </div>
    </div>
  )
}

// ── 팀 뽑기 탭 ──────────────────────────────────────────────
function TeamTab({
  onRecord,
  summoners,
  players, setPlayers,
  result, setResult,
  records,
}: {
  onRecord: (r: { winner: 'blue' | 'red'; blue: string[]; red: string[]; skipInsert?: boolean }) => void
  summoners: SummonerMap
  players: PlayerEntry[]
  setPlayers: React.Dispatch<React.SetStateAction<PlayerEntry[]>>
  result: BalanceResult | null
  setResult: React.Dispatch<React.SetStateAction<BalanceResult | null>>
  records: GameRecord[]
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [recorded, setRecorded] = useState<'blue' | 'red' | null>(null)

  // 소환사의 등록된 라인 목록 (LINE_ORDER 순)
  const getSummonerLines = (n: string): Line[] => {
    if (!summoners[n]) return []
    return (Object.keys(summoners[n]) as Line[]).sort((a, b) => LINE_ORDER[a] - LINE_ORDER[b])
  }

  const handleNameChange = (val: string) => {
    setName(val)
    if (val.trim()) {
      const matched = Object.keys(summoners).filter(n => n.includes(val.trim()))
      setSuggestions(matched.slice(0, 5))
    } else {
      setSuggestions([])
    }
  }

  const addPlayer = (selectedName?: string) => {
    const n = (selectedName ?? name).trim()
    if (!n) { setError('소환사명을 입력해주세요.'); return }
    if (players.find(p => p.name === n)) { setError('이미 추가된 소환사입니다.'); return }
    if (players.length >= 10) { setError('최대 10명까지만 추가 가능해요.'); return }
    const lines = getSummonerLines(n)
    if (lines.length === 0) { setError('등록된 라인 정보가 없는 소환사입니다.'); return }
    setError('')
    setSuggestions([])
    setName('')
    // 모스트1 = 가장 많이 한 라인 (등록 순서 = LINE_ORDER), 모스트2 = 두 번째
    setPlayers(prev => [...prev, {
      name: n,
      most1: lines[0],
      most2: lines.length >= 2 ? lines[1] : null,
    }])
    setResult(null)
  }

  const removePlayer = (n: string) => {
    setPlayers(prev => prev.filter(p => p.name !== n))
    setResult(null)
  }

  const updateMost = (name: string, field: 'most1' | 'most2', value: Line | '') => {
    setPlayers(prev => prev.map(p => {
      if (p.name !== name) return p
      return { ...p, [field]: value === '' ? null : value }
    }))
    setResult(null)
  }

  // 팀 균형 맞추기: 각 플레이어마다 most1/most2 중 랜덤 라인 선택 후 밸런싱
  const balance = useCallback(() => {
    setError('')
    setRecorded(null)
    if (players.length !== 10) { setError(`정확히 10명이 필요해요. (현재 ${players.length}명)`); return }

    // 각 플레이어의 가능한 라인 목록 생성
    const getOptions = (p: PlayerEntry): Line[] => {
      const opts: Line[] = [p.most1]
      if (p.most2) opts.push(p.most2)
      return opts
    }

    let best: BalanceResult | null = null
    let bestDiff = Infinity

    for (let i = 0; i < 5000; i++) {
      // 1) 각 플레이어 랜덤 라인 배정
      const assigned = players.map(p => {
        const opts = getOptions(p)
        const line = opts[Math.floor(Math.random() * opts.length)]
        const tier = summoners[p.name]?.[line] ?? '골드2'
        return { name: p.name, line, score: getScore(tier, line) }
      })

      // 2) 각 라인에 최소 2명이 있는지 체크
      const lineCounts: Record<string, number> = {}
      assigned.forEach(p => { lineCounts[p.line] = (lineCounts[p.line] ?? 0) + 1 })
      const valid = LINES.every(l => (lineCounts[l] ?? 0) >= 2)
      if (!valid) continue

      // 3) 라인별로 1명씩 각 팀에 배정
      const t1: typeof assigned = [], t2: typeof assigned = []
      let ok = true
      for (const l of LINES) {
        const pool = shuffle(assigned.filter(p => p.line === l))
        if (pool.length < 2) { ok = false; break }
        t1.push(pool[0]); t2.push(pool[1])
      }
      if (!ok) continue

      // 4) 남는 플레이어 배분
      const used = new Set([...t1, ...t2])
      const rest = shuffle(assigned.filter(p => !used.has(p)))
      const half = Math.ceil(rest.length / 2)
      rest.slice(0, half).forEach(p => t1.push(p))
      rest.slice(half).forEach(p => t2.push(p))
      if (t1.length !== 5 || t2.length !== 5) continue

      const s1 = t1.reduce((a, p) => a + p.score, 0)
      const s2 = t2.reduce((a, p) => a + p.score, 0)
      const diff = Math.abs(s1 - s2)
      if (diff < bestDiff) {
        bestDiff = diff
        best = {
          team1: t1.map(p => ({ name: p.name, tier: summoners[p.name]?.[p.line] ?? '골드2', line: p.line, score: p.score })),
          team2: t2.map(p => ({ name: p.name, tier: summoners[p.name]?.[p.line] ?? '골드2', line: p.line, score: p.score })),
          s1, s2,
        }
      }
      if (diff === 0) break
    }

    if (!best) { setError('팀 구성 실패. 라인 다양성이 부족해요. 모스트 라인을 다양하게 설정해보세요.'); return }
    setResult(best)
  }, [players, summoners])

  // 실버3 이하 여부 체크
  const isSilver3OrBelow = (tier: string) => {
    const silver3Idx = TIERS.indexOf('실버3 이하')
    const tierIdx = TIERS.indexOf(tier)
    return tierIdx >= silver3Idx
  }

  // 특정 플레이어의 최근 N판 승률 계산 (N판 미만이면 null 반환)
  const getRecentWinRate = (playerName: string, currentRecords: GameRecord[], n = 5): number | null => {
    const playerRecords = currentRecords.filter(r => r.blue.includes(playerName) || r.red.includes(playerName))
    const recent = playerRecords.slice(0, n)
    if (recent.length < n) return null  // 최소 n판 미만이면 승급 불가
    const wins = recent.filter(r => {
      const isBlue = r.blue.includes(playerName)
      return (isBlue && r.winner === 'blue') || (!isBlue && r.winner === 'red')
    }).length
    return wins / recent.length
  }

  const recordWin = async (winner: 'blue' | 'red') => {
    if (!result) return
    const winners = winner === 'blue' ? result.team1 : result.team2
    const losers = winner === 'blue' ? result.team2 : result.team1

    // 현재 기록 먼저 저장 (승률 계산에 이번 판 포함)
    const now = new Date()
    const time = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const { data: newRecord } = await supabase
      .from('records')
      .insert([{ winner, blue: result.team1.map(p => p.name), red: result.team2.map(p => p.name), time }])
      .select()

    // 이번 판 포함한 최신 records로 승률 계산
    const updatedRecords = newRecord ? [newRecord[0], ...records] : records

    for (const p of winners) {
      if (summoners[p.name]?.[p.line]) {
        const currentTier = summoners[p.name][p.line]
        if (isSilver3OrBelow(currentTier)) {
          // 실버3 이하: 최근 5판 승률 50% 이상일 때만 티어 UP
          const wr = getRecentWinRate(p.name, updatedRecords, 5)
          if (wr !== null && wr >= 0.5) {
            const newTier = tierUp(currentTier)
            await supabase.from('summoners').update({ tier: newTier }).eq('name', p.name).eq('line', p.line)
          }
        } else {
          const newTier = tierUp(currentTier)
          await supabase.from('summoners').update({ tier: newTier }).eq('name', p.name).eq('line', p.line)
        }
      }
    }
    for (const p of losers) {
      if (summoners[p.name]?.[p.line]) {
        const newTier = tierDown(summoners[p.name][p.line])
        await supabase.from('summoners').update({ tier: newTier }).eq('name', p.name).eq('line', p.line)
      }
    }

    onRecord({ winner, blue: result.team1.map(p => p.name), red: result.team2.map(p => p.name), skipInsert: true })
    setRecorded(winner)
  }

  const sortByLine = (arr: TeamPlayer[]) => [...arr].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))

  return (
    <div>
      <div className="card">
        <div className="card-title">참가자 추가</div>
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={name}
              onChange={e => handleNameChange(e.target.value)}
              placeholder="소환사명 검색"
              onKeyDown={e => e.key === 'Enter' && addPlayer()}
              autoComplete="off"
              style={{ flex: 1 }}
            />
            <button className="btn" onClick={() => addPlayer()}>추가</button>
          </div>
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
              background: 'var(--bg3)', border: '0.5px solid var(--border2)',
              borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden'
            }}>
              {suggestions.map(s => {
                const lines = getSummonerLines(s)
                return (
                  <div key={s} onClick={() => addPlayer(s)} style={{
                    padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                    display: 'flex', alignItems: 'center', gap: 8
                  }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{ flex: 1, fontWeight: 500 }}>{s}</span>
                    <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                      {lines.map(l => `${l} ${summoners[s][l]}`).join(' / ')}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="count-bar">참가자: <span>{players.length}</span> / 10명</div>

        {players.length === 0
          ? <div className="empty">소환사명을 검색해서 추가해주세요</div>
          : players.map(p => {
            const lines = getSummonerLines(p.name)
            return (
              <div key={p.name} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 12px', background: 'var(--bg3)',
                borderRadius: 'var(--radius)', marginBottom: 6,
                border: '0.5px solid var(--border)', flexWrap: 'wrap'
              }}>
                <span style={{ fontWeight: 600, fontSize: 13, minWidth: 80 }}>{p.name}</span>

                {/* 모스트1 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--gold)', fontWeight: 600 }}>M1</span>
                  <select
                    value={p.most1}
                    onChange={e => updateMost(p.name, 'most1', e.target.value as Line)}
                    style={{ width: 80, padding: '4px 8px', fontSize: 12 }}
                  >
                    {lines.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  <span className="badge b-tier" style={{ fontSize: 10 }}>{summoners[p.name]?.[p.most1] ?? '-'}</span>
                </div>

                {/* 모스트2 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>M2</span>
                  <select
                    value={p.most2 ?? ''}
                    onChange={e => updateMost(p.name, 'most2', e.target.value as Line | '')}
                    style={{ width: 80, padding: '4px 8px', fontSize: 12 }}
                  >
                    <option value=''>없음</option>
                    {lines.filter(l => l !== p.most1).map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  {p.most2 && <span className="badge b-tier" style={{ fontSize: 10 }}>{summoners[p.name]?.[p.most2] ?? '-'}</span>}
                </div>

                <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={() => removePlayer(p.name)}>삭제</button>
              </div>
            )
          })
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
                    <span style={{ width: 36, fontSize: 11, fontWeight: 500, color: 'var(--text2)', flexShrink: 0 }}>{p.line}</span>
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
            <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>어느 팀이 이겼나요?</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>🏆 이긴 팀은 해당 라인 티어 UP, 진 팀은 티어 DOWN</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn btn-blue" onClick={() => recordWin('blue')} disabled={!!recorded}>🔵 블루팀 승리</button>
              <button className="btn btn-red" onClick={() => recordWin('red')} disabled={!!recorded}>🔴 레드팀 승리</button>
            </div>
            {recorded && (
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--green)' }}>
                {recorded === 'blue' ? '🔵 블루팀 승리' : '🔴 레드팀 승리'}로 기록되었어요! 티어가 자동으로 업데이트됐어요 🎉
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

  const playerMap: Record<string, { win: number; lose: number }> = {}
  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    ;[...winners, ...losers].forEach(n => { if (!playerMap[n]) playerMap[n] = { win: 0, lose: 0 } })
    winners.forEach(n => playerMap[n].win++)
    losers.forEach(n => playerMap[n].lose++)
  })
  const topPlayer = Object.entries(playerMap)
    .filter(([, s]) => s.win + s.lose >= 10)
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
function StatsTab({ records, summoners }: { records: GameRecord[]; summoners: SummonerMap }) {
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
          const lines = summoners[name] ? (Object.keys(summoners[name]) as Line[]).sort((a, b) => LINE_ORDER[a] - LINE_ORDER[b]) : []
          return (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '0.5px solid var(--border)' }}>
              <span style={{ flex: '0 0 80px', fontWeight: 500, fontSize: 13 }}>{name}</span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
                {lines.map(l => (
                  <span key={l} className="badge b-line" style={{ fontSize: 10 }}>{l} {summoners[name][l]}</span>
                ))}
              </div>
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


// ── 전체 랭킹 탭 ──────────────────────────────────────────────
function RankingTab({ records }: { records: GameRecord[] }) {
  const playerMap: Record<string, { win: number; lose: number }> = {}
  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    ;[...winners, ...losers].forEach(n => { if (!playerMap[n]) playerMap[n] = { win: 0, lose: 0 } })
    winners.forEach(n => playerMap[n].win++)
    losers.forEach(n => playerMap[n].lose++)
  })

  // 10판 이상인 소환사만, 승률 내림차순 정렬
  const entries = Object.entries(playerMap)
    .filter(([, s]) => s.win + s.lose >= 10)
    .sort((a, b) => {
      const wA = a[1].win / (a[1].win + a[1].lose)
      const wB = b[1].win / (b[1].win + b[1].lose)
      return wB - wA
    })

  const medals = ['🥇', '🥈', '🥉']

  return (
    <div className="card">
      <div className="card-title">전체 랭킹</div>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>
        🏆 10판 이상 참가한 소환사만 집계돼요
      </div>
      {entries.length === 0
        ? <div className="empty">10판 이상 참가한 소환사가 없어요. 경기를 더 쌓아보세요!</div>
        : entries.map(([name, s], i) => {
          const total = s.win + s.lose
          const wr = Math.round(s.win / total * 100)
          const medal = medals[i] ?? null
          const isTop3 = i < 3

          return (
            <div key={name} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px', marginBottom: 8,
              background: isTop3 ? (
                i === 0 ? 'rgba(255,215,0,0.07)' :
                i === 1 ? 'rgba(192,192,192,0.07)' :
                'rgba(205,127,50,0.07)'
              ) : 'var(--bg3)',
              borderRadius: 'var(--radius)',
              border: '0.5px solid ' + (isTop3 ? (
                i === 0 ? 'rgba(255,215,0,0.3)' :
                i === 1 ? 'rgba(192,192,192,0.3)' :
                'rgba(205,127,50,0.3)'
              ) : 'var(--border)'),
            }}>
              {/* 순위 */}
              <div style={{ width: 32, textAlign: 'center', flexShrink: 0 }}>
                {medal
                  ? <span style={{ fontSize: 22 }}>{medal}</span>
                  : <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text3)' }}>{i + 1}</span>
                }
              </div>

              {/* 소환사명 */}
              <span style={{ fontWeight: 700, fontSize: 14, flex: '0 0 90px' }}>{name}</span>

              {/* 승/패 */}
              <span className="badge b-win">{s.win}승</span>
              <span className="badge b-lose">{s.lose}패</span>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>{total}판</span>

              {/* 승률 바 */}
              <div className="wr-bar-bg" style={{ flex: 1, marginLeft: 4 }}>
                <div className="wr-bar" style={{
                  width: `${wr}%`,
                  background: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--blue)'
                }} />
              </div>

              {/* 승률 % */}
              <span style={{
                fontSize: 15, fontWeight: 700, minWidth: 40, textAlign: 'right',
                color: i === 0 ? '#FFD700' : i === 1 ? '#C0C0C0' : i === 2 ? '#CD7F32' : 'var(--text)'
              }}>{wr}%</span>
            </div>
          )
        })
      }
    </div>
  )
}

// ── 메인 페이지 ──────────────────────────────────────────────
export default function Home() {
  const [tab, setTab] = useState<'team' | 'record' | 'ranking' | 'stats' | 'summoners'>('team')
  const [records, setRecords] = useState<GameRecord[]>([])
  const [summoners, setSummoners] = useState<SummonerMap>({})
  const [loading, setLoading] = useState(true)
  // 팀뽑기 상태 유지 (탭 이동해도 안 날아감)
  const [teamPlayers, setTeamPlayers] = useState<PlayerEntry[]>([])
  const [teamResult, setTeamResult] = useState<BalanceResult | null>(null)

  const fetchAll = useCallback(async () => {
    const [{ data: recs }, { data: sums }] = await Promise.all([
      supabase.from('records').select('*').order('created_at', { ascending: false }),
      supabase.from('summoners').select('*'),
    ])
    if (recs) setRecords(recs)
    if (sums) {
      const map: SummonerMap = {}
      sums.forEach((s: { name: string; tier: string; line: Line }) => {
        if (!map[s.name]) map[s.name] = {} as Record<Line, string>
        map[s.name][s.line] = s.tier
      })
      setSummoners(map)
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  const addRecord = async ({ winner, blue, red, skipInsert }: { winner: 'blue' | 'red'; blue: string[]; red: string[]; skipInsert?: boolean }) => {
    if (!skipInsert) {
      const now = new Date()
      const time = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const { data } = await supabase.from('records').insert([{ winner, blue, red, time }]).select()
      if (data) setRecords(prev => [data[0], ...prev])
    }
    await fetchAll()
  }

  const deleteRecord = async (id: number) => {
    await supabase.from('records').delete().eq('id', id)
    setRecords(prev => prev.filter(r => r.id !== id))
  }

  const clearRecords = async () => {
    if (!confirm('전체 기록을 삭제할까요?')) return
    await supabase.from('records').delete().neq('id', 0)
    setRecords([])
  }

  return (
    <div className="layout">
      <div className="header">
        <div className="header-title">⚔ 내전 매니저</div>
        <div className="header-sub">티어·라인 기반 팀 균형 매칭 + 전적 기록</div>
      </div>

      <div className="tabs">
        {(['team', 'record', 'ranking', 'stats', 'summoners'] as const).map((t, i) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {['팀 뽑기', '전적 기록', '전체 랭킹', '개인 통계', '소환사 관리'][i]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="empty">불러오는 중...</div>
      ) : (
        <>
          {tab === 'team' && <TeamTab onRecord={addRecord} summoners={summoners} players={teamPlayers} setPlayers={setTeamPlayers} result={teamResult} setResult={setTeamResult} records={records} />}
          {tab === 'record' && <RecordTab records={records} onDelete={deleteRecord} onClear={clearRecords} />}
          {tab === 'ranking' && <RankingTab records={records} />}
          {tab === 'stats' && <StatsTab records={records} summoners={summoners} />}
          {tab === 'summoners' && <SummonerTab summoners={summoners} onRefresh={fetchAll} />}
        </>
      )}
    </div>
  )
}
