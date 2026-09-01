'use client'

import { useState, useMemo } from 'react'
import type { Line } from '@/lib/data'
import { LINES, getScoreByTier } from '@/lib/data'
import { SummonerMap, SummonerScoreMap, GameRecord, LINE_ORDER, NameWithIdBadge } from '@/lib/shared'

export default function StatsTab({ records, summoners, summonerScores, idPrefixMap, nameByUserId, inactiveNames }: {
  records: GameRecord[]
  summoners: SummonerMap
  summonerScores: SummonerScoreMap
  idPrefixMap: Record<string, string>
  nameByUserId: Record<string, string>
  inactiveNames: Set<string>
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<{ key: string; name: string } | null>(null)
  const [suggestions, setSuggestions] = useState<{ key: string; name: string }[]>([])
  const [oppSearch, setOppSearch] = useState('')
  const [oppSelected, setOppSelected] = useState<{ key: string; name: string } | null>(null)
  const [oppSuggestions, setOppSuggestions] = useState<{ key: string; name: string }[]>([])
  const [detailLineA, setDetailLineA] = useState<Line | ''>('')
  const [detailLineB, setDetailLineB] = useState<Line | ''>('')
  const [sameTeamLineA, setSameTeamLineA] = useState<Line | ''>('')
  const [sameTeamLineB, setSameTeamLineB] = useState<Line | ''>('')

  // 한 사람을 가리키는 키: 계정ID가 있으면 계정ID(정확), 없으면(탈퇴 계정 등 옛날 기록) 이름으로 대체
  const keyOf = (p: { userId?: string; name: string }) => p.userId ?? p.name

  // 전체 플레이어 목록 (records 기반, 계정ID로 동명이인 구분) — 비활성화된 사람은 검색/조회에서 제외
  const allPeople = useMemo(() => {
    const map = new Map<string, string>()
    records.forEach(r => {
      ;[...r.blue, ...r.red].forEach(p => {
        const key = keyOf(p)
        if (!map.has(key) && !inactiveNames.has(key)) map.set(key, p.name)
      })
    })
    return Array.from(map.entries()).map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [records, inactiveNames])

  const handleSearch = (val: string) => {
    setSearch(val)
    setSelected(null)
    if (val.trim()) setSuggestions(allPeople.filter(p => p.name.includes(val.trim())).slice(0, 6))
    else setSuggestions([])
  }

  const selectName = (person: { key: string; name: string }) => {
    setSelected(person)
    setSearch(person.name)
    setSuggestions([])
    setOppSelected(null)
    setOppSearch('')
  }

  // 선택된 소환사 통계 계산
  // 상대전적 계산 (MatchupTab 로직 통합) — 계정ID(키) 기준
  const getMatchup = (keyA: string, keyB: string) => {
    const matched = records.filter(r => {
      const allKeys = [...r.blue, ...r.red].map(keyOf)
      return allKeys.includes(keyA) && allKeys.includes(keyB)
    })
    if (matched.length === 0) return { total: 0, aWin: 0, bWin: 0, sameTeam: 0, oppose: 0, sameWin: 0 }
    let aWin = 0, bWin = 0, sameTeam = 0, oppose = 0, sameWin = 0
    matched.forEach(r => {
      const aInBlue = r.blue.some(p => keyOf(p) === keyA)
      const bInBlue = r.blue.some(p => keyOf(p) === keyB)
      const aWins = (aInBlue && r.winner === 'blue') || (!aInBlue && r.winner === 'red')
      if (aInBlue === bInBlue) { sameTeam++; if (aWins) sameWin++ }
      else { oppose++; if (aWins) aWin++; else bWin++ }
    })
    return { total: matched.length, aWin, bWin, sameTeam, oppose, sameWin }
  }

  // 라인을 직접 선택해서 보는 디테일 맞대결 조회 (기존 getMatchup과 별개, 추가 기능)
  // keyA가 lineA 라인, keyB가 lineB 라인으로 서로 다른 팀에서 만났을 때의 전적
  const getDetailedMatchup = (keyA: string, lineA: Line, keyB: string, lineB: Line) => {
    let total = 0, aWin = 0, bWin = 0
    records.forEach(r => {
      const aEntry = [...r.blue, ...r.red].find(p => keyOf(p) === keyA && p.line === lineA)
      const bEntry = [...r.blue, ...r.red].find(p => keyOf(p) === keyB && p.line === lineB)
      if (!aEntry || !bEntry) return
      const aInBlue = r.blue.includes(aEntry)
      const bInBlue = r.blue.includes(bEntry)
      if (aInBlue === bInBlue) return // 같은 팀이면 "맞대결" 대상 아님
      total++
      const aWins = (aInBlue && r.winner === 'blue') || (!aInBlue && r.winner === 'red')
      if (aWins) aWin++
      else bWin++
    })
    return { total, aWin, bWin }
  }

  // 라인을 직접 선택해서 보는 같은 팀 디테일 조회 (추가 기능)
  // keyA가 lineA 라인, keyB가 lineB 라인으로 같은 팀일 때의 전적
  const getDetailedSameTeam = (keyA: string, lineA: Line, keyB: string, lineB: Line) => {
    let total = 0, win = 0
    records.forEach(r => {
      const aEntry = [...r.blue, ...r.red].find(p => keyOf(p) === keyA && p.line === lineA)
      const bEntry = [...r.blue, ...r.red].find(p => keyOf(p) === keyB && p.line === lineB)
      if (!aEntry || !bEntry) return
      const aInBlue = r.blue.includes(aEntry)
      const bInBlue = r.blue.includes(bEntry)
      if (aInBlue !== bInBlue) return // 다른 팀이면 "같은 팀" 대상 아님
      total++
      const teamWins = (aInBlue && r.winner === 'blue') || (!aInBlue && r.winner === 'red')
      if (teamWins) win++
    })
    return { total, win, lose: total - win }
  }

  const getStats = (key: string) => {
    let win = 0, lose = 0
    const lines: Record<string, { win: number; lose: number; recent: boolean[] }> = {}
    const recentAll: boolean[] = []

    records.forEach(r => {
      const inBlue = r.blue.some(p => keyOf(p) === key)
      const inRed = r.red.some(p => keyOf(p) === key)
      if (!inBlue && !inRed) return
      const isWin = (inBlue && r.winner === 'blue') || (inRed && r.winner === 'red')
      if (isWin) win++; else lose++
      recentAll.push(isWin)

      const p = [...r.blue, ...r.red].find(p => keyOf(p) === key)
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
    if (Math.abs(streak) < 2) return null
    const isWin = streak > 0
    const abs = Math.abs(streak)
    const icon = isWin ? '🔥' : '💧'
    return (
      <span style={{ fontSize: 11, fontWeight: 700, color: isWin ? 'var(--red)' : '#5865f2', marginLeft: 4 }}>
        {icon} {isWin ? `${abs}연승` : `${abs}연패`}
      </span>
    )
  }

  // 라인별 연승/연패 계산
  const getLineStreak = (key: string, line: string) => {
    const lineRecs = records.filter(r =>
      r.blue.some(p => keyOf(p) === key && p.line === line) ||
      r.red.some(p => keyOf(p) === key && p.line === line)
    )
    if (lineRecs.length === 0) return 0
    const results = lineRecs.map(r => {
      const inBlue = r.blue.some(p => keyOf(p) === key && p.line === line)
      return (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
    })
    const last = results[0]
    let streak = 0
    for (const r of results) {
      if (r === last) streak++
      else break
    }
    return last ? streak : -streak
  }

  // 티어 히스토리 그래프 (해당 소환사 + 라인별) — 계정ID 기준, 없으면 이름으로 대체(옛날 기록 호환)
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
            {selected && <button className="btn btn-sm" onClick={() => { setSearch(''); setSelected(null); setSuggestions([]); setOppSearch(''); setOppSelected(null); setOppSuggestions([]) }}>초기화</button>}
          </div>
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden' }}>
              {suggestions.map(s => (
                <div key={s.key} onClick={() => selectName(s)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <NameWithIdBadge name={s.name} idPrefixMap={idPrefixMap} userId={s.key} />
                </div>
              ))}
            </div>
          )}
        </div>
        {!selected && <div className="empty">소환사명을 검색해서 통계를 확인하세요</div>}
        {selected && (() => {
          const selKey = selected.key
          const selName = selected.name
          const { win, lose, lines, recentAll, streak } = getStats(selKey)
          const total = win + lose
          if (total === 0) return <div className="empty">전적이 없어요.</div>
          const wr = Math.round(win / total * 100)
          const sortedLines = (Object.keys(lines) as Line[]).sort((a, b) => LINE_ORDER[a] - LINE_ORDER[b])

          // 마지막 게임 날짜 계산 (records는 최신순 정렬되어 있음)
          const lastGame = records.find(r => r.blue.some(p => keyOf(p) === selKey) || r.red.some(p => keyOf(p) === selKey))
          let lastGameText = ''
          if (lastGame) {
            const lastDate = new Date((lastGame as any).created_at ?? '')
            if (!isNaN(lastDate.getTime())) {
              const now = new Date()
              const diffMs = now.getTime() - lastDate.getTime()
              const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
              const dateStr = `${lastDate.getMonth() + 1}/${lastDate.getDate()}`
              if (diffDays === 0) lastGameText = `오늘 (${dateStr})`
              else lastGameText = `${dateStr} · ${diffDays}일 전`
            }
          }

          return (
            <div>
              {/* 총 통계 */}
              <div style={{ padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, flex: '0 0 100px' }}>
                    <NameWithIdBadge name={selName} idPrefixMap={idPrefixMap} userId={selKey} />
                  </span>
                  <span className="badge b-win">{win}승</span>
                  <span className="badge b-lose">{lose}패</span>
                  <span style={{ fontSize: 12, color: 'var(--text2)' }}>{total}판</span>
                  <span style={{ marginLeft: 'auto', fontSize: 16, fontWeight: 700, color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>{wr}%</span>
                </div>
                {lastGameText && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                    🕐 마지막 게임: {lastGameText}
                  </div>
                )}
                <OX results={recentAll} />
              </div>

              {/* 라인별 통계 */}
              <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>라인별 통계</div>
              {sortedLines.map(l => {
                const ls = lines[l]
                const lTotal = ls.win + ls.lose
                const lWr = Math.round(ls.win / lTotal * 100)
                const lineStreak = getLineStreak(selKey, l)

                return (
                  <div key={l} style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)', marginBottom: 6, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span className="badge b-line">{l}</span>
                      {summoners[selKey]?.[l] && (
                        <>
                          <span className="badge b-tier">{summoners[selKey][l]}</span>
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>{summonerScores[selKey]?.[l] ?? '-'}점</span>
                        </>
                      )}
                      <span className="badge b-win" style={{ fontSize: 10 }}>{ls.win}승</span>
                      <span className="badge b-lose" style={{ fontSize: 10 }}>{ls.lose}패</span>
                      <span style={{ fontSize: 11, color: 'var(--text2)' }}>{lTotal}판</span>

                      <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: lWr >= 50 ? 'var(--green)' : 'var(--red)' }}>{lWr}%</span>
                    </div>
                    {/* 최근 5판 + 라인 연승/연패 */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 10, color: 'var(--text3)' }}>최근</span>
                      <OX results={ls.recent} />
                      {getStreakDisplay(lineStreak)}
                    </div>
                  </div>
                )
              })}

              {/* 상대 전적 검색 */}
              <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>상대 전적 검색</div>
                <div style={{ position: 'relative', marginBottom: 10 }}>
                  <input value={oppSearch} onChange={e => {
                    setOppSearch(e.target.value)
                    setOppSelected(null)
                    const v = e.target.value.trim()
                    setOppSuggestions(v ? allPeople.filter(p => p.name.includes(v) && p.key !== selKey).slice(0, 5) : [])
                  }} placeholder="상대 소환사 검색" autoComplete="off" style={{ width: '100%' }} />
                  {oppSuggestions.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden' }}>
                      {oppSuggestions.map(s => (
                        <div key={s.key} onClick={() => { setOppSelected(s); setOppSearch(s.name); setOppSuggestions([]) }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                          onMouseEnter={e2 => (e2.currentTarget.style.background = 'var(--bg2)')}
                          onMouseLeave={e2 => (e2.currentTarget.style.background = 'transparent')}><NameWithIdBadge name={s.name} idPrefixMap={idPrefixMap} userId={s.key} /></div>
                      ))}
                    </div>
                  )}
                </div>
                {!oppSearch.trim() && <div style={{ fontSize: 12, color: 'var(--text3)' }}>상대 소환사를 검색해보세요</div>}
                {oppSelected && (() => {
                  const oppKey = oppSelected.key
                  const oppName = oppSelected.name
                  const m = getMatchup(selKey, oppKey)
                  if (m.total === 0) return <div className="empty">함께한 게임이 없어요.</div>
                  return (
                    <div>
                      {m.oppose > 0 && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>맞대결</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                            <div style={{ flex: 1, textAlign: 'right' }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--blue)' }}>{selName}</div>
                              <div style={{ fontSize: 11, color: 'var(--text2)' }}>{m.aWin}승</div>
                            </div>
                            <div style={{ textAlign: 'center', minWidth: 90 }}>
                              <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 4 }}>
                                <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{m.aWin}</span>
                                <span style={{ margin: '0 4px', color: 'var(--text3)' }}>-</span>
                                <span style={{ color: 'var(--red)', fontWeight: 600 }}>{m.bWin}</span>
                                <span style={{ color: 'var(--text3)', fontSize: 10, marginLeft: 4 }}>({m.oppose}판)</span>
                              </div>
                              <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden', display: 'flex' }}>
                                <div style={{ height: '100%', width: `${Math.round(m.aWin/m.oppose*100)}%`, background: 'var(--blue)' }} />
                                <div style={{ height: '100%', flex: 1, background: 'var(--red)' }} />
                              </div>
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>{oppName}</div>
                              <div style={{ fontSize: 11, color: 'var(--text2)' }}>{m.bWin}승</div>
                            </div>
                          </div>

                          {/* 라인 선택 디테일 조회 (추가 기능, 기존 합산 통계와 별개) */}
                          <div style={{ marginTop: 10 }}>
                            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>라인별 디테일 맞대결 (직접 라인 선택)</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                              <select
                                value={detailLineA}
                                onChange={e => setDetailLineA(e.target.value as Line | '')}
                                style={{ flex: 1, fontSize: 12 }}
                              >
                                <option value="">{selName} 라인 선택</option>
                                {LINES.map(l => <option key={l} value={l}>{l}</option>)}
                              </select>
                              <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>vs</span>
                              <select
                                value={detailLineB}
                                onChange={e => setDetailLineB(e.target.value as Line | '')}
                                style={{ flex: 1, fontSize: 12 }}
                              >
                                <option value="">{oppName} 라인 선택</option>
                                {LINES.map(l => <option key={l} value={l}>{l}</option>)}
                              </select>
                            </div>
                            {detailLineA && detailLineB && (() => {
                              const dm = getDetailedMatchup(selKey, detailLineA, oppKey, detailLineB)
                              if (dm.total === 0) return <div className="empty">해당 라인 조합으로 맞붙은 적이 없어요.</div>
                              const wr = Math.round(dm.aWin / dm.total * 100)
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                                  <div style={{ flex: 1, textAlign: 'right' }}>
                                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--blue)' }}>{selName}</div>
                                    <div style={{ fontSize: 11, color: 'var(--text2)' }}>{detailLineA} · {dm.aWin}승</div>
                                  </div>
                                  <div style={{ textAlign: 'center', minWidth: 90 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                                      <span style={{ color: 'var(--blue)' }}>{dm.aWin}</span>
                                      <span style={{ margin: '0 4px', color: 'var(--text3)' }}>-</span>
                                      <span style={{ color: 'var(--red)' }}>{dm.bWin}</span>
                                    </div>
                                    <div style={{ fontSize: 10, color: 'var(--text3)' }}>{dm.total}판</div>
                                    <div style={{ height: 4, background: 'var(--bg)', borderRadius: 2, overflow: 'hidden', display: 'flex', marginTop: 4 }}>
                                      <div style={{ height: '100%', width: `${wr}%`, background: 'var(--blue)' }} />
                                      <div style={{ height: '100%', flex: 1, background: 'var(--red)' }} />
                                    </div>
                                  </div>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>{oppName}</div>
                                    <div style={{ fontSize: 11, color: 'var(--text2)' }}>{detailLineB} · {dm.bWin}승</div>
                                  </div>
                                </div>
                              )
                            })()}
                          </div>
                        </div>
                      )}
                      {m.sameTeam > 0 && (
                        <div>
                          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>같은 팀</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                            <span style={{ fontSize: 12, flex: 1 }}>
                              <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{selName}</span>
                              <span style={{ color: 'var(--text3)' }}> + </span>
                              <span style={{ color: 'var(--red)', fontWeight: 600 }}>{oppName}</span>
                            </span>
                            <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>{m.sameWin}승</span>
                            <span style={{ fontSize: 11, color: 'var(--red)', marginLeft: 6 }}>{m.sameTeam - m.sameWin}패</span>
                            <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, color: Math.round(m.sameWin/m.sameTeam*100) >= 50 ? 'var(--green)' : 'var(--red)' }}>
                              {Math.round(m.sameWin/m.sameTeam*100)}%
                            </span>
                          </div>

                          {/* 같은 팀 라인 선택 디테일 조회 (추가 기능) */}
                          <div style={{ marginTop: 10 }}>
                            <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 8 }}>같은 팀 라인 조합 (직접 라인 선택)</div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                              <select
                                value={sameTeamLineA}
                                onChange={e => {
                                  const v = e.target.value as Line | ''
                                  setSameTeamLineA(v)
                                  if (v && v === sameTeamLineB) setSameTeamLineB('')
                                }}
                                style={{ flex: 1, fontSize: 12 }}
                              >
                                <option value="">{selName} 라인 선택</option>
                                {LINES.map(l => <option key={l} value={l} disabled={l === sameTeamLineB}>{l}{l === sameTeamLineB ? ' (같은 팀에선 불가)' : ''}</option>)}
                              </select>
                              <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>+</span>
                              <select
                                value={sameTeamLineB}
                                onChange={e => {
                                  const v = e.target.value as Line | ''
                                  setSameTeamLineB(v)
                                  if (v && v === sameTeamLineA) setSameTeamLineA('')
                                }}
                                style={{ flex: 1, fontSize: 12 }}
                              >
                                <option value="">{oppName} 라인 선택</option>
                                {LINES.map(l => <option key={l} value={l} disabled={l === sameTeamLineA}>{l}{l === sameTeamLineA ? ' (같은 팀에선 불가)' : ''}</option>)}
                              </select>
                            </div>
                            {sameTeamLineA && sameTeamLineB && (() => {
                              const stm = getDetailedSameTeam(selKey, sameTeamLineA, oppKey, sameTeamLineB)
                              if (stm.total === 0) return <div className="empty">해당 라인 조합으로 같은 팀이었던 적이 없어요.</div>
                              const wr = Math.round(stm.win / stm.total * 100)
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                                  <span style={{ fontSize: 12, flex: 1 }}>
                                    <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{selName}({sameTeamLineA})</span>
                                    <span style={{ color: 'var(--text3)' }}> + </span>
                                    <span style={{ color: 'var(--red)', fontWeight: 600 }}>{oppName}({sameTeamLineB})</span>
                                  </span>
                                  <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600 }}>{stm.win}승</span>
                                  <span style={{ fontSize: 11, color: 'var(--red)', marginLeft: 6 }}>{stm.lose}패</span>
                                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, color: wr >= 50 ? 'var(--green)' : 'var(--red)' }}>
                                    {wr}%
                                  </span>
                                </div>
                              )
                            })()}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}



// ── 명예의 전당 탭 ──────────────────────────────────────────────
