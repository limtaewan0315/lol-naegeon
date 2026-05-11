'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'
import { TIERS, LINES, getScore, shuffle } from '@/lib/data'
import type { Line } from '@/lib/data'
type TeamPlayer = { name: string; tier: string; line: Line; score: number }
interface BalanceResult { team1: TeamPlayer[]; team2: TeamPlayer[]; s1: number; s2: number }
// blue/red는 이제 {name, line} 객체 배열로 저장
interface GameRecord {
  id: number
  winner: 'blue' | 'red'
  blue: { name: string; line: Line }[]
  red: { name: string; line: Line }[]
  time: string
}

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
  most1: Line | 'any'
  most2: Line | 'any' | null
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
  const [search, setSearch] = useState('')

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

  const allSummonerNames = Object.keys(summoners).sort()
  const summonerNames = search.trim()
    ? allSummonerNames.filter(n => n.includes(search.trim()))
    : []

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
        <div className="card-title">등록된 소환사 ({allSummonerNames.length}명)</div>
        <div style={{ marginBottom: 10 }}>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="소환사명 검색..."
            style={{ width: '100%' }}
          />
        </div>
        {!search.trim()
          ? <div className="empty">소환사명을 검색해주세요</div>
          : summonerNames.length === 0
          ? <div className="empty">'{search}' 검색 결과가 없어요</div>
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


// ── 투표 섹션 ──────────────────────────────────────────────
function VoteSection({ recordId, winner, result, summoners, records, startedAt, onComplete }: {
  recordId: number
  winner: 'blue' | 'red'
  result: BalanceResult
  summoners: SummonerMap
  records: GameRecord[]
  startedAt: string | null
  onComplete: () => void
}) {
  // startedAt 기준으로 남은 시간 계산
  const calcTimeLeft = () => {
    if (!startedAt) return 60
    const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
    return Math.max(0, 60 - elapsed)
  }
  const [timeLeft, setTimeLeft] = useState(calcTimeLeft)
  const [myName, setMyName] = useState('')
  const [busVote, setBusVote] = useState('')
  const [aceVote, setAceVote] = useState('')
  const [votes, setVotes] = useState<{ vote_type: string; candidate: string; voter: string }[]>([])
  const [myVoted, setMyVoted] = useState(false)
  // votes 데이터에서 이미 투표한 이름 목록
  const votedVoters = new Set(votes.map(v => v.voter))
  const [finished, setFinished] = useState(false)
  const [voteResult, setVoteResult] = useState<{ bus: string | null; ace: string | null; tied: boolean; busValid?: boolean; aceValid?: boolean; busTied?: boolean; aceTied?: boolean } | null>(null)

  const winners = winner === 'blue' ? result.team1 : result.team2
  const losers = winner === 'blue' ? result.team2 : result.team1
  const allPlayers = [...winners, ...losers]

  // 실시간 투표 현황
  const fetchVotes = async () => {
    const { data } = await supabase.from('votes').select('vote_type, candidate, voter').eq('record_id', recordId)
    if (data) setVotes(data)
  }

  useEffect(() => {
    fetchVotes()
    const channel = supabase
      .channel(`votes-${recordId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'votes', filter: `record_id=eq.${recordId}` }, () => fetchVotes())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [recordId])

  // 60초 타이머 (startedAt 기준으로 매초 재계산)
  useEffect(() => {
    if (finished) return
    const timer = setInterval(() => {
      const left = calcTimeLeft()
      setTimeLeft(left)
      if (left <= 0) { clearInterval(timer); processResult() }
    }, 1000)
    return () => clearInterval(timer)
  }, [finished, startedAt])

  // 투표 결과 처리
  const processResult = async () => {
    if (finished) return
    setFinished(true)
    const { data: finalVotes } = await supabase.from('votes').select('vote_type, candidate, voter').eq('record_id', recordId)
    const voteData = finalVotes ?? []

    const busVotes = voteData.filter(v => v.vote_type === 'bus')
    const aceVotes = voteData.filter(v => v.vote_type === 'ace')
    const totalVoters = voteData.filter(v => v.vote_type === 'bus').length + voteData.filter(v => v.vote_type === 'ace').length

    // BUS/ACE 각각 독립적으로 유효성 체크
    const busCount = busVotes.length
    const aceCount = aceVotes.length
    const busValid = busCount >= 3
    const aceValid = aceCount >= 3

    let busWinner: string | null = null
    let aceWinner: string | null = null
    let busTied = false
    let aceTied = false

    if (busValid) {
      const busTallyMap: Record<string, number> = {}
      busVotes.forEach(v => { busTallyMap[v.candidate] = (busTallyMap[v.candidate] ?? 0) + 1 })
      const busMax = Math.max(...Object.values(busTallyMap))
      const busTop = Object.entries(busTallyMap).filter(([, c]) => c === busMax)
      if (busTop.length === 1) busWinner = busTop[0][0]
      else busTied = true
    }

    if (aceValid) {
      const aceTallyMap: Record<string, number> = {}
      aceVotes.forEach(v => { aceTallyMap[v.candidate] = (aceTallyMap[v.candidate] ?? 0) + 1 })
      const aceMax = Math.max(...Object.values(aceTallyMap))
      const aceTop = Object.entries(aceTallyMap).filter(([, c]) => c === aceMax)
      if (aceTop.length === 1) aceWinner = aceTop[0][0]
      else aceTied = true
    }

    setVoteResult({ bus: busWinner, ace: aceWinner, tied: false, busValid, aceValid, busTied, aceTied })

    // 투표 완료 후 전적 저장
    const { data: sessData } = await supabase.from('session').select('vote_pending').eq('id', 1).single()
    const pending = sessData?.vote_pending
    let savedRecordId = recordId

    if (pending) {
      const { data: newRecord } = await supabase
        .from('records')
        .insert([{ winner: pending.winner, blue: pending.blue, red: pending.red, time: pending.time }])
        .select()
      if (newRecord?.[0]?.id) {
        savedRecordId = newRecord[0].id
      }
      // pending 데이터 정리
      await supabase.from('session').update({ vote_pending: null }).eq('id', 1)
    }

    // 전적 포함한 최신 records로 승률 계산
    const { data: latestRecs } = await supabase.from('records').select('*').order('created_at', { ascending: false })
    const updatedRecords = latestRecs ?? records
    const historyEntries: { record_id: number; name: string; line: string; tier_before: string; tier_after: string }[] = []

    // 이긴팀: BUS 유효하면 1등 제외, 아니면 전원 UP
    for (const p of winners) {
      if (!summoners[p.name]?.[p.line]) continue
      const currentTier = summoners[p.name][p.line]
      const skipBus = busValid && !busTied && busWinner === p.name
      if (skipBus) continue
      let newTier: string | null = null
      if (isSilver3OrBelow(currentTier, summoners)) {
        const wr = getLineWR(p.name, p.line, updatedRecords)
        if (wr !== null && wr >= 0.6) newTier = tierUp(currentTier)
      } else {
        newTier = tierUp(currentTier)
      }
      if (newTier && newTier !== currentTier) {
        await supabase.from('summoners').update({ tier: newTier }).eq('name', p.name).eq('line', p.line)
        historyEntries.push({ record_id: savedRecordId, name: p.name, line: p.line, tier_before: currentTier, tier_after: newTier })
      }
    }

    // 진팀: ACE 유효하면 1등 제외, 아니면 전원 DOWN
    for (const p of losers) {
      if (!summoners[p.name]?.[p.line]) continue
      const skipAce = aceValid && !aceTied && aceWinner === p.name
      if (skipAce) continue
      const currentTier = summoners[p.name][p.line]
      const newTier = tierDown(currentTier)
      if (newTier !== currentTier) {
        await supabase.from('summoners').update({ tier: newTier }).eq('name', p.name).eq('line', p.line)
        historyEntries.push({ record_id: savedRecordId, name: p.name, line: p.line, tier_before: currentTier, tier_after: newTier })
      }
    }

    if (historyEntries.length > 0) {
      await supabase.from('tier_history').insert(historyEntries)
    }
    // 투표 완료 후 세션 정리 및 전적 반영
    onComplete()
  }

  // 본인이 이긴팀인지 진팀인지 판별
  const isWinner = (name: string) => winners.some(p => p.name === name)
  const isLoser  = (name: string) => losers.some(p => p.name === name)

  const submitVote = async () => {
    if (!myName) return
    const inWinTeam = isWinner(myName)
    const inLoseTeam = isLoser(myName)
    if (inWinTeam && !busVote) return
    if (inLoseTeam && !aceVote) return

    const entries: { record_id: number; vote_type: string; voter: string; candidate: string }[] = []
    if (inWinTeam && busVote) entries.push({ record_id: recordId, vote_type: 'bus', voter: myName, candidate: busVote })
    if (inLoseTeam && aceVote) entries.push({ record_id: recordId, vote_type: 'ace', voter: myName, candidate: aceVote })
    if (entries.length > 0) {
      await supabase.from('votes').upsert(entries, { onConflict: 'record_id,vote_type,voter' })
    }
    setMyVoted(true)
    fetchVotes()
  }

  const busTally: Record<string, number> = {}
  const aceTally: Record<string, number> = {}
  votes.filter(v => v.vote_type === 'bus').forEach(v => { busTally[v.candidate] = (busTally[v.candidate] ?? 0) + 1 })
  votes.filter(v => v.vote_type === 'ace').forEach(v => { aceTally[v.candidate] = (aceTally[v.candidate] ?? 0) + 1 })
  const totalVoted = votes.filter(v => v.vote_type === 'bus').length

  const timerColor = timeLeft <= 10 ? 'var(--red)' : timeLeft <= 30 ? 'var(--gold)' : 'var(--green)'

  // 이름 선택 후 내 팀 판별
  const myTeam = myName ? (isWinner(myName) ? 'winner' : isLoser(myName) ? 'loser' : null) : null
  const canVote = myName && !votedVoters.has(myName) && ((myTeam === 'winner' && busVote) || (myTeam === 'loser' && aceVote))
  // 이름 선택 시 이미 투표했으면 자동 완료 처리
  const alreadyVoted = myName ? votedVoters.has(myName) : false

  if (voteResult) {
    return (
      <div className="card" style={{ textAlign: 'center' }}>
        <div className="card-title" style={{ justifyContent: 'center' }}>투표 결과</div>
        <div style={{ marginBottom: 12 }}>
          {/* BUS 결과 */}
          {voteResult.busValid && !voteResult.busTied && voteResult.bus ? (
            <div style={{ marginBottom: 8, padding: '10px 14px', background: 'var(--blue-bg)', border: '1px solid var(--blue-border)', borderRadius: 'var(--radius)' }}>
              <span style={{ fontSize: 12, color: 'var(--blue)' }}>🚌 BUS</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--blue)', marginLeft: 8 }}>{voteResult.bus}</span>
              <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 6 }}>티어 UP 없음</span>
            </div>
          ) : (
            <div style={{ marginBottom: 8, padding: '10px 14px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>🚌 BUS</span>
              <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>
                {!voteResult.busValid ? '투표율 부족 → 이긴팀 전원 티어 UP' : '동표 → 이긴팀 전원 티어 UP'}
              </span>
            </div>
          )}
          {/* ACE 결과 */}
          {voteResult.aceValid && !voteResult.aceTied && voteResult.ace ? (
            <div style={{ padding: '10px 14px', background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 'var(--radius)' }}>
              <span style={{ fontSize: 12, color: 'var(--red)' }}>🏆 ACE</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--red)', marginLeft: 8 }}>{voteResult.ace}</span>
              <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 6 }}>티어 DOWN 없음</span>
            </div>
          ) : (
            <div style={{ padding: '10px 14px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>🏆 ACE</span>
              <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 8 }}>
                {!voteResult.aceValid ? '투표율 부족 → 진팀 전원 티어 DOWN' : '동표 → 진팀 전원 티어 DOWN'}
              </span>
            </div>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--green)', marginBottom: 12 }}>티어가 업데이트됐어요 🎉</div>
        <button className="btn btn-gold" onClick={onComplete}>닫기</button>
      </div>
    )
  }

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="card-title" style={{ marginBottom: 0 }}>투표 진행중</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>{totalVoted}/5명 BUS 투표</span>
          <span style={{ fontSize: 16, fontWeight: 700, color: timerColor, minWidth: 36, textAlign: 'right' }}>{timeLeft}초</span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14 }}>
        {/* BUS 투표 */}
        <div style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', padding: '10px 12px', border: '1px solid var(--blue-border)' }}>
          <div style={{ fontSize: 12, color: 'var(--blue)', fontWeight: 600, marginBottom: 8 }}>🚌 BUS 투표 (이긴팀만)</div>
          {winners.map(p => {
            const cnt = busTally[p.name] ?? 0
            const max = Math.max(...Object.values(busTally), 0)
            const clickable = !myVoted && myTeam === 'winner'
            const dimmed = myVoted || myTeam === 'loser' || (myName && myTeam === null)
            return (
              <div key={p.name} onClick={() => clickable && setBusVote(p.name)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                borderRadius: 4, marginBottom: 4, cursor: clickable ? 'pointer' : 'default',
                background: busVote === p.name ? 'rgba(11,196,227,0.1)' : 'transparent',
                border: busVote === p.name ? '1px solid var(--blue)' : '1px solid transparent',
                opacity: dimmed ? 0.35 : 1,
              }}>
                <span style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>{p.name}</span>
                <div style={{ width: 60, height: 4, background: 'var(--bg)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: max > 0 ? `${cnt / max * 100}%` : '0%', background: 'var(--blue)', transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--text2)', minWidth: 20, textAlign: 'right' }}>{cnt}표</span>
              </div>
            )
          })}
        </div>

        {/* ACE 투표 */}
        <div style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', padding: '10px 12px', border: '1px solid var(--red-border)' }}>
          <div style={{ fontSize: 12, color: 'var(--red)', fontWeight: 600, marginBottom: 8 }}>🏆 ACE 투표 (진팀만)</div>
          {losers.map(p => {
            const cnt = aceTally[p.name] ?? 0
            const max = Math.max(...Object.values(aceTally), 0)
            const clickable = !myVoted && myTeam === 'loser'
            const dimmed = myVoted || myTeam === 'winner' || (myName && myTeam === null)
            return (
              <div key={p.name} onClick={() => clickable && setAceVote(p.name)} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                borderRadius: 4, marginBottom: 4, cursor: clickable ? 'pointer' : 'default',
                background: aceVote === p.name ? 'rgba(232,64,87,0.1)' : 'transparent',
                border: aceVote === p.name ? '1px solid var(--red)' : '1px solid transparent',
                opacity: dimmed ? 0.35 : 1,
              }}>
                <span style={{ flex: 1, fontSize: 12, fontWeight: 500 }}>{p.name}</span>
                <div style={{ width: 60, height: 4, background: 'var(--bg)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: max > 0 ? `${cnt / max * 100}%` : '0%', background: 'var(--red)', transition: 'width 0.3s' }} />
                </div>
                <span style={{ fontSize: 11, color: 'var(--text2)', minWidth: 20, textAlign: 'right' }}>{cnt}표</span>
              </div>
            )
          })}
        </div>
      </div>

      {!myVoted && !alreadyVoted ? (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
            {!myName
              ? <span style={{ color: 'var(--text3)' }}>👆 먼저 본인 이름을 선택해주세요</span>
              : myTeam === 'winner'
              ? <span>본인 확인 <span style={{ color: 'var(--blue)', fontWeight: 600 }}>이긴팀 → BUS만 투표 가능</span></span>
              : myTeam === 'loser'
              ? <span>본인 확인 <span style={{ color: 'var(--red)', fontWeight: 600 }}>진팀 → ACE만 투표 가능</span></span>
              : <span style={{ color: 'var(--text3)' }}>이름을 다시 확인해주세요</span>
            }
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={myName} onChange={e => setMyName(e.target.value)} style={{ flex: 1 }}>
              <option value=''>나는 누구인가요?</option>
              {allPlayers.map(p => (
                <option key={p.name} value={p.name}>
                  {votedVoters.has(p.name) ? `✅ ${p.name} (투표완료)` : p.name}
                </option>
              ))}
            </select>
            <button className="btn btn-gold" onClick={submitVote} disabled={!canVote}>
              투표 완료
            </button>
          </div>
          {myTeam === 'winner' && !busVote && myName && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>🚌 BUS 후보를 선택해주세요</div>
          )}
          {myTeam === 'loser' && !aceVote && myName && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 6 }}>🏆 ACE 후보를 선택해주세요</div>
          )}
        </div>
      ) : (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, textAlign: 'center', fontSize: 13, color: 'var(--green)' }}>
          {alreadyVoted ? `✅ ${myName}은(는) 이미 투표했어요!` : '투표 완료!'} 결과를 기다리는 중... ({timeLeft}초 후 자동 마감)
        </div>
      )}
    </div>
  )
}

// 헬퍼 함수 (VoteSection 외부)
function isSilver3OrBelow(tier: string, summoners?: any): boolean {
  const SILVER3_IDX = 37 // TIERS 배열에서 실버3이하 인덱스
  const tiers = ['마/그/챌 1800이상','마/그/챌 1700~1799','마/그/챌 1600~1699','마/그/챌 1500~1599','마/그/챌 1400~1499','마/그/챌 1300~1399','마/그/챌 1200~1299','마/그/챌 1100~1199','마/그/챌 1000~1099','마/그/챌 900~999','마/그/챌 800~899','마/그/챌 700~799','마/그/챌 600~699','마/그/챌 500~599','마/그/챌 400~499','마/그/챌 300~399','마/그/챌 200~299','마/그/챌 100~199','마/그/챌 0~99','다이아1','다이아2','다이아3','다이아4','에메랄드1','에메랄드2','에메랄드3','에메랄드4','플래티넘1','플래티넘2','플래티넘3','플래티넘4','골드1','골드2','골드3','골드4','실버1','실버2','실버3 이하']
  const idx = tiers.indexOf(tier)
  return idx >= 35 // 실버1 이상부터
}

function getLineWR(playerName: string, line: Line, records: GameRecord[], n = 5): number | null {
  const lineRecs = records.filter(r =>
    r.blue.some(p => p.name === playerName && p.line === line) ||
    r.red.some(p => p.name === playerName && p.line === line)
  ).slice(0, n)
  if (lineRecs.length === 0) return null
  const wins = lineRecs.filter(r => {
    const isBlue = r.blue.some(p => p.name === playerName && p.line === line)
    return (isBlue && r.winner === 'blue') || (!isBlue && r.winner === 'red')
  }).length
  return wins / lineRecs.length
}

// ── 팀 뽑기 탭 ──────────────────────────────────────────────
function TeamTab({
  onRecord,
  summoners,
  players, setPlayers,
  result, setResult,
  records,
  onSessionUpdate,
  voteRecordId,
  voteWinner,
  voteStartedAt,
  onVoteStart,
  onVoteEnd,
}: {
  onRecord: (r: { winner: 'blue' | 'red'; blue: { name: string; line: Line }[]; red: { name: string; line: Line }[]; skipInsert?: boolean }) => void
  summoners: SummonerMap
  players: PlayerEntry[]
  setPlayers: React.Dispatch<React.SetStateAction<PlayerEntry[]>>
  result: BalanceResult | null
  setResult: React.Dispatch<React.SetStateAction<BalanceResult | null>>
  records: GameRecord[]
  onSessionUpdate: (players: PlayerEntry[], result: BalanceResult | null) => void
  voteRecordId: number | null
  voteWinner: 'blue' | 'red' | null
  voteStartedAt: string | null
  onVoteStart: (recordId: number, winner: 'blue' | 'red') => void
  onVoteEnd: () => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [suggestions, setSuggestions] = useState<string[]>([])
  // voteRecordId/voteWinner는 props로 받음

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
    setPlayers(prev => {
      const next = [...prev, { name: n, most1: lines[0], most2: lines.length >= 2 ? lines[1] : null }]
      onSessionUpdate(next, null)
      return next
    })
    setResult(null)
  }

  const removePlayer = (n: string) => {
    setPlayers(prev => {
      const next = prev.filter(p => p.name !== n)
      onSessionUpdate(next, null)
      return next
    })
    setResult(null)
  }

  const updateMost = (name: string, field: 'most1' | 'most2', value: string) => {
    setPlayers(prev => {
      const next = prev.map(p => {
        if (p.name !== name) return p
        if (field === 'most1' && value === 'any') {
          return { ...p, most1: 'any' as Line | 'any', most2: null }
        }
        return { ...p, [field]: value === '' ? null : value as Line }
      })
      onSessionUpdate(next, result)
      return next
    })
  }

  // 팀 균형 맞추기: 각 플레이어마다 most1/most2 중 랜덤 라인 선택 후 밸런싱
  const balance = useCallback(() => {
    setError('')
    // 투표 중일 때만 초기화 (다시 섞기 시에는 호출 안 함)
    if (voteRecordId !== null) onVoteEnd()
    if (players.length !== 10) { setError(`정확히 10명이 필요해요. (현재 ${players.length}명)`); return }

    // 각 플레이어의 가능한 라인 목록 생성
    const getOptions = (p: PlayerEntry): Line[] => {
      const allLines = getSummonerLines(p.name)
      const opts: Line[] = []
      if (p.most1 === 'any') {
        opts.push(...allLines)
      } else {
        opts.push(p.most1 as Line)
      }
      if (p.most2 && p.most2 !== 'any') {
        if (!opts.includes(p.most2 as Line)) opts.push(p.most2 as Line)
      }
      return opts.length > 0 ? opts : allLines
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

    if (best) onSessionUpdate(players, best)
    if (!best) {
      // 어떤 라인이 부족한지 분석
      const linePossible: Record<string, number> = {}
      LINES.forEach(l => { linePossible[l] = 0 })
      players.forEach(p => {
        const allLines = getSummonerLines(p.name)
        if (p.most1 === 'any') {
          allLines.forEach(l => { linePossible[l] = (linePossible[l] ?? 0) + 1 })
        } else {
          linePossible[p.most1] = (linePossible[p.most1] ?? 0) + 1
        }
        if (p.most2 === 'any') {
          allLines.forEach(l => { linePossible[l] = (linePossible[l] ?? 0) + 1 })
        } else if (p.most2) {
          linePossible[p.most2] = (linePossible[p.most2] ?? 0) + 1
        }
      })
      const shortLines = LINES.filter(l => (linePossible[l] ?? 0) < 2)
      if (shortLines.length > 0) {
        const msg = shortLines.map(l => {
          const cnt = linePossible[l] ?? 0
          return `${l} (${cnt}명 → 2명 필요)`
        }).join(', ')
        setError(`팀 구성 실패. 다음 라인 인원이 부족해요: ${msg}`)
      } else {
        setError('팀 구성 실패. 모스트 라인을 다양하게 설정해보세요.')
      }
      return
    }
    setResult(best)
  }, [players, summoners, voteRecordId])

  // 실버3 이하 여부 체크
  const isSilver3OrBelow = (tier: string) => {
    const silver3Idx = TIERS.indexOf('실버3 이하')
    const tierIdx = TIERS.indexOf(tier)
    return tierIdx >= silver3Idx
  }

  // 특정 플레이어의 최근 N판 승률 계산 (N판 미만이면 null 반환)
  // 라인별 최근 N판 승률 계산
  const getRecentLineWinRate = (playerName: string, line: Line, currentRecords: GameRecord[], n = 5): number | null => {
    const lineRecords = currentRecords.filter(r =>
      r.blue.some(p => p.name === playerName && p.line === line) ||
      r.red.some(p => p.name === playerName && p.line === line)
    )
    const recent = lineRecords.slice(0, n)
    if (recent.length === 0) return null
    const wins = recent.filter(r => {
      const isBlue = r.blue.some(p => p.name === playerName && p.line === line)
      return (isBlue && r.winner === 'blue') || (!isBlue && r.winner === 'red')
    }).length
    return wins / recent.length
  }

  const [isRecording, setIsRecording] = useState(false)

  const recordWin = async (winner: 'blue' | 'red') => {
    if (!result || isRecording) return
    setIsRecording(true)

    const now = new Date()
    const time = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const blueData = result.team1.map(p => ({ name: p.name, line: p.line }))
    const redData = result.team2.map(p => ({ name: p.name, line: p.line }))

    // 이전 투표 데이터 완전 초기화
    await supabase.from('votes').delete().neq('id', 0)

    // 전적/티어는 투표 완료 후 저장 - 임시 데이터를 session에 보관
    const pendingRecord = { winner, blue: blueData, red: redData, time }
    const startedAt = new Date().toISOString()
    await supabase.from('session').upsert({
      id: 1,
      vote_record_id: -1,
      vote_winner: winner,
      vote_started_at: startedAt,
      vote_pending: pendingRecord,
      updated_at: startedAt,
    })

    onVoteStart(-1, winner)
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
                  <span style={{ fontSize: 11, color: p.most1 === 'any' ? 'var(--text2)' : 'var(--gold)', fontWeight: 600 }}>M1</span>
                  <select
                    value={p.most1}
                    onChange={e => updateMost(p.name, 'most1', e.target.value)}
                    style={{ width: 85, padding: '4px 8px', fontSize: 12 }}
                  >
                    {lines.length >= 2 && <option value="any">상관없음</option>}
                    {lines.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  {p.most1 !== 'any' && <span className="badge b-tier" style={{ fontSize: 10 }}>{summoners[p.name]?.[p.most1 as Line] ?? '-'}</span>}
                </div>

                {/* 모스트2 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>M2</span>
                  <select
                    value={p.most2 ?? ''}
                    onChange={e => updateMost(p.name, 'most2', e.target.value)}
                    style={{ width: 85, padding: '4px 8px', fontSize: 12, opacity: p.most1 === 'any' ? 0.4 : 1 }}
                    disabled={p.most1 === 'any'}
                  >
                    <option value=''>없음</option>
                    {lines.filter(l => l !== p.most1 && p.most1 !== 'any').map(l => <option key={l} value={l}>{l}</option>)}
                    {p.most1 === 'any' && lines.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  {p.most2 && p.most1 !== 'any' && p.most2 !== 'any' && <span className="badge b-tier" style={{ fontSize: 10 }}>{summoners[p.name]?.[p.most2 as Line] ?? '-'}</span>}
                </div>

                <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={() => removePlayer(p.name)}>삭제</button>
              </div>
            )
          })
        }

        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-gold" onClick={balance}>팀 균형 맞추기</button>
          <button className="btn" onClick={() => { setPlayers([]); setResult(null); setError(''); onSessionUpdate([], null) }}>초기화</button>
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

          {/* 예상 승률 */}
          {(() => {
            const blue1 = sortByLine(result.team1)
            const red1 = sortByLine(result.team2)
            const TIER_SCORE_MAP: Record<string, number> = {}
            TIERS.forEach((t, i) => { TIER_SCORE_MAP[t] = (TIERS.length - i) * 10 })

            // 라인별 블루팀 승률 계산 (판수 가중)
            const lineWrs = LINES.map(line => {
              const bp = blue1.find(p => p.line === line)
              const rp = red1.find(p => p.line === line)
              if (!bp || !rp) return null

              const matchRecs = records.filter(r => {
                const bpInBlue = r.blue.some(p => p.name === bp.name && p.line === line)
                const bpInRed  = r.red.some(p => p.name === bp.name && p.line === line)
                const rpInBlue = r.blue.some(p => p.name === rp.name && p.line === line)
                const rpInRed  = r.red.some(p => p.name === rp.name && p.line === line)
                return (bpInBlue && rpInRed) || (bpInRed && rpInBlue)
              })
              const total = matchRecs.length
              if (total > 0) {
                const bpWin = matchRecs.filter(r => {
                  const bpInBlue = r.blue.some(p => p.name === bp.name && p.line === line)
                  return (bpInBlue && r.winner === 'blue') || (!bpInBlue && r.winner === 'red')
                }).length
                return { line, wr: bpWin / total, total, estimated: false }
              } else {
                // 전적 없으면 티어 점수 차이로 추정
                const bs = TIER_SCORE_MAP[bp.tier] ?? 50
                const rs = TIER_SCORE_MAP[rp.tier] ?? 50
                const diff = bs - rs
                const wr = Math.min(0.9, Math.max(0.1, 0.5 + diff * 0.01))
                return { line, wr, total: 0, estimated: true }
              }
            }).filter(Boolean) as { line: string; wr: number; total: number; estimated: boolean }[]

            // 판수 가중 평균 (전적없는 라인은 가중치 3)
            const totalWeight = lineWrs.reduce((s, l) => s + (l.total > 0 ? l.total : 3), 0)
            const blueWr = lineWrs.reduce((s, l) => s + l.wr * (l.total > 0 ? l.total : 3), 0) / totalWeight
            const blueWrPct = Math.round(blueWr * 100)
            const redWrPct = 100 - blueWrPct
            const hasEstimated = lineWrs.some(l => l.estimated)

            return (
              <div className="card">
                <div className="card-title">예상 승률</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--blue)' }}>🔵 블루팀</div>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--gold)', letterSpacing: 2 }}>VS</div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)' }}>🔴 레드팀</div>
                  </div>
                </div>

                {/* 큰 승률 바 */}
                <div style={{ position: 'relative', height: 38, background: 'var(--bg)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 10, border: '1px solid var(--border)' }}>
                  <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${blueWrPct}%`, background: 'linear-gradient(90deg, rgba(11,196,227,0.35), rgba(11,196,227,0.1))', display: 'flex', alignItems: 'center', paddingLeft: 12 }}>
                    <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--blue)' }}>{blueWrPct}%</span>
                  </div>
                  <div style={{ position: 'absolute', right: 0, top: 0, height: '100%', width: `${redWrPct}%`, background: 'linear-gradient(270deg, rgba(232,64,87,0.35), rgba(232,64,87,0.1))', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 12 }}>
                    <span style={{ fontSize: 17, fontWeight: 600, color: 'var(--red)' }}>{redWrPct}%</span>
                  </div>
                  <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'rgba(200,155,60,0.4)' }} />
                  <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: 5, height: 5, background: 'var(--gold)', borderRadius: '50%' }} />
                </div>

                {hasEstimated && (
                  <div style={{ fontSize: 10, color: 'var(--gold3)', background: 'rgba(120,90,40,0.08)', border: '1px solid rgba(120,90,40,0.2)', borderRadius: 'var(--radius)', padding: '5px 9px', marginTop: 7 }}>
                    ⚠ 전적이 없는 라인은 티어 점수로 추정되어 정확도가 낮을 수 있어요
                  </div>
                )}
              </div>
            )
          })()}

          {/* 라인별 맞대결 전적 */}
          <div className="card">
            <div className="card-title">라인별 맞대결 전적</div>
            {(() => {
              const blue1 = sortByLine(result.team1)
              const red1 = sortByLine(result.team2)
              const matchups = LINES.map(line => {
                const bp = blue1.find(p => p.line === line)
                const rp = red1.find(p => p.line === line)
                if (!bp || !rp) return null
                // 같은 라인에서 상대팀으로 맞붙었을 때만 계산
                const matchRecords = records.filter(r => {
                  const bpInBlue = r.blue.some(p => p.name === bp.name && p.line === line)
                  const bpInRed  = r.red.some(p => p.name === bp.name && p.line === line)
                  const rpInBlue = r.blue.some(p => p.name === rp.name && p.line === line)
                  const rpInRed  = r.red.some(p => p.name === rp.name && p.line === line)
                  // bp가 블루 line, rp가 레드 line 이거나 / bp가 레드 line, rp가 블루 line
                  return (bpInBlue && rpInRed) || (bpInRed && rpInBlue)
                })
                const total = matchRecords.length
                const bpWin = matchRecords.filter(r => {
                  const bpInBlue = r.blue.some(p => p.name === bp.name && p.line === line)
                  return (bpInBlue && r.winner === 'blue') || (!bpInBlue && r.winner === 'red')
                }).length
                return { line, bp, rp, total, bpWin, rpWin: total - bpWin }
              }).filter(Boolean)

              return (
                <div>
                  {matchups.map(m => {
                    if (!m) return null
                    const bpWr = m.total > 0 ? Math.round(m.bpWin / m.total * 100) : null
                    const rpWr = m.total > 0 ? Math.round(m.rpWin / m.total * 100) : null
                    return (
                      <div key={m.line} style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '10px 12px', marginBottom: 6,
                        background: 'var(--bg3)', borderRadius: 'var(--radius)',
                        border: '0.5px solid var(--border)'
                      }}>
                        {/* 블루팀 플레이어 */}
                        <div style={{ flex: 1, textAlign: 'right' }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--blue)' }}>{m.bp.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text2)' }}>{m.bp.tier}</div>
                        </div>

                        {/* 라인 + 전적 */}
                        <div style={{ textAlign: 'center', minWidth: 100 }}>
                          <div style={{ marginBottom: 4 }}>
                            <span className="badge b-line" style={{ fontSize: 10 }}>{m.line}</span>
                          </div>
                          {m.total === 0 ? (
                            <div style={{ fontSize: 11, color: 'var(--text3)' }}>전적 없음</div>
                          ) : (
                            <>
                              <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 4 }}>
                                <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{m.bpWin}승</span>
                                <span style={{ margin: '0 4px' }}>-</span>
                                <span style={{ color: 'var(--red)', fontWeight: 600 }}>{m.rpWin}승</span>
                                <span style={{ color: 'var(--text3)', marginLeft: 4 }}>({m.total}판)</span>
                              </div>
                              <div style={{ height: 4, background: 'var(--bg)', borderRadius: 2, overflow: 'hidden', position: 'relative' }}>
                                <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${bpWr}%`, background: 'var(--blue)', borderRadius: 2 }} />
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 2 }}>
                                <span style={{ color: bpWr && bpWr >= 50 ? 'var(--blue)' : 'var(--text3)' }}>{bpWr}%</span>
                                <span style={{ color: rpWr && rpWr >= 50 ? 'var(--red)' : 'var(--text3)' }}>{rpWr}%</span>
                              </div>
                            </>
                          )}
                        </div>

                        {/* 레드팀 플레이어 */}
                        <div style={{ flex: 1, textAlign: 'left' }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--red)' }}>{m.rp.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text2)' }}>{m.rp.tier}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>

          {!voteRecordId ? (
            <div className="card" style={{ textAlign: 'center' }}>
              <div className="card-title" style={{ marginBottom: 8 }}>경기 결과 기록</div>
              <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>어느 팀이 이겼나요?</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>🏆 이긴 팀은 BUS 투표, 진 팀은 ACE 투표 후 티어 변동</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                <button className="btn btn-blue" onClick={() => recordWin('blue')} disabled={isRecording}>🔵 블루팀 승리</button>
                <button className="btn btn-red" onClick={() => recordWin('red')} disabled={isRecording}>🔴 레드팀 승리</button>
              </div>
            </div>
          ) : (
            <VoteSection
              recordId={voteRecordId}
              winner={voteWinner!}
              result={result!}
              summoners={summoners}
              records={records}
              startedAt={voteStartedAt}
              onComplete={() => onVoteEnd()}
            />
          )}
        </>
      )}
    </div>
  )
}

// ── 전적 기록 탭 ──────────────────────────────────────────────
function RecordTab({ records, onDelete, onClear, voteResults }: {
  records: GameRecord[]
  onDelete: (id: number) => void
  onClear: () => void
  voteResults: { record_id: number; vote_type: string; candidate: string }[]
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
            const busName = voteResults.find(v => v.record_id === r.id && v.vote_type === 'bus')?.candidate ?? null
            const aceName = voteResults.find(v => v.record_id === r.id && v.vote_type === 'ace')?.candidate ?? null
            const renderPlayer = (p: {name:string; line:Line}, bg: string, border: string) => (
              <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', background: bg, border: `0.5px solid ${border}`, borderRadius: 999, fontSize: 11 }}>
                <span style={{ color: 'var(--text2)', fontSize: 10 }}>{p.line}</span>
                <span style={{ color: 'var(--text)', fontWeight: 500 }}>{p.name}</span>
                {p.name === busName && <span style={{ fontSize: 9, color: 'var(--blue)', fontWeight: 700, marginLeft: 2 }}>🚌BUS</span>}
                {p.name === aceName && <span style={{ fontSize: 9, color: 'var(--red)', fontWeight: 700, marginLeft: 2 }}>🏆ACE</span>}
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
                {busName && <span style={{ fontSize: 10, color: 'var(--blue)' }}>🚌{busName}</span>}
                {aceName && <span style={{ fontSize: 10, color: 'var(--red)' }}>🏆{aceName}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{r.time}</span>
                <button className="btn btn-danger btn-sm" onClick={() => onDelete(r.id)}>삭제</button>
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
function StatsTab({ records, summoners, voteResults, tierHistory }: {
  records: GameRecord[]
  summoners: SummonerMap
  voteResults: { record_id: number; vote_type: string; candidate: string }[]
  tierHistory: { record_id: number; name: string; line: string; tier_before: string; tier_after: string }[]
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])

  // 전체 플레이어 목록 (records 기반)
  const allNames = Array.from(new Set(records.flatMap(r => [...r.blue, ...r.red].map(p => p.name)))).sort()

  const handleSearch = (val: string) => {
    setSearch(val)
    setSelected(null)
    if (val.trim()) setSuggestions(allNames.filter(n => n.includes(val.trim())).slice(0, 6))
    else setSuggestions([])
  }

  const selectName = (name: string) => {
    setSelected(name)
    setSearch(name)
    setSuggestions([])
  }

  // 선택된 소환사 통계 계산
  const getStats = (name: string) => {
    let win = 0, lose = 0
    const lines: Record<string, { win: number; lose: number; recent: boolean[] }> = {}
    const recentAll: boolean[] = []

    records.forEach(r => {
      const inBlue = r.blue.some(p => p.name === name)
      const inRed = r.red.some(p => p.name === name)
      if (!inBlue && !inRed) return
      const isWin = (inBlue && r.winner === 'blue') || (inRed && r.winner === 'red')
      if (isWin) win++; else lose++
      recentAll.push(isWin)

      const p = [...r.blue, ...r.red].find(p => p.name === name)
      if (p) {
        if (!lines[p.line]) lines[p.line] = { win: 0, lose: 0, recent: [] }
        if (isWin) lines[p.line].win++; else lines[p.line].lose++
        lines[p.line].recent.push(isWin)
      }
    })

    // 연승/연패 계산 (최신순 recentAll 기준)
    let streak = 0
    if (recentAll.length > 0) {
      const last = recentAll[0]
      for (const r of recentAll) {
        if (r === last) streak++
        else break
      }
      if (!last) streak = -streak // 연패는 음수
    }

    return { win, lose, lines, recentAll, streak }
  }

  // 연승/연패 불꽃 표시
  const getStreakDisplay = (streak: number) => {
    if (streak === 0) return null
    const isWin = streak > 0
    const abs = Math.abs(streak)
    const fires = abs >= 5 ? '🔥🔥' : abs >= 3 ? '🔥' : null
    if (!fires) return null
    return (
      <span style={{ fontSize: 12, fontWeight: 700, color: isWin ? 'var(--red)' : 'var(--text3)' }}>
        {fires} {isWin ? `${abs}연승` : `${abs}연패`}
      </span>
    )
  }

  // 티어 히스토리 그래프 (해당 소환사 + 라인별)
  const getTierGraph = (name: string) => {
    const twoWeeksAgo = new Date()
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)
    const history = tierHistory
      .filter(h => h.name === name && new Date((h as any).created_at ?? 0) >= twoWeeksAgo)
      .slice()
      .reverse()
    return history
  }

  // 날짜 포맷 (M/D)
  const fmtDate = (dateStr: string) => {
    const d = new Date(dateStr)
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  // 티어 점수 (그래프용 간단 수치)
  const TIER_SCORE: Record<string, number> = {
    '실버3 이하': 1, '실버2': 2, '실버1': 3, '골드4': 4, '골드3': 5, '골드2': 6, '골드1': 7,
    '플래티넘4': 8, '플래티넘3': 9, '플래티넘2': 10, '플래티넘1': 11,
    '에메랄드4': 12, '에메랄드3': 13, '에메랄드2': 14, '에메랄드1': 15,
    '다이아4': 16, '다이아3': 17, '다이아2': 18, '다이아1': 19,
  }

  const OX = ({ results }: { results: boolean[] }) => (
    <div style={{ display: 'flex', gap: 3 }}>
      {results.slice(0, 5).map((isWin, idx) => (
        <span key={idx} style={{
          width: 20, height: 20, borderRadius: 4, fontSize: 11, fontWeight: 600,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: isWin ? 'rgba(62,207,142,0.12)' : 'rgba(232,64,87,0.1)',
          color: isWin ? 'var(--green)' : 'var(--red)',
          border: isWin ? '0.5px solid rgba(62,207,142,0.3)' : '0.5px solid rgba(232,64,87,0.25)',
        }}>{isWin ? 'O' : 'X'}</span>
      ))}
    </div>
  )

  return (
    <div>
      <div className="card">
        <div className="card-title">개인 통계 검색</div>
        <div style={{ position: 'relative', marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={search} onChange={e => handleSearch(e.target.value)} placeholder="소환사명 검색" autoComplete="off" style={{ flex: 1 }} />
            {selected && <button className="btn btn-sm" onClick={() => { setSearch(''); setSelected(null); setSuggestions([]) }}>초기화</button>}
          </div>
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden' }}>
              {suggestions.map(s => (
                <div key={s} onClick={() => selectName(s)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {s}
                </div>
              ))}
            </div>
          )}
        </div>
        {!selected && <div className="empty">소환사명을 검색해서 통계를 확인하세요</div>}
        {selected && (() => {
          const { win, lose, lines, recentAll, streak } = getStats(selected)
          const total = win + lose
          if (total === 0) return <div className="empty">전적이 없어요.</div>
          const wr = Math.round(win / total * 100)
          const sortedLines = (Object.keys(lines) as Line[]).sort((a, b) => LINE_ORDER[a] - LINE_ORDER[b])
          const tierGraph = getTierGraph(selected)

          return (
            <div>
              {/* 총 통계 */}
              <div style={{ padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, flex: '0 0 100px' }}>{selected}</span>
                  <span className="badge b-win">{win}승</span>
                  <span className="badge b-lose">{lose}패</span>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>{total}판</span>
                  {getStreakDisplay(streak)}
                  <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 700, color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>{wr}%</span>
                </div>
                <OX results={recentAll} />
              </div>

              {/* 티어 히스토리 그래프 */}
              {tierGraph.length > 0 && (
                <div style={{ padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>티어 변동 히스토리</div>
                  {/* 라인별로 그룹화 */}
                  {(Array.from(new Set(tierGraph.map(h => h.line))) as string[]).map(line => {
                    const lineHistory = tierGraph.filter(h => h.line === line)
                    const currentTier = summoners[selected]?.[line as Line] ?? lineHistory[lineHistory.length - 1]?.tier_after ?? ''

                    // 날짜별 마지막 티어 추출 (최근 14일)
                    const today = new Date()
                    const days: { date: string; score: number; tier: string }[] = []
                    for (let d = 13; d >= 0; d--) {
                      const dt = new Date(today)
                      dt.setDate(dt.getDate() - d)
                      const dateStr = `${dt.getMonth()+1}/${dt.getDate()}`
                      // 해당 날짜까지의 마지막 티어
                      const upTo = lineHistory.filter(h => {
                        const hd = new Date((h as any).created_at ?? 0)
                        return hd.getMonth() === dt.getMonth() && hd.getDate() <= dt.getDate() ||
                               hd < dt
                      })
                      const lastTier = upTo.length > 0 ? upTo[upTo.length - 1].tier_after : null
                      if (lastTier) {
                        days.push({ date: dateStr, score: TIER_SCORE[lastTier] ?? 5, tier: lastTier })
                      } else if (days.length === 0) {
                        // 기록 전이면 첫 tier_before 사용
                        const firstBefore = lineHistory[0]?.tier_before
                        if (firstBefore) days.push({ date: dateStr, score: TIER_SCORE[firstBefore] ?? 5, tier: firstBefore })
                      } else {
                        days.push({ ...days[days.length - 1], date: dateStr })
                      }
                    }

                    if (days.length === 0) return null
                    const minScore = Math.min(...days.map(d => d.score)) - 1
                    const maxScore = Math.max(...days.map(d => d.score)) + 1
                    const range = maxScore - minScore || 1
                    const W = 300, H = 70
                    const pts = days.map((d, i) => ({
                      x: days.length === 1 ? W/2 : (i / (days.length - 1)) * W,
                      y: H - ((d.score - minScore) / range) * H,
                      d
                    }))
                    const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
                    // 변동이 있는 날짜 찾기
                    const changedDays = new Set(lineHistory.map(h => {
                      const d = new Date((h as any).created_at ?? 0)
                      return `${d.getMonth()+1}/${d.getDate()}`
                    }))

                    return (
                      <div key={line} style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <span className="badge b-line" style={{ fontSize: 10 }}>{line}</span>
                          <span style={{ fontSize: 11, color: 'var(--text2)' }}>현재</span>
                          <span className="badge b-tier" style={{ fontSize: 10 }}>{currentTier}</span>
                          <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4 }}>최근 2주</span>
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <svg width={W} height={H + 32} style={{ overflow: 'visible', display: 'block' }}>
                            {/* 그리드 */}
                            {[0, 0.5, 1].map((t, i) => (
                              <line key={i} x1={0} y1={H * t} x2={W} y2={H * t}
                                stroke="rgba(80,130,190,0.08)" strokeWidth={1} />
                            ))}
                            {/* 경로 */}
                            <path d={pathD} fill="none" stroke="rgba(11,196,227,0.6)" strokeWidth={1.5} />
                            {/* 포인트 & 날짜 */}
                            {pts.map((p, i) => {
                              const isChanged = changedDays.has(p.d.date)
                              const isToday = i === pts.length - 1
                              const showLabel = i === 0 || i === pts.length - 1 || i % 3 === 0
                              return (
                                <g key={i}>
                                  {isChanged && (
                                    <circle cx={p.x} cy={p.y} r={5}
                                      fill={i > 0 && days[i].score > days[i-1].score ? 'var(--green)' : 'var(--red)'}
                                      stroke="var(--bg)" strokeWidth={1.5} />
                                  )}
                                  {!isChanged && (
                                    <circle cx={p.x} cy={p.y} r={2} fill="rgba(11,196,227,0.3)" />
                                  )}
                                  {showLabel && (
                                    <text x={p.x} y={H + 20} textAnchor="middle"
                                      fontSize={7} fill="var(--text3)">{p.d.date}</text>
                                  )}
                                  {isChanged && (
                                    <text x={p.x} y={p.y - 8} textAnchor="middle"
                                      fontSize={7} fill={i > 0 && days[i].score > days[i-1].score ? 'var(--green)' : 'var(--red)'}>
                                      {p.d.tier.replace('플래티넘','플').replace('에메랄드','에').replace('실버','실').replace('골드','골').replace(' 이하','↓')}
                                    </text>
                                  )}
                                </g>
                              )
                            })}
                          </svg>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* 라인별 통계 */}
              <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>라인별 통계</div>
              {sortedLines.map(l => {
                const ls = lines[l]
                const lTotal = ls.win + ls.lose
                const lWr = Math.round(ls.win / lTotal * 100)
                // 해당 라인의 BUS/ACE 횟수 계산
                const lineRecordIds = records
                  .filter(r => [...r.blue, ...r.red].some(p => p.name === selected && p.line === l))
                  .map(r => r.id)
                const busCount = voteResults.filter(v => lineRecordIds.includes(v.record_id) && v.vote_type === 'bus' && v.candidate === selected).length
                const aceCount = voteResults.filter(v => lineRecordIds.includes(v.record_id) && v.vote_type === 'ace' && v.candidate === selected).length
                return (
                  <div key={l} style={{ padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span className="badge b-line">{l}</span>
                      {summoners[selected]?.[l] && <span className="badge b-tier">{summoners[selected][l]}</span>}
                      <span className="badge b-win" style={{ fontSize: 10 }}>{ls.win}승</span>
                      <span className="badge b-lose" style={{ fontSize: 10 }}>{ls.lose}패</span>
                      <span style={{ fontSize: 11, color: 'var(--text2)' }}>{lTotal}판</span>
                      {busCount > 0 && <span style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 600 }}>🚌BUS {busCount}회</span>}
                      {aceCount > 0 && <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 600 }}>🏆ACE {aceCount}회</span>}
                      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: lWr >= 50 ? 'var(--green)' : 'var(--red)' }}>{lWr}%</span>
                    </div>
                    {/* 라인별 최근 5판 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, color: 'var(--text3)' }}>최근</span>
                      <OX results={ls.recent} />
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })()}
      </div>
    </div>
  )
}


// ── 상대 전적 검색 탭 ──────────────────────────────────────────────
function MatchupTab({ records }: { records: GameRecord[] }) {
  const [nameA, setNameA] = useState('')
  const [nameB, setNameB] = useState('')
  const [sugA, setSugA] = useState<string[]>([])
  const [sugB, setSugB] = useState<string[]>([])

  const allNames = Array.from(new Set(records.flatMap(r => [...r.blue, ...r.red].map(p => p.name)))).sort()

  const handleA = (val: string) => { setNameA(val); setSugA(val ? allNames.filter(n => n.includes(val) && n !== nameB).slice(0, 5) : []) }
  const handleB = (val: string) => { setNameB(val); setSugB(val ? allNames.filter(n => n.includes(val) && n !== nameA).slice(0, 5) : []) }

  // 두 소환사가 같은 게임에 있었던 전적 계산
  const getMatchup = () => {
    if (!nameA || !nameB) return null
    const matched = records.filter(r => {
      const allP = [...r.blue, ...r.red].map(p => p.name)
      return allP.includes(nameA) && allP.includes(nameB)
    })
    if (matched.length === 0) return { total: 0, aWin: 0, bWin: 0, sameTeam: 0, oppose: 0, sameWin: 0 }

    let aWin = 0, bWin = 0, sameTeam = 0, oppose = 0, sameWin = 0
    matched.forEach(r => {
      const aInBlue = r.blue.some(p => p.name === nameA)
      const bInBlue = r.blue.some(p => p.name === nameB)
      const aWins = (aInBlue && r.winner === 'blue') || (!aInBlue && r.winner === 'red')

      if (aInBlue === bInBlue) {
        sameTeam++
        if (aWins) sameWin++
      } else {
        oppose++
        if (aWins) aWin++; else bWin++
      }
    })
    return { total: matched.length, aWin, bWin, sameTeam, oppose, sameWin }
  }

  const result = nameA && nameB && nameA !== nameB ? getMatchup() : null

  return (
    <div>
      <div className="card">
        <div className="card-title">상대 전적 검색</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          {/* 소환사 A */}
          <div style={{ position: 'relative' }}>
            <input value={nameA} onChange={e => handleA(e.target.value)} placeholder="소환사 A" autoComplete="off" />
            {sugA.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden' }}>
                {sugA.map(s => (
                  <div key={s} onClick={() => { setNameA(s); setSugA([]) }} style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{s}</div>
                ))}
              </div>
            )}
          </div>
          <span style={{ fontSize: 13, color: 'var(--gold)', textAlign: 'center', letterSpacing: 2 }}>VS</span>
          {/* 소환사 B */}
          <div style={{ position: 'relative' }}>
            <input value={nameB} onChange={e => handleB(e.target.value)} placeholder="소환사 B" autoComplete="off" />
            {sugB.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden' }}>
                {sugB.map(s => (
                  <div key={s} onClick={() => { setNameB(s); setSugB([]) }} style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 13 }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>{s}</div>
                ))}
              </div>
            )}
          </div>
        </div>

        {!nameA || !nameB || nameA === nameB
          ? <div className="empty">두 소환사를 검색해서 전적을 확인하세요</div>
          : result === null ? null
          : result.total === 0
          ? <div className="empty">두 소환사가 함께한 게임이 없어요.</div>
          : (
            <div>
              {/* 상대팀 전적 */}
              {result.oppose > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>맞대결 전적</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                    {/* A */}
                    <div style={{ flex: 1, textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--blue)' }}>{nameA}</div>
                      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{result.aWin}승</div>
                    </div>
                    {/* 가운데 바 */}
                    <div style={{ textAlign: 'center', minWidth: 120 }}>
                      <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 6 }}>
                        <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{result.aWin}</span>
                        <span style={{ margin: '0 6px', color: 'var(--text3)' }}>-</span>
                        <span style={{ color: 'var(--red)', fontWeight: 600 }}>{result.bWin}</span>
                        <span style={{ color: 'var(--text3)', marginLeft: 6, fontSize: 11 }}>({result.oppose}판)</span>
                      </div>
                      <div style={{ height: 5, background: 'var(--bg)', borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
                        <div style={{ height: '100%', width: `${Math.round(result.aWin / result.oppose * 100)}%`, background: 'var(--blue)' }} />
                        <div style={{ height: '100%', flex: 1, background: 'var(--red)' }} />
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 3 }}>
                        <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{Math.round(result.aWin / result.oppose * 100)}%</span>
                        <span style={{ color: 'var(--red)', fontWeight: 600 }}>{Math.round(result.bWin / result.oppose * 100)}%</span>
                      </div>
                    </div>
                    {/* B */}
                    <div style={{ flex: 1, textAlign: 'left' }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--red)' }}>{nameB}</div>
                      <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 2 }}>{result.bWin}승</div>
                    </div>
                  </div>
                </div>
              )}

              {/* 같은팀 전적 */}
              {result.sameTeam > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>같은 팀 전적</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>
                        <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{nameA}</span>
                        <span style={{ margin: '0 6px', color: 'var(--text3)' }}>+</span>
                        <span style={{ color: 'var(--red)', fontWeight: 600 }}>{nameB}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text2)' }}>
                        <span style={{ color: 'var(--green)', fontWeight: 600 }}>{result.sameWin}승</span>
                        <span style={{ margin: '0 4px', color: 'var(--text3)' }}>/</span>
                        <span style={{ color: 'var(--red)' }}>{result.sameTeam - result.sameWin}패</span>
                        <span style={{ color: 'var(--text3)', marginLeft: 6 }}>({result.sameTeam}판)</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: Math.round(result.sameWin / result.sameTeam * 100) >= 50 ? 'var(--green)' : 'var(--red)' }}>
                      {Math.round(result.sameWin / result.sameTeam * 100)}%
                    </div>
                  </div>
                </div>
              )}
            </div>
          )
        }
      </div>
    </div>
  )
}

// ── 전체 랭킹 탭 ──────────────────────────────────────────────
function RankingTab({ records }: { records: GameRecord[] }) {
  const playerMap: Record<string, { win: number; lose: number }> = {}
  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    ;[...winners, ...losers].forEach(p => { if (!playerMap[p.name]) playerMap[p.name] = { win: 0, lose: 0 } })
    winners.forEach(p => playerMap[p.name].win++)
    losers.forEach(p => playerMap[p.name].lose++)
  })

  // 10판 이상인 소환사만, 승률 내림차순 정렬
  const entries = Object.entries(playerMap)
    .filter(([, s]) => s.win + s.lose >= 30)
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
        🏆 30판 이상 참가한 소환사만 집계돼요
      </div>
      {entries.length === 0
        ? <div className="empty">30판 이상 참가한 소환사가 없어요. 경기를 더 쌓아보세요!</div>
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
  const [tab, setTab] = useState<'team' | 'record' | 'ranking' | 'stats' | 'matchup' | 'summoners'>('team')
  const [records, setRecords] = useState<GameRecord[]>([])
  const [summoners, setSummoners] = useState<SummonerMap>({})
  const [voteResults, setVoteResults] = useState<{ record_id: number; vote_type: string; candidate: string }[]>([])
  const [tierHistory, setTierHistory] = useState<{ record_id: number; name: string; line: string; tier_before: string; tier_after: string }[]>([])
  const [loading, setLoading] = useState(true)
  // 팀뽑기 상태 유지 (탭 이동해도 안 날아감)
  const [teamPlayers, setTeamPlayers] = useState<PlayerEntry[]>([])
  const [teamResult, setTeamResult] = useState<BalanceResult | null>(null)
  // 투표 상태 (전체 공유)
  const [voteRecordId, setVoteRecordId] = useState<number | null>(null)
  const [voteWinner, setVoteWinner] = useState<'blue' | 'red' | null>(null)
  const [voteStartedAt, setVoteStartedAt] = useState<string | null>(null)

  const fetchAll = useCallback(async () => {
    const [{ data: recs }, { data: sums }, { data: sess }, { data: vots }, { data: hist }] = await Promise.all([
      supabase.from('records').select('*').order('created_at', { ascending: false }),
      supabase.from('summoners').select('*'),
      supabase.from('session').select('*').eq('id', 1).single(),
      supabase.from('votes').select('record_id, vote_type, candidate'),
      supabase.from('tier_history').select('*').order('id', { ascending: true }),
    ])
    if (recs) setRecords(recs)
    if (vots) setVoteResults(vots)
    if (hist) setTierHistory(hist)
    if (sums) {
      const map: SummonerMap = {}
      sums.forEach((s: { name: string; tier: string; line: Line }) => {
        if (!map[s.name]) map[s.name] = {} as Record<Line, string>
        map[s.name][s.line] = s.tier
      })
      setSummoners(map)
    }
    if (sess) {
      setTeamPlayers(sess.players ?? [])
      setTeamResult(sess.result ?? null)
      if (sess.vote_record_id !== null && sess.vote_record_id !== undefined) {
        setVoteRecordId(sess.vote_record_id)
        setVoteWinner(sess.vote_winner)
        setVoteStartedAt(sess.vote_started_at ?? null)
      } else {
        setVoteRecordId(null)
        setVoteWinner(null)
        setVoteStartedAt(null)
      }
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // 세션 실시간 구독
  useEffect(() => {
    const channel = supabase
      .channel('session-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'session', filter: 'id=eq.1' }, payload => {
        const sess = payload.new as any
        if (sess) {
          setTeamPlayers(sess.players ?? [])
          setTeamResult(sess.result ?? null)
          if (sess.vote_record_id !== null && sess.vote_record_id !== undefined) {
            setVoteRecordId(sess.vote_record_id)
            setVoteWinner(sess.vote_winner)
            setVoteStartedAt(sess.vote_started_at ?? null)
          } else {
            setVoteRecordId(null)
            setVoteWinner(null)
            setVoteStartedAt(null)
          }
        }
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [])

  // 세션 업데이트 함수 (팀편성 관련만 업데이트, 투표 상태 유지)
  const updateSession = async (players: PlayerEntry[], result: BalanceResult | null) => {
    await supabase.from('session').update({ players, result, updated_at: new Date().toISOString() }).eq('id', 1)
  }



  const handleVoteStart = async (recordId: number, winner: 'blue' | 'red') => {
    setVoteRecordId(recordId)
    setVoteWinner(winner)
    // recordWin에서 이미 session에 저장했으므로 여기서는 상태만 업데이트
    const { data: sess } = await supabase.from('session').select('vote_started_at').eq('id', 1).single()
    setVoteStartedAt(sess?.vote_started_at ?? null)
  }

  const handleVoteEnd = async () => {
    setVoteRecordId(null)
    setVoteWinner(null)
    setVoteStartedAt(null)
    setTeamResult(null)
    // 투표 데이터 정리 + 팀 결과 초기화
    await supabase.from('session').update({ vote_record_id: null, vote_winner: null, vote_started_at: null, vote_pending: null, result: null, updated_at: new Date().toISOString() }).eq('id', 1)
    await fetchAll()
  }

  const addRecord = async ({ winner, blue, red, skipInsert }: { winner: 'blue' | 'red'; blue: { name: string; line: Line }[]; red: { name: string; line: Line }[]; skipInsert?: boolean }) => {
    if (!skipInsert) {
      const now = new Date()
      const time = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const { data } = await supabase.from('records').insert([{ winner, blue, red, time }]).select()
      if (data) setRecords(prev => [data[0], ...prev])
    }
    await fetchAll()
  }

  const deleteRecord = async (id: number) => {
    // 해당 전적의 티어 이력 조회 후 롤백
    const { data: history } = await supabase.from('tier_history').select('*').eq('record_id', id)
    if (history && history.length > 0) {
      for (const h of history) {
        // tier_before로 되돌리기
        await supabase.from('summoners').update({ tier: h.tier_before }).eq('name', h.name).eq('line', h.line)
      }
      await supabase.from('tier_history').delete().eq('record_id', id)
    }
    await supabase.from('records').delete().eq('id', id)
    setRecords(prev => prev.filter(r => r.id !== id))
    await fetchAll()
  }

  const clearRecords = async () => {
    if (!confirm('전체 기록을 삭제할까요? 티어도 전부 롤백돼요!')) return
    // 모든 tier_history 롤백
    const { data: allHistory } = await supabase.from('tier_history').select('*').order('id', { ascending: false })
    if (allHistory && allHistory.length > 0) {
      // 최신 이력부터 역순으로 롤백
      for (const h of allHistory) {
        await supabase.from('summoners').update({ tier: h.tier_before }).eq('name', h.name).eq('line', h.line)
      }
      await supabase.from('tier_history').delete().neq('id', 0)
    }
    await supabase.from('records').delete().neq('id', 0)
    setRecords([])
    await fetchAll()
  }

  return (
    <div className="layout">
      <div className="header">
        <div className="header-title">⚔ 내전 매니저</div>
        <div className="header-sub">티어·라인 기반 팀 균형 매칭 + 전적 기록</div>
      </div>

      <div className="tabs">
        {(['team', 'record', 'ranking', 'stats', 'matchup', 'summoners'] as const).map((t, i) => (
          <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {['팀 뽑기', '전적 기록', '전체 랭킹', '개인 통계', '상대 전적', '소환사 관리'][i]}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="empty">불러오는 중...</div>
      ) : (
        <>
          {tab === 'team' && <TeamTab onRecord={addRecord} summoners={summoners} players={teamPlayers} setPlayers={setTeamPlayers} result={teamResult} setResult={setTeamResult} records={records} onSessionUpdate={updateSession} voteRecordId={voteRecordId} voteWinner={voteWinner} voteStartedAt={voteStartedAt} onVoteStart={handleVoteStart} onVoteEnd={handleVoteEnd} />}
          {tab === 'record' && <RecordTab records={records} onDelete={deleteRecord} onClear={clearRecords} voteResults={voteResults} />}
          {tab === 'ranking' && <RankingTab records={records} />}
          {tab === 'stats' && <StatsTab records={records} summoners={summoners} voteResults={voteResults} tierHistory={tierHistory} />}
          {tab === 'matchup' && <MatchupTab records={records} />}
          {tab === 'summoners' && <SummonerTab summoners={summoners} onRefresh={fetchAll} />}
        </>
      )}
    </div>
  )
}
