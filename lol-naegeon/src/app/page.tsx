'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { createClient } from '@supabase/supabase-js'
import { TIERS, LINES, getScore, getTierByScore, getScoreByTier, shuffle } from '@/lib/data'
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

const ADMIN_PASSWORD = 'daumathematics'

const DISCORD_WEBHOOK_URL = 'https://discordapp.com/api/webhooks/1517851751976538182/5o_PAydNLLEWPzhbl49GAIszwcMloutO-GWhv25j_KtKLtmiFT5NwuOpSPmWf8J4okBF'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

const LINE_ORDER: Record<string, number> = { 탑: 0, 정글: 1, 미드: 2, 원딜: 3, 서포터: 4 }

// summoners 테이블: { name, line, tier } (name+line 복합키)
// SummonerMap: name -> { line -> tier } (표시용 티어명)
type SummonerMap = Record<string, Record<Line, string>>
// SummonerScoreMap: name -> { line -> score } (실제 포인트, 티어 계산의 기준)
type SummonerScoreMap = Record<string, Record<Line, number>>

// 팀 뽑기용 플레이어 (모스트1/2 포함)
interface PlayerEntry {
  name: string
  most1: Line | 'any'
  most2: Line | 'any' | null
  // 매칭 결정 후 확정 라인/점수
  assignedLine?: Line
  assignedScore?: number
}

function checkPassword(): boolean {
  const input = prompt('보안 코드를 입력해주세요')
  if (input === null) return false
  if (input === ADMIN_PASSWORD) return true
  alert('보안 코드가 올바르지 않아요.')
  return false
}

// 동명이인 구분용: 이름 옆에 아이디 앞 4자리를 작은 회색 글씨로 붙여서 표시
function NameWithIdBadge({ name, idPrefixMap }: { name: string; idPrefixMap: Record<string, string> }) {
  const prefix = idPrefixMap[name]
  return (
    <>
      {name}
      {prefix && <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4 }}>{prefix}</span>}
    </>
  )
}

// 점수 기반 티어 시스템 헬퍼
function tierUp(tier: string): string {
  // 호환용: 기존 코드에서 호출하는 곳이 있다면 다음 티어명 반환 (점수 무관)
  const idx = TIERS.indexOf(tier)
  if (idx <= 0) return TIERS[0]
  return TIERS[idx - 1]
}
function tierDown(tier: string): string {
  const idx = TIERS.indexOf(tier)
  if (idx < 0 || idx >= TIERS.length - 1) return TIERS[TIERS.length - 1]
  return TIERS[idx + 1]
}

function isDia1OrAbove(tier: string): boolean {
  const dia1Tiers = ['다이아1', '마스터 0층', '마스터 1층', '마스터 2층', '마스터 3층', '마스터 4층', '마스터 5층', '마스터 6층', '마스터 7층', '그랜드마스터 8층', '그랜드마스터 9층', '그랜드마스터 10층', '그랜드마스터 11층', '그랜드마스터 12층', '그랜드마스터 13층', '그랜드마스터 14층', '챌린저 15층', '챌린저 16층', '챌린저 17층', '리그오브레전드']
  return dia1Tiers.includes(tier)
}

function isSilver3OrBelowGlobal(tier: string): boolean {
  return ['언랭'].includes(tier)
}

function getConsecutiveLineWins(playerName: string, line: string, records: GameRecord[], n = 2): number {
  const lineRecs = records.filter(r =>
    r.blue.some(p => p.name === playerName && p.line === line) ||
    r.red.some(p => p.name === playerName && p.line === line)
  )
  // 최근 게임부터 확인하여 연속 승리 수 계산
  let streak = 0
  for (const r of lineRecs) {
    const inBlue = r.blue.some(p => p.name === playerName && p.line === line)
    const isWin = (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
    if (isWin) streak++
    else break
  }
  return streak
}

// 다이아1 이상: 마지막 티어UP 이후 연승 계산
function getWinsSinceLastTierUp(playerName: string, line: string, records: GameRecord[], tierHistory: { record_id: number; name: string; line: string; tier_before: string; tier_after: string }[]): number {
  // 해당 라인의 마지막 티어UP 기록 찾기
  const lineUps = tierHistory.filter(h =>
    h.name === playerName && h.line === line &&
    isDia1OrAbove(h.tier_before) &&
    (TIER_SCORES[h.tier_after] ?? 0) > (TIER_SCORES[h.tier_before] ?? 0)
  )

  const lineRecs = records.filter(r =>
    r.blue.some(p => p.name === playerName && p.line === line) ||
    r.red.some(p => p.name === playerName && p.line === line)
  )

  // 마지막 티어UP이 있으면 그 이후 기록만 확인
  let recsToCheck = lineRecs
  if (lineUps.length > 0) {
    const lastUpRecordId = lineUps[lineUps.length - 1].record_id
    const lastUpIdx = lineRecs.findIndex(r => r.id === lastUpRecordId)
    if (lastUpIdx >= 0) {
      recsToCheck = lineRecs.slice(0, lastUpIdx) // records는 최신순이므로
    }
  }

  // 마지막 티어UP 이후 연승 계산
  let streak = 0
  for (const r of recsToCheck) {
    const inBlue = r.blue.some(p => p.name === playerName && p.line === line)
    const isWin = (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
    if (isWin) streak++
    else break
  }
  return streak
}

const TIER_SCORES: Record<string, number> = {
  '언랭': 12, '실버2': 13, '실버1': 14, '골드4': 14, '골드3': 15, '골드2': 16, '골드1': 18,
  '플래티넘4': 19, '플래티넘3': 20, '플래티넘2': 21, '플래티넘1': 23,
  '에메랄드4': 24, '에메랄드3': 26, '에메랄드2': 27, '에메랄드1': 29,
  '다이아4': 31, '다이아3': 33, '다이아2': 35, '다이아1': 36,
  '마스터 0층': 38, '마스터 1층': 39, '마스터 2층': 40, '마스터 3층': 42,
  '마스터 4층': 44, '마스터 5층': 46, '마스터 6층': 48, '마스터 7층': 51,
  '그랜드마스터 8층': 54, '그랜드마스터 9층': 56, '그랜드마스터 10층': 57,
  '그랜드마스터 11층': 58, '그랜드마스터 12층': 59, '그랜드마스터 13층': 60, '그랜드마스터 14층': 60,
  '챌린저 15층': 61, '챌린저 16층': 61, '챌린저 17층': 62, '리그오브레전드': 62,
}

// ── 관리자 탭 ──────────────────────────────────────────────
// ── 관리자 탭 ──────────────────────────────────────────────
function AdminTab({ summoners, summonerScores, records }: { summoners: SummonerMap; summonerScores: SummonerScoreMap; records: GameRecord[] }) {
  const [subTab, setSubTab] = useState<'summoners' | 'inactive'>('summoners')
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editingLine, setEditingLine] = useState<Line | ''>('')
  const [editingTier, setEditingTier] = useState('')
  const [error, setError] = useState('')
  const [inactiveStatusMap, setInactiveStatusMap] = useState<Map<string, boolean>>(new Map())

  const allSummoners = Object.keys(summoners).sort()

  // 14일 이상 미참여자 목록
  const inactiveList = useMemo(() => {
    const now = Date.now()
    const result: { name: string; days: number }[] = []
    for (const name of allSummoners) {
      const lastGame = records.find(r => r.blue.some(p => p.name === name) || r.red.some(p => p.name === name))
      if (!lastGame) continue
      const lastDate = new Date((lastGame as any).created_at ?? '')
      if (isNaN(lastDate.getTime())) continue
      const days = Math.floor((now - lastDate.getTime()) / (1000 * 60 * 60 * 24))
      if (days >= 14) result.push({ name, days })
    }
    return result.sort((a, b) => b.days - a.days)
  }, [allSummoners, records])

  // 페이지 로드 시 DB에서 기존 비활성화 상태 읽어오기
  useEffect(() => {
    const loadInactiveStatus = async () => {
      const { data } = await supabase.from('summoners').select('name, is_inactive').eq('is_inactive', true)
      if (data) {
        const statusMap = new Map<string, boolean>()
        for (const record of data) {
          statusMap.set((record as any).name, true)
        }
        setInactiveStatusMap(statusMap)
      }
    }
    loadInactiveStatus()
  }, [])

  const deleteSummoner = async (name: string) => {
    if (!confirm(`${name}을(를) 완전히 삭제할까요?`)) return
    setError('')
    
    const lines = Object.keys(summoners[name] ?? {})
    for (const line of lines) {
      await supabase.from('summoners').delete().eq('name', name).eq('line', line)
    }
    window.location.reload()
  }

  const toggleInactive = async (name: string, currentInactive: boolean) => {
    const newInactiveStatus = !currentInactive
    // 로컬 상태에 즉시 반영 (UI 업데이트)
    setInactiveStatusMap(prev => new Map(prev).set(name, newInactiveStatus))
    // DB에 저장
    const { error: err } = await supabase
      .from('summoners')
      .update({ is_inactive: newInactiveStatus })
      .eq('name', name)
    if (err) {
      setError('업데이트 실패: ' + err.message)
      // 실패 시 로컬 상태 되돌리기
      setInactiveStatusMap(prev => new Map(prev).set(name, currentInactive))
      return
    }
  }

  const deleteInactivePlayer = async (name: string) => {
    if (!confirm(`${name}을(를) 완전히 삭제할까요?`)) return
    setError('')
    
    const lines = Object.keys(summoners[name] ?? {})
    for (const line of lines) {
      await supabase.from('summoners').delete().eq('name', name).eq('line', line)
    }
    window.location.reload()
  }

  const startEdit = (name: string, line: Line, tier: string) => {
    setEditingName(name)
    setEditingLine(line)
    setEditingTier(tier)
    setError('')
  }

  const saveEdit = async () => {
    if (!editingName || editingLine === '') return
    setError('')

    const { error: err } = await supabase
      .from('summoners')
      .update({ tier: editingTier })
      .eq('name', editingName)
      .eq('line', editingLine)
    
    if (err) {
      setError('업데이트 실패: ' + err.message)
      return
    }

    setEditingName(null)
    setEditingLine('')
    setEditingTier('')
    window.location.reload()
  }

  const cancelEdit = () => {
    setEditingName(null)
    setEditingLine('')
    setEditingTier('')
    setError('')
  }

  return (
    <div>
      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            className={`btn btn-sm${subTab === 'summoners' ? ' btn-gold' : ''}`}
            onClick={() => setSubTab('summoners')}
          >
            소환사 관리
          </button>
          <button
            className={`btn btn-sm${subTab === 'inactive' ? ' btn-gold' : ''}`}
            onClick={() => setSubTab('inactive')}
          >
            장기미접속자 ({inactiveList.length})
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {subTab === 'summoners' && (
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            <div className="card-title" style={{ fontSize: 12, marginBottom: 8 }}>모든 소환사</div>
            {allSummoners.length === 0 ? (
              <div className="empty">등록된 소환사가 없어요</div>
            ) : (
              allSummoners.map(name => (
                <div key={name} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '0.5px solid var(--border2)' }}>
                  <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>{name}</span>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteSummoner(name)}>삭제</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {Object.entries(summoners[name] ?? {}).map(([line, tier]) => (
                      <div key={`${name}-${line}`} style={{
                        background: 'var(--bg3)', padding: '8px 10px', borderRadius: 'var(--radius)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12
                      }}>
                        {editingName === name && editingLine === line ? (
                          <>
                            <span style={{ minWidth: 50 }}>{line}</span>
                            <input
                              type="text"
                              value={editingTier}
                              onChange={e => setEditingTier(e.target.value)}
                              style={{ flex: 1, margin: '0 8px' }}
                              placeholder="티어명"
                            />
                            <button className="btn btn-sm" style={{ marginRight: 4 }} onClick={saveEdit}>저장</button>
                            <button className="btn btn-sm" onClick={cancelEdit}>취소</button>
                          </>
                        ) : (
                          <>
                            <span style={{ minWidth: 50 }}>{line}</span>
                            <span style={{ color: 'var(--text2)' }}>
                              {tier} (점수: {summonerScores[name]?.[line as Line] ?? 0})
                            </span>
                            <button className="btn btn-sm" onClick={() => startEdit(name, line as Line, tier)}>편집</button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {subTab === 'inactive' && (
          <div style={{ maxHeight: 600, overflowY: 'auto' }}>
            <div className="card-title" style={{ fontSize: 12, marginBottom: 8 }}>14일 이상 미참여 ({inactiveList.length}명)</div>
            {inactiveList.length === 0 ? (
              <div className="empty">장기 미접속자가 없어요</div>
            ) : (
              inactiveList.map(({ name, days }: { name: string; days: number }) => {
                const isInactive = inactiveStatusMap.get(name) ?? false
                return (
                  <div key={name} style={{
                    marginBottom: 10, padding: '10px 12px', background: 'var(--bg3)',
                    borderRadius: 'var(--radius)', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <span style={{ fontWeight: 700 }}>{name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>
                        {days}일 미참여
                        {isInactive && <span style={{ marginLeft: 8, color: 'var(--red)', fontWeight: 700 }}>비활성화</span>}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => toggleInactive(name, isInactive)}>
                        {isInactive ? '활성화' : '비활성화'}
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteInactivePlayer(name)}>삭제</button>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 소환사 관리 탭 ──────────────────────────────────────────────
function MyInfoTab({ summoners, summonerScores, onRefresh }: { summoners: SummonerMap; summonerScores: SummonerScoreMap; onRefresh: () => void }) {
  const [loading, setLoading] = useState(true)
  const [displayId, setDisplayId] = useState('')
  const [summonerName, setSummonerName] = useState<string | null>(null)
  const [selectedNewLine, setSelectedNewLine] = useState<Line | ''>('')
  const [selectedNewTier, setSelectedNewTier] = useState('언랭')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')

  const [riotId, setRiotId] = useState('')
  const [pendingLineRequests, setPendingLineRequests] = useState<{ id: number; line: Line; requested_tier: string }[]>([])

  // 인라인 편집 상태: 지금 어떤 필드를 수정 중인지 (한 번에 하나만)
  const [editingField, setEditingField] = useState<'id' | 'password' | 'riot' | null>(null)
  const [saving, setSaving] = useState(false)
  const [fieldError, setFieldError] = useState('')

  const [idInput, setIdInput] = useState('')
  const [riotInput, setRiotInput] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')

  const loadPendingLineRequests = async (name: string) => {
    const { data } = await supabase
      .from('line_change_requests')
      .select('id, line, requested_tier')
      .eq('summoner_name', name)
      .eq('status', 'pending')
    setPendingLineRequests((data ?? []) as { id: number; line: Line; requested_tier: string }[])
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
      if (cancelled) return

      let name: string | null = null
      if (user) {
        // 본인 계정에 연결된 소환사명/롤계정만 조회 (RLS로 보호되어 다른 사람 데이터는 조회 불가)
        const { data } = await supabase
          .from('member_accounts')
          .select('summoner_name, riot_id')
          .eq('user_id', user.id)
          .maybeSingle()
        name = data?.summoner_name ?? null
        if (!cancelled) {
          setSummonerName(name)
          setRiotId(data?.riot_id ?? '')
        }
        if (name && !cancelled) await loadPendingLineRequests(name)
      }

      // 로그인 아이디로 실제 사용하는 값만 표시 (내부 인증키는 노출하지 않음)
      // 신규 가입자는 본인이 정한 아이디, 예전 방식(전화번호) 계정은 전화번호, 레거시 계정은 소환사명이 곧 아이디
      const loginIdMeta = (user?.user_metadata?.login_id ?? user?.user_metadata?.phone) as string | undefined
      if (!cancelled) setDisplayId(loginIdMeta || name || '')

      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  const startEdit = (field: 'id' | 'password' | 'riot') => {
    setEditingField(field)
    setFieldError('')
    setIdInput(displayId)
    setRiotInput(riotId)
    setOldPassword('')
    setNewPassword('')
    setNewPassword2('')
  }

  const cancelEdit = () => {
    setEditingField(null)
    setFieldError('')
  }

  const saveId = async () => {
    const trimmed = idInput.trim()
    if (!isValidLoginId(trimmed)) {
      setFieldError('아이디는 영문/숫자/언더스코어(_)로 5~20자여야 해요')
      return
    }
    if (trimmed.toLowerCase() === displayId.toLowerCase()) {
      setEditingField(null)
      return
    }
    setSaving(true)
    setFieldError('')
    const { error: err } = await supabase.rpc('change_own_login_id', { p_new_login_id: trimmed })
    if (err) {
      setFieldError('변경 실패: ' + err.message)
    } else {
      setDisplayId(trimmed.toLowerCase())
      setEditingField(null)
    }
    setSaving(false)
  }

  const saveRiotId = async () => {
    const trimmed = riotInput.trim()
    if (!trimmed.includes('#')) {
      setFieldError('롤 계정을 "소환사이름#태그" 형식으로 입력해주세요 (예: 임태완#KR1)')
      return
    }
    setSaving(true)
    setFieldError('')
    const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
    if (!user) { setSaving(false); return }
    const { error: err } = await supabase
      .from('member_accounts')
      .update({ riot_id: trimmed })
      .eq('user_id', user.id)
    if (err) {
      setFieldError('저장 실패: ' + err.message)
    } else {
      setRiotId(trimmed)
      setEditingField(null)
    }
    setSaving(false)
  }

  const savePassword = async () => {
    if (!oldPassword || !newPassword || !newPassword2) {
      setFieldError('모든 비밀번호 항목을 입력해주세요')
      return
    }
    if (newPassword.length < 4) {
      setFieldError('새 비밀번호가 너무 짧아요')
      return
    }
    if (newPassword !== newPassword2) {
      setFieldError('새 비밀번호가 서로 일치하지 않아요')
      return
    }
    setSaving(true)
    setFieldError('')

    // 현재 비밀번호 확인 (재로그인 시도로 검증)
    // 아이디를 추측해서 내부 인증키를 재구성하지 않고, 지금 로그인된 세션에 저장된 실제 값을 그대로 사용
    const { data: { session: currentSession } } = await supabase.auth.getSession()
    const currentUser = currentSession?.user ?? null
    if (!currentUser?.email) {
      setFieldError('계정 정보를 확인할 수 없어요. 새로고침 후 다시 시도해주세요.')
      setSaving(false)
      return
    }
    const { error: verifyErr } = await supabase.auth.signInWithPassword({
      email: currentUser.email,
      password: oldPassword,
    })
    if (verifyErr) {
      setFieldError('현재 비밀번호가 일치하지 않아요')
      setSaving(false)
      return
    }

    const { error: updateErr } = await supabase.auth.updateUser({ password: newPassword })
    if (updateErr) {
      setFieldError('변경 실패: ' + updateErr.message)
    } else {
      setEditingField(null)
      alert('비밀번호가 변경됐어요.')
    }
    setSaving(false)
  }

  const myLines: Partial<Record<Line, string>> = summonerName ? (summoners[summonerName] ?? {}) : {}
  const registeredLines = (Object.keys(myLines) as Line[]).sort((a, b) => LINE_ORDER[a] - LINE_ORDER[b])
  const pendingLineNames = pendingLineRequests.map(r => r.line)
  const availableLines = LINES.filter(l => !registeredLines.includes(l) && !pendingLineNames.includes(l))
  const canAddMore = registeredLines.length + pendingLineRequests.length < 5 && availableLines.length > 0

  const addLine = async () => {
    if (!summonerName || !selectedNewLine) return
    if (registeredLines.length + pendingLineRequests.length >= 5) {
      setError('라인은 최대 5개까지만 등록(신청 포함)할 수 있어요.')
      return
    }
    setAdding(true)
    setError('')
    const { error: err } = await supabase.rpc('submit_line_change_request', {
      p_line: selectedNewLine,
      p_tier: selectedNewTier,
    })
    if (err) {
      setError('신청 실패: ' + err.message)
    } else {
      setSelectedNewLine('')
      setSelectedNewTier('언랭')
      await loadPendingLineRequests(summonerName)
    }
    setAdding(false)
  }

  const cancelLineRequest = async (id: number) => {
    if (!summonerName) return
    if (!confirm('이 라인 신청을 취소할까요?')) return
    const { error: err } = await supabase.from('line_change_requests').delete().eq('id', id)
    if (err) setError('취소 실패: ' + err.message)
    else await loadPendingLineRequests(summonerName)
  }

  const [deletingLine, setDeletingLine] = useState<Line | null>(null)

  const deleteLine = async (line: Line) => {
    if (!summonerName) return
    if (registeredLines.length <= 2) {
      setError('라인은 최소 2개는 유지해야 해요.')
      return
    }
    if (!confirm(`${line} 라인을 삭제할까요?`)) return
    setDeletingLine(line)
    setError('')
    const { error: err } = await supabase
      .from('summoners')
      .delete()
      .eq('name', summonerName)
      .eq('line', line)
    if (err) {
      setError('라인 삭제 실패: ' + err.message)
    } else {
      onRefresh()
    }
    setDeletingLine(null)
  }

  if (loading) {
    return <div className="card"><div className="empty">불러오는 중...</div></div>
  }

  if (!summonerName) {
    return (
      <div className="card">
        <div className="empty">계정에 연결된 소환사 정보가 없어요. 관리자에게 문의해주세요.</div>
      </div>
    )
  }

  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }
  const labelStyle: React.CSSProperties = { color: 'var(--text3)', width: 62, flexShrink: 0 }
  const editBtnStyle: React.CSSProperties = { width: 'auto', flexShrink: 0, whiteSpace: 'nowrap', padding: '2px 10px', fontSize: 11 }

  return (
    <div>
      <div className="card">
        <div className="card-title">내 정보</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13 }}>

          {/* 아이디 */}
          {editingField === 'id' ? (
            <div style={rowStyle}>
              <span style={labelStyle}>아이디:</span>
              <input value={idInput} onChange={e => setIdInput(e.target.value)} disabled={saving} style={{ flex: 1 }} />
              <button className="btn btn-gold btn-sm" onClick={saveId} disabled={saving} style={editBtnStyle}>{saving ? '저장 중...' : '저장'}</button>
              <button className="btn btn-sm" onClick={cancelEdit} disabled={saving} style={editBtnStyle}>취소</button>
            </div>
          ) : (
            <div style={rowStyle}>
              <span style={labelStyle}>아이디:</span>
              <span style={{ flex: 1 }}>{displayId}</span>
              <button className="btn btn-sm" onClick={() => startEdit('id')} style={editBtnStyle}>수정</button>
            </div>
          )}

          {/* 비밀번호 */}
          {editingField === 'password' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={rowStyle}>
                <span style={labelStyle}>비밀번호:</span>
                <span style={{ flex: 1, color: 'var(--text3)' }}>변경 중</span>
                <button className="btn btn-gold btn-sm" onClick={savePassword} disabled={saving} style={editBtnStyle}>{saving ? '저장 중...' : '저장'}</button>
                <button className="btn btn-sm" onClick={cancelEdit} disabled={saving} style={editBtnStyle}>취소</button>
              </div>
              <input type="password" placeholder="현재 비밀번호" value={oldPassword} onChange={e => setOldPassword(e.target.value)} disabled={saving} style={{ marginLeft: 70 }} />
              <input type="password" placeholder="새 비밀번호" value={newPassword} onChange={e => setNewPassword(e.target.value)} disabled={saving} style={{ marginLeft: 70 }} />
              <input type="password" placeholder="새 비밀번호 확인" value={newPassword2} onChange={e => setNewPassword2(e.target.value)} disabled={saving} style={{ marginLeft: 70 }} />
            </div>
          ) : (
            <div style={rowStyle}>
              <span style={labelStyle}>비밀번호:</span>
              <span style={{ flex: 1, color: 'var(--text3)' }}>보안을 위해 표시되지 않아요</span>
              <button className="btn btn-sm" onClick={() => startEdit('password')} style={editBtnStyle}>변경</button>
            </div>
          )}

          {/* 소환사명 (수정 불가 — 경기 기록 등 여러 곳에서 식별자로 쓰여서 바꾸면 데이터가 꼬임) */}
          <div style={rowStyle}>
            <span style={labelStyle}>소환사명:</span>
            <strong style={{ flex: 1 }}>{summonerName}</strong>
          </div>

          {/* 롤 계정 */}
          {editingField === 'riot' ? (
            <div style={rowStyle}>
              <span style={labelStyle}>롤 계정:</span>
              <input
                value={riotInput}
                onChange={e => setRiotInput(e.target.value)}
                placeholder="소환사이름#태그 (예: 임태완#KR1)"
                disabled={saving}
                style={{ flex: 1 }}
              />
              <button className="btn btn-gold btn-sm" onClick={saveRiotId} disabled={saving} style={editBtnStyle}>{saving ? '저장 중...' : '저장'}</button>
              <button className="btn btn-sm" onClick={cancelEdit} disabled={saving} style={editBtnStyle}>취소</button>
            </div>
          ) : (
            <div style={rowStyle}>
              <span style={labelStyle}>롤 계정:</span>
              <span style={{ flex: 1 }}>{riotId ? <strong>{riotId}</strong> : <span style={{ color: 'var(--text3)' }}>미입력</span>}</span>
              <button className="btn btn-sm" onClick={() => startEdit('riot')} style={editBtnStyle}>{riotId ? '수정' : '입력'}</button>
            </div>
          )}

          {fieldError && <div className="error">{fieldError}</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-title">내 라인 ({registeredLines.length}/5{pendingLineRequests.length > 0 ? ` · 신청중 ${pendingLineRequests.length}` : ''})</div>
        {registeredLines.length === 0 && pendingLineRequests.length === 0 ? (
          <div className="empty">등록된 라인이 없어요</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: canAddMore ? 12 : 0 }}>
            {registeredLines.map(l => (
              <div key={l} className="player-row" style={{ padding: '6px 10px' }}>
                <span className="badge b-line" style={{ width: 52, textAlign: 'center' }}>{l}</span>
                <span className="badge b-tier" style={{ flex: 1 }}>{myLines[l] ?? '언랭'}</span>
                <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                  {summonerScores[summonerName]?.[l] ?? getScoreByTier(myLines[l] ?? '언랭')}점
                </span>
                {registeredLines.length > 2 && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => deleteLine(l)}
                    disabled={deletingLine === l}
                    style={{ width: 'auto', flexShrink: 0, padding: '2px 8px', fontSize: 10, marginLeft: 6 }}
                  >
                    {deletingLine === l ? '삭제 중...' : '삭제'}
                  </button>
                )}
              </div>
            ))}
            {pendingLineRequests.map(r => (
              <div key={r.id} className="player-row" style={{ padding: '6px 10px', opacity: 0.7 }}>
                <span className="badge b-line" style={{ width: 52, textAlign: 'center' }}>{r.line}</span>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text3)' }}>
                  신청한 티어: {r.requested_tier} · <span style={{ color: 'var(--gold, #d4af37)' }}>승인 대기중</span>
                </span>
                <button
                  className="btn btn-sm"
                  onClick={() => cancelLineRequest(r.id)}
                  style={{ width: 'auto', flexShrink: 0, padding: '2px 8px', fontSize: 10, marginLeft: 6 }}
                >
                  신청 취소
                </button>
              </div>
            ))}
          </div>
        )}

        {canAddMore ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={selectedNewLine} onChange={e => setSelectedNewLine(e.target.value as Line)} style={{ flex: 1 }}>
              <option value="">추가할 라인 선택</option>
              {availableLines.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
            <select value={selectedNewTier} onChange={e => setSelectedNewTier(e.target.value)} style={{ flex: 1 }}>
              {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <button className="btn btn-gold" onClick={addLine} disabled={!selectedNewLine || adding} style={{ width: 'auto', flexShrink: 0, whiteSpace: 'nowrap', padding: '0 16px' }}>
              {adding ? '신청 중...' : '라인 신청'}
            </button>
          </div>
        ) : registeredLines.length + pendingLineRequests.length >= 5 ? (
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>모든 라인을 이미 등록(신청 포함)했어요.</div>
        ) : null}

        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>
          💡 새로 신청한 라인은 관리자 승인 후에 실제로 등록되고, 승인 전까지는 팀편성에서 선택할 수 없어요.
        </div>

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    </div>
  )
}


// ── 투표 섹션 ──────────────────────────────────────────────
// ── 전적 기록 탭 ──────────────────────────────────────────────
function RecordTab({ records, onDelete, onClear, isAdmin }: {
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
function StatsTab({ records, summoners, summonerScores, tierHistory, idPrefixMap }: {
  records: GameRecord[]
  summoners: SummonerMap
  summonerScores: SummonerScoreMap
  tierHistory: { record_id: number; name: string; line: string; tier_before: string; tier_after: string }[]
  idPrefixMap: Record<string, string>
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [openGraphLine, setOpenGraphLine] = useState<string | null>(null)
  const [oppSearch, setOppSearch] = useState('')
  const [oppSelected, setOppSelected] = useState<string | null>(null)
  const [oppSuggestions, setOppSuggestions] = useState<string[]>([])
  const [detailLineA, setDetailLineA] = useState<Line | ''>('')
  const [detailLineB, setDetailLineB] = useState<Line | ''>('')
  const [sameTeamLineA, setSameTeamLineA] = useState<Line | ''>('')
  const [sameTeamLineB, setSameTeamLineB] = useState<Line | ''>('')

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
    setOppSelected(null)
    setOppSearch('')
  }

  // 선택된 소환사 통계 계산
  // 상대전적 계산 (MatchupTab 로직 통합)
  const getMatchup = (nameA: string, nameB: string) => {
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
      if (aInBlue === bInBlue) { sameTeam++; if (aWins) sameWin++ }
      else { oppose++; if (aWins) aWin++; else bWin++ }
    })
    return { total: matched.length, aWin, bWin, sameTeam, oppose, sameWin }
  }

  // 라인을 직접 선택해서 보는 디테일 맞대결 조회 (기존 getMatchup과 별개, 추가 기능)
  // nameA가 lineA 라인, nameB가 lineB 라인으로 서로 다른 팀에서 만났을 때의 전적
  const getDetailedMatchup = (nameA: string, lineA: Line, nameB: string, lineB: Line) => {
    let total = 0, aWin = 0, bWin = 0
    records.forEach(r => {
      const aEntry = [...r.blue, ...r.red].find(p => p.name === nameA && p.line === lineA)
      const bEntry = [...r.blue, ...r.red].find(p => p.name === nameB && p.line === lineB)
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
  // nameA가 lineA 라인, nameB가 lineB 라인으로 같은 팀일 때의 전적
  const getDetailedSameTeam = (nameA: string, lineA: Line, nameB: string, lineB: Line) => {
    let total = 0, win = 0
    records.forEach(r => {
      const aEntry = [...r.blue, ...r.red].find(p => p.name === nameA && p.line === lineA)
      const bEntry = [...r.blue, ...r.red].find(p => p.name === nameB && p.line === lineB)
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
  const getLineStreak = (name: string, line: string) => {
    const lineRecs = records.filter(r =>
      r.blue.some(p => p.name === name && p.line === line) ||
      r.red.some(p => p.name === name && p.line === line)
    )
    if (lineRecs.length === 0) return 0
    const results = lineRecs.map(r => {
      const inBlue = r.blue.some(p => p.name === name && p.line === line)
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

  // 티어 히스토리 그래프 (해당 소환사 + 라인별)
  const getTierGraph = (name: string) => {
    const twoWeeksAgo = new Date()
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)
    const history = tierHistory
      .filter(h => {
        if (h.name !== name) return false
        const createdAt = (h as any).created_at
        if (!createdAt) return true // created_at 없으면 포함
        return new Date(createdAt) >= twoWeeksAgo
      })
      .slice()
      .reverse()
    return history
  }

  const fmtDate = (dateStr: string) => {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return ''
    return `${d.getMonth() + 1}/${d.getDate()}`
  }

  // 티어 점수 (그래프용 간단 수치)
  const TIER_SCORE: Record<string, number> = {
    '언랭': 1, '실버2': 2, '실버1': 3, '골드4': 4, '골드3': 5, '골드2': 6, '골드1': 7,
    '플래티넘4': 8, '플래티넘3': 9, '플래티넘2': 10, '플래티넘1': 11,
    '에메랄드4': 12, '에메랄드3': 13, '에메랄드2': 14, '에메랄드1': 15,
    '다이아4': 16, '다이아3': 17, '다이아2': 18, '다이아1': 19,
    '마스터 0층': 20, '마스터 1층': 21, '마스터 2층': 22, '마스터 3층': 23,
    '마스터 4층': 24, '마스터 5층': 25, '마스터 6층': 26, '마스터 7층': 27,
    '그랜드마스터 8층': 28, '그랜드마스터 9층': 29, '그랜드마스터 10층': 30,
    '그랜드마스터 11층': 31, '그랜드마스터 12층': 32, '그랜드마스터 13층': 33,
    '그랜드마스터 14층': 34, '챌린저 15층': 35, '챌린저 16층': 36,
    '챌린저 17층': 37, '리그오브레전드': 38,
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
            {selected && <button className="btn btn-sm" onClick={() => { setSearch(''); setSelected(null); setSuggestions([]); setOppSearch(''); setOppSelected(null); setOppSuggestions([]) }}>초기화</button>}
          </div>
          {suggestions.length > 0 && (
            <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden' }}>
              {suggestions.map(s => (
                <div key={s} onClick={() => selectName(s)} style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg2)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  <NameWithIdBadge name={s} idPrefixMap={idPrefixMap} />
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

          // 마지막 게임 날짜 계산 (records는 최신순 정렬되어 있음)
          const lastGame = records.find(r => r.blue.some(p => p.name === selected) || r.red.some(p => p.name === selected))
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
                  <span style={{ fontWeight: 700, fontSize: 15, flex: '0 0 100px' }}>{selected}</span>
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

              {/* 티어 히스토리 그래프 - 라인별 버튼으로 통합됨 */}
              {tierGraph.length > 0 && false && (
                <div style={{ padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>티어 변동 히스토리</div>
                  {/* 라인별로 그룹화 */}
                  {(Array.from(new Set(tierGraph.map(h => h.line))) as string[]).map(line => {
                    const lineHistory = tierGraph.filter(h => h.line === line)
                    const currentTier = (selected ? summoners[selected]?.[line as Line] : null) ?? lineHistory[lineHistory.length - 1]?.tier_after ?? ''

                    // 게임 참여 순서대로 포인트 생성
                    // 시작점: 첫 변동의 tier_before
                    const pts: { score: number; tier: string; date: string; up: boolean | null }[] = []
                    if (lineHistory.length > 0) {
                      pts.push({
                        score: TIER_SCORE[lineHistory[0].tier_before] ?? 5,
                        tier: lineHistory[0].tier_before,
                        date: fmtDate((lineHistory[0] as any).created_at ?? ''),
                        up: null
                      })
                    }
                    lineHistory.forEach(h => {
                      const after = TIER_SCORE[h.tier_after] ?? 5
                      const before = TIER_SCORE[h.tier_before] ?? 5
                      pts.push({
                        score: after,
                        tier: h.tier_after,
                        date: fmtDate((h as any).created_at ?? ''),
                        up: after > before
                      })
                    })

                    if (pts.length === 0) return null
                    const minScore = Math.min(...pts.map(p => p.score)) - 1
                    const maxScore = Math.max(...pts.map(p => p.score)) + 1
                    const range = maxScore - minScore || 1
                    const W = Math.max(280, pts.length * 36)
                    const H = 70
                    const svgPts = pts.map((p, i) => ({
                      x: pts.length === 1 ? W/2 : (i / (pts.length - 1)) * W,
                      y: H - ((p.score - minScore) / range) * H,
                      p
                    }))
                    const pathD = svgPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

                    return (
                      <div key={line} style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                          <span className="badge b-line" style={{ fontSize: 10 }}>{line}</span>
                          <span style={{ fontSize: 11, color: 'var(--text2)' }}>현재</span>
                          <span className="badge b-tier" style={{ fontSize: 10 }}>{currentTier}</span>
                          <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4 }}>{lineHistory.length}번 변동 · 최근 2주</span>
                        </div>
                        <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
                          <svg width={W} height={H + 34} style={{ overflow: 'visible', display: 'block', minWidth: W }}>
                            {[0, 0.5, 1].map((t, i) => (
                              <line key={i} x1={0} y1={H * t} x2={W} y2={H * t}
                                stroke="rgba(80,130,190,0.08)" strokeWidth={1} />
                            ))}
                            <path d={pathD} fill="none" stroke="rgba(11,196,227,0.5)" strokeWidth={2} />
                            {svgPts.map((sp, i) => {
                              const isStart = sp.p.up === null
                              const color = isStart ? 'var(--text3)' : sp.p.up ? 'var(--green)' : 'var(--red)'
                              return (
                                <g key={i}>
                                  <circle cx={sp.x} cy={sp.y} r={isStart ? 3 : 5}
                                    fill={color} stroke="var(--bg)" strokeWidth={1.5} />
                                  <text x={sp.x} y={sp.y - 9} textAnchor="middle"
                                    fontSize={7} fill={color}>
                                    {sp.p.tier.replace('플래티넘','플').replace('에메랄드','에').replace('실버','실').replace('골드','골').replace(' 이하','↓')}
                                  </text>
                                  <text x={sp.x} y={H + 20} textAnchor="middle"
                                    fontSize={7} fill="var(--text3)">{sp.p.date}</text>
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

                const lineStreak = selected ? getLineStreak(selected, l) : 0
                const lineHistory = tierGraph.filter(h => h.line === l)
                const isGraphOpen = openGraphLine === l
                const hasGraph = lineHistory.length > 0

                // 날짜별 1포인트 그래프 데이터
                const graphPts: { score: number; tier: string; date: string; up: boolean | null }[] = []
                if (lineHistory.length > 0) {
                  graphPts.push({ score: TIER_SCORE[lineHistory[0].tier_before] ?? 5, tier: lineHistory[0].tier_before, date: fmtDate((lineHistory[0] as any).created_at ?? ''), up: null })
                  lineHistory.forEach(h => {
                    graphPts.push({ score: TIER_SCORE[h.tier_after] ?? 5, tier: h.tier_after, date: fmtDate((h as any).created_at ?? ''), up: (TIER_SCORE[h.tier_after] ?? 5) > (TIER_SCORE[h.tier_before] ?? 5) })
                  })
                }
                const minS = graphPts.length > 0 ? Math.min(...graphPts.map(p => p.score)) - 1 : 0
                const maxS = graphPts.length > 0 ? Math.max(...graphPts.map(p => p.score)) + 1 : 10
                const rng = maxS - minS || 1
                const GW = Math.max(260, graphPts.length * 40), GH = 65
                const svgPts = graphPts.map((p, i) => ({
                  x: graphPts.length === 1 ? GW/2 : (i / (graphPts.length - 1)) * GW,
                  y: GH - ((p.score - minS) / rng) * GH,
                  p
                }))
                const pathD = svgPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

                return (
                  <div key={l} style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)', marginBottom: 6, overflow: 'hidden' }}>
                    <div style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                        <span className="badge b-line">{l}</span>
                        {selected && summoners[selected]?.[l] && (
                          <>
                            <span className="badge b-tier">{summoners[selected][l]}</span>
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>{summonerScores[selected]?.[l] ?? '-'}점</span>
                          </>
                        )}
                        <span className="badge b-win" style={{ fontSize: 10 }}>{ls.win}승</span>
                        <span className="badge b-lose" style={{ fontSize: 10 }}>{ls.lose}패</span>
                        <span style={{ fontSize: 11, color: 'var(--text2)' }}>{lTotal}판</span>

                        <span style={{ marginLeft: 'auto', fontSize: 13, fontWeight: 600, color: lWr >= 50 ? 'var(--green)' : 'var(--red)' }}>{lWr}%</span>
                        {hasGraph && (
                          <button onClick={() => setOpenGraphLine(isGraphOpen ? null : l)} style={{
                            padding: '3px 8px', fontSize: 10, border: `1px solid ${isGraphOpen ? 'var(--gold)' : 'rgba(200,155,60,0.35)'}`,
                            borderRadius: 3, background: isGraphOpen ? 'rgba(200,155,60,0.12)' : 'rgba(200,155,60,0.04)',
                            color: 'var(--gold)', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0
                          }}>
                            📈 티어그래프 {isGraphOpen ? '▲' : '▼'}
                          </button>
                        )}
                      </div>
                      {/* 최근 5판 + 라인 연승/연패 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, color: 'var(--text3)' }}>최근</span>
                        <OX results={ls.recent} />
                        {getStreakDisplay(lineStreak)}
                      </div>
                    </div>
                    {/* 티어 그래프 */}
                    {isGraphOpen && hasGraph && (
                      <div style={{ padding: '0 12px 12px', borderTop: '0.5px solid var(--border)' }}>
                        <div style={{ fontSize: 10, color: 'var(--text3)', margin: '8px 0 6px', letterSpacing: '0.05em' }}>게임 참여일 기준 · 최근 2주</div>
                        <div style={{ overflowX: 'auto' }}>
                          <svg width={GW} height={GH + 32} style={{ overflow: 'visible', display: 'block' }}>
                            {[0, 0.5, 1].map((t, i) => (
                              <line key={i} x1={0} y1={GH * t} x2={GW} y2={GH * t} stroke="rgba(80,130,190,0.08)" strokeWidth={1} />
                            ))}
                            <path d={pathD} fill="none" stroke="rgba(11,196,227,0.5)" strokeWidth={2} />
                            {svgPts.map((sp, i) => {
                              const isStart = sp.p.up === null
                              const col = isStart ? '#3a5a78' : sp.p.up ? 'var(--green)' : 'var(--red)'
                              return (
                                <g key={i}>
                                  <circle cx={sp.x} cy={sp.y} r={isStart ? 3 : 5} fill={col} stroke="var(--bg)" strokeWidth={1.5} />
                                  <text x={sp.x} y={sp.y - 8} textAnchor="middle" fontSize={7} fill={col}>
                                    {sp.p.tier.replace('플래티넘','플').replace('에메랄드','에').replace('실버','실').replace('골드','골').replace(' 이하','↓')}
                                  </text>
                                  <text x={sp.x} y={GH + 20} textAnchor="middle" fontSize={7} fill="#3a5a78">{sp.p.date}</text>
                                </g>
                              )
                            })}
                          </svg>
                        </div>
                      </div>
                    )}
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
                    setOppSuggestions(v ? allNames.filter(n => n.includes(v) && n !== selected).slice(0, 5) : [])
                  }} placeholder="상대 소환사 검색" autoComplete="off" style={{ width: '100%' }} />
                  {oppSuggestions.length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10, background: 'var(--bg3)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)', marginTop: 2, overflow: 'hidden' }}>
                      {oppSuggestions.map(s => (
                        <div key={s} onClick={() => { setOppSelected(s); setOppSearch(s); setOppSuggestions([]) }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
                          onMouseEnter={e2 => (e2.currentTarget.style.background = 'var(--bg2)')}
                          onMouseLeave={e2 => (e2.currentTarget.style.background = 'transparent')}><NameWithIdBadge name={s} idPrefixMap={idPrefixMap} /></div>
                      ))}
                    </div>
                  )}
                </div>
                {!oppSearch.trim() && <div style={{ fontSize: 12, color: 'var(--text3)' }}>상대 소환사를 검색해보세요</div>}
                {oppSelected && (() => {
                  const m = getMatchup(selected!, oppSelected)
                  if (m.total === 0) return <div className="empty">함께한 게임이 없어요.</div>
                  return (
                    <div>
                      {m.oppose > 0 && (
                        <div style={{ marginBottom: 10 }}>
                          <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 6 }}>맞대결</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                            <div style={{ flex: 1, textAlign: 'right' }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--blue)' }}>{selected}</div>
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
                              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>{oppSelected}</div>
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
                                <option value="">{selected} 라인 선택</option>
                                {LINES.map(l => <option key={l} value={l}>{l}</option>)}
                              </select>
                              <span style={{ fontSize: 11, color: 'var(--text3)', flexShrink: 0 }}>vs</span>
                              <select
                                value={detailLineB}
                                onChange={e => setDetailLineB(e.target.value as Line | '')}
                                style={{ flex: 1, fontSize: 12 }}
                              >
                                <option value="">{oppSelected} 라인 선택</option>
                                {LINES.map(l => <option key={l} value={l}>{l}</option>)}
                              </select>
                            </div>
                            {detailLineA && detailLineB && (() => {
                              const dm = getDetailedMatchup(selected!, detailLineA, oppSelected, detailLineB)
                              if (dm.total === 0) return <div className="empty">해당 라인 조합으로 맞붙은 적이 없어요.</div>
                              const wr = Math.round(dm.aWin / dm.total * 100)
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                                  <div style={{ flex: 1, textAlign: 'right' }}>
                                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--blue)' }}>{selected}</div>
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
                                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--red)' }}>{oppSelected}</div>
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
                              <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{selected}</span>
                              <span style={{ color: 'var(--text3)' }}> + </span>
                              <span style={{ color: 'var(--red)', fontWeight: 600 }}>{oppSelected}</span>
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
                                <option value="">{selected} 라인 선택</option>
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
                                <option value="">{oppSelected} 라인 선택</option>
                                {LINES.map(l => <option key={l} value={l} disabled={l === sameTeamLineA}>{l}{l === sameTeamLineA ? ' (같은 팀에선 불가)' : ''}</option>)}
                              </select>
                            </div>
                            {sameTeamLineA && sameTeamLineB && (() => {
                              const stm = getDetailedSameTeam(selected!, sameTeamLineA, oppSelected, sameTeamLineB)
                              if (stm.total === 0) return <div className="empty">해당 라인 조합으로 같은 팀이었던 적이 없어요.</div>
                              const wr = Math.round(stm.win / stm.total * 100)
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'var(--bg3)', borderRadius: 'var(--radius)', border: '0.5px solid var(--border)' }}>
                                  <span style={{ fontSize: 12, flex: 1 }}>
                                    <span style={{ color: 'var(--blue)', fontWeight: 600 }}>{selected}({sameTeamLineA})</span>
                                    <span style={{ color: 'var(--text3)' }}> + </span>
                                    <span style={{ color: 'var(--red)', fontWeight: 600 }}>{oppSelected}({sameTeamLineB})</span>
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


// ── 명예의 전당 탭 ──────────────────────────────────────────────
function HallOfFameTab({ records }: { records: GameRecord[] }) {
  const totalGames = records.length
  const minGames = 70 // 전체 70판 이상
  const minLineGames = 30 // 라인별 30판 이상

  // 라인별 승률 집계
  const lineMap: Record<string, Record<string, { win: number; lose: number }>> = {}
  LINES.forEach(l => { lineMap[l] = {} })

  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    winners.forEach(p => {
      if (!lineMap[p.line][p.name]) lineMap[p.line][p.name] = { win: 0, lose: 0 }
      lineMap[p.line][p.name].win++
    })
    losers.forEach(p => {
      if (!lineMap[p.line][p.name]) lineMap[p.line][p.name] = { win: 0, lose: 0 }
      lineMap[p.line][p.name].lose++
    })
  })

  const medals = ['🥇', '🥈', '🥉']
  const medalColors = ['#FFD700', '#C0C0C0', '#CD7F32']
  const medalBg = ['rgba(255,215,0,0.07)', 'rgba(192,192,192,0.05)', 'rgba(205,127,50,0.05)']
  const medalBorder = ['rgba(255,215,0,0.25)', 'rgba(192,192,192,0.2)', 'rgba(205,127,50,0.18)']

  const getLineTop3 = (line: Line) => {
    return Object.entries(lineMap[line])
      .filter(([, s]) => s.win + s.lose >= minLineGames)
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
              : top3.map(([name, s], i) => {
                const total = s.win + s.lose
                const wr = Math.round(s.win / total * 100)
                const loseRate = Math.round(s.lose / total * 100)
                return (
                  <div key={name} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', borderRadius: 'var(--radius)',
                    marginBottom: 4,
                    background: medalBg[i],
                    border: `1px solid ${medalBorder[i]}`,
                  }}>
                    <span style={{ fontSize: 16, width: 22, flexShrink: 0 }}>{medals[i]}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: '#c8d8e8', flex: 1 }}>{name}</span>
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
function RankingTab({ records }: { records: GameRecord[] }) {
  const [page, setPage] = useState(1)
  const PAGE_SIZE = 10

  const playerMap: Record<string, { win: number; lose: number }> = {}
  records.forEach(r => {
    const winners = r.winner === 'blue' ? r.blue : r.red
    const losers = r.winner === 'blue' ? r.red : r.blue
    ;[...winners, ...losers].forEach(p => { if (!playerMap[p.name]) playerMap[p.name] = { win: 0, lose: 0 } })
    winners.forEach(p => playerMap[p.name].win++)
    losers.forEach(p => playerMap[p.name].lose++)
  })

  const entries = Object.entries(playerMap)
    .filter(([, s]) => s.win + s.lose >= 70)
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
        : pagedEntries.map(([name, s], i) => {
          const globalIdx = (page - 1) * PAGE_SIZE + i
          const total = s.win + s.lose
          const wr = Math.round(s.win / total * 100)
          const medal = medals[globalIdx] ?? null
          const isTop3 = globalIdx < 3

          return (
            <div key={name} style={{
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
              <span style={{ fontWeight: 700, fontSize: 14, flex: '0 0 90px' }}>{name}</span>
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
const LOGIN_ID_REGEX = /^[A-Za-z0-9_]{5,20}$/

function isValidLoginId(raw: string): boolean {
  return LOGIN_ID_REGEX.test(raw.trim())
}

// 아이디 → 계정 시스템에 등록할 내부 인증키로 변환
// (관리자 승인 시 DB 함수(approve_signup_request)가 만드는 계정과 동일한 규칙이어야 함)
function loginIdToAuthKey(id: string): string {
  return `${id.trim().toLowerCase()}@id.lol-naegeon.local`
}

// 예전에는 숫자로만 된 아이디 체계를 썼음(010/011/016/017/018/019로 시작하는 11자리 숫자, 하이픈 유무 무관)
// — 그 시기에 만들어진 계정들의 로그인 호환을 위해 유지
const OLD_NUMERIC_ID_REGEX = /^01[016789]\d{7,8}$/

function normalizeNumericId(raw: string): string {
  return raw.replace(/[^0-9]/g, '')
}

function isOldNumericId(raw: string): boolean {
  return OLD_NUMERIC_ID_REGEX.test(normalizeNumericId(raw))
}

function oldNumericIdToAuthKey(id: string): string {
  return `${normalizeNumericId(id)}@phone.lol-naegeon.local`
}

// 문자열 → UTF-8 hex (Postgres의 encode(convert_to(text,'UTF8'),'hex')와 동일한 결과)
// 아주 예전 레거시 계정(아이디=소환사명)을 내부 인증키로 안전하게 변환하기 위함
function toHexUtf8(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// 소환사명(레거시 계정 아이디) → 내부 인증키
// SQL 마이그레이션(create-legacy-accounts.js)에서 생성한 계정과 동일한 규칙(hex 인코딩)을 사용해야 함
function nameToAuthKey(name: string): string {
  return `${toHexUtf8(name.trim())}@name.lol-naegeon.local`
}

// 로그인 화면의 "아이디" 입력값 → 실제 인증에 쓸 내부 키
// 자유 아이디 형식이면 신규 계정 방식으로, 예전 숫자형 아이디 형식이면 구버전 방식(하위호환)으로,
// 그 외(소환사명 등)는 레거시 계정 방식으로 변환
function idToAuthKey(id: string): string {
  const trimmed = id.trim()
  if (isOldNumericId(trimmed)) return oldNumericIdToAuthKey(trimmed)
  if (isValidLoginId(trimmed)) return loginIdToAuthKey(trimmed)
  return nameToAuthKey(trimmed)
}


// ── 개인정보 수집·이용 동의 상세 내용 ──────────────────────────────────
const PRIVACY_CONSENT_DETAIL = `[개인정보 수집·이용 동의]

1. 수집하는 개인정보 항목
   - 필수 항목: 아이디, 비밀번호(암호화 저장), 소환사명(인게임 닉네임), 롤 계정(소환사이름#태그)

2. 개인정보의 수집 및 이용 목적
   - 회원 식별 및 로그인 인증
   - 서비스(내전 매니저) 이용에 따른 본인 확인
   - 부정 이용 방지 및 문의 대응

3. 개인정보의 보유 및 이용 기간
   - 회원 탈퇴 시까지 보유하며, 탈퇴 즉시 파기합니다.
   - 단, 관계 법령에 따라 보존할 의무가 있는 경우 해당 법령이 정한 기간 동안 보관합니다.

4. 동의 거부 권리 및 불이익 안내
   - 귀하는 개인정보 수집·이용에 대한 동의를 거부할 권리가 있습니다.
   - 다만, 필수 항목에 대한 동의를 거부할 경우 회원가입 및 서비스 이용이 제한될 수 있습니다.

5. 기타
   - 수집된 개인정보는 명시된 목적 외 다른 용도로 사용되지 않으며, 본인 동의 없이 제3자에게 제공하지 않습니다.`

// ── 로그인 페이지 ──────────────────────────────────────────────
function LoginPage({ onAuthSuccess }: { onAuthSuccess: () => void }) {
  // 로그인: 자유 아이디(승인된 신규 계정) 또는 소환사명(레거시 계정) 둘 다 입력 가능
  const [loginId, setLoginId] = useState('')
  // 가입 신청 시 사용할 아이디 (영문/숫자/언더스코어 5~20자)
  const [newLoginId, setNewLoginId] = useState('')
  const [password, setPassword] = useState('')
  const [isSignUp, setIsSignUp] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [showConsentDetail, setShowConsentDetail] = useState(false)

  // 비밀번호 찾기(초기화)
  const [showFindPassword, setShowFindPassword] = useState(false)
  const [findLoginId, setFindLoginId] = useState('')
  const [findSummonerName, setFindSummonerName] = useState('')
  const [findRiotId, setFindRiotId] = useState('')
  const [findLoading, setFindLoading] = useState(false)
  const [findMessage, setFindMessage] = useState('')
  const [findError, setFindError] = useState('')

  const handleFindPassword = async () => {
    if (!findLoginId.trim() || !findSummonerName.trim() || !findRiotId.trim()) {
      setFindError('아이디, 소환사명, 롤계정을 모두 입력해주세요')
      return
    }
    setFindLoading(true)
    setFindError('')
    setFindMessage('')
    const { error: err } = await supabase.rpc('reset_password_to_default', {
      p_login_id: findLoginId.trim(),
      p_summoner_name: findSummonerName.trim(),
      p_riot_id: findRiotId.trim(),
    })
    if (err) {
      setFindError(err.message)
    } else {
      setFindMessage('비밀번호가 1234로 초기화됐어요. 로그인 후 반드시 새 비밀번호로 변경해주세요.')
      setFindLoginId('')
      setFindSummonerName('')
      setFindRiotId('')
    }
    setFindLoading(false)
  }

  // 가입 신청 시 소환사 연결 정보
  const [summonerName, setSummonerName] = useState('')
  const [riotId, setRiotId] = useState('')
  const [m1Line, setM1Line] = useState<Line>(LINES[0])
  const [m1Tier, setM1Tier] = useState('골드2')
  const [m2Line, setM2Line] = useState<Line>(LINES[1])
  const [m2Tier, setM2Tier] = useState('골드2')

  const resetSignUpFields = () => {
    setNewLoginId('')
    setPassword('')
    setAgreed(false)
    setShowConsentDetail(false)
    setSummonerName('')
    setRiotId('')
    setM1Line(LINES[0])
    setM1Tier('골드2')
    setM2Line(LINES[1])
    setM2Tier('골드2')
  }

  const handleLogin = async () => {
    if (!loginId || !password) {
      setError('아이디와 비밀번호를 입력해주세요')
      return
    }
    setLoading(true)
    setError('')
    try {
      const { error: loginErr } = await supabase.auth.signInWithPassword({
        email: idToAuthKey(loginId),
        password,
      })
      if (loginErr) {
        setError('로그인 실패: 아이디 또는 비밀번호를 확인해주세요')
        setLoading(false)
        return
      }
      onAuthSuccess()
    } catch (err) {
      setError('오류 발생: ' + (err as any).message)
    }
    setLoading(false)
  }

  const handleSignUp = async () => {
    const n = summonerName.trim()
    const r = riotId.trim()
    if (!newLoginId || !password || !n || !r) {
      setError('아이디, 비밀번호, 소환사명, 롤 계정을 모두 입력해주세요')
      return
    }
    if (!isValidLoginId(newLoginId)) {
      setError('아이디는 영문/숫자/언더스코어(_)로 5~20자여야 해요')
      return
    }
    if (!r.includes('#')) {
      setError('롤 계정을 "소환사이름#태그" 형식으로 입력해주세요 (예: 임태완#KR1)')
      return
    }
    if (m1Line === m2Line) {
      setError('M1 라인과 M2 라인은 서로 다르게 선택해주세요')
      return
    }
    if (!agreed) {
      setError('개인정보 수집·이용에 동의해야 가입 신청이 가능해요')
      return
    }

    setLoading(true)
    setError('')

    try {
      // 계정을 바로 만들지 않고 "가입 신청"으로 접수 — 관리자가 롤 계정을 확인하고 승인 후 실제 계정이 생성됨
      const { error: reqErr } = await supabase.rpc('submit_signup_request', {
        p_login_id: newLoginId.trim(),
        p_password: password,
        p_summoner_name: n,
        p_riot_id: r,
        p_m1_line: m1Line,
        p_m1_tier: m1Tier,
        p_m2_line: m2Line,
        p_m2_tier: m2Tier,
      })
      if (reqErr) {
        setError('가입 신청 실패: ' + reqErr.message)
        setLoading(false)
        return
      }

      alert('가입 신청이 접수됐어요! 관리자 승인 후 로그인할 수 있어요.')
      setIsSignUp(false)
      resetSignUpFields()
    } catch (err) {
      setError('오류 발생: ' + (err as any).message)
    }
    setLoading(false)
  }

  const handleAuth = () => (isSignUp ? handleSignUp() : handleLogin())

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center',
      background: 'linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%)', padding: 20
    }}>
      <div style={{
        background: 'var(--bg2)', border: '0.5px solid var(--border2)', borderRadius: 'var(--radius)',
        padding: 30, width: 340, boxShadow: '0 10px 40px rgba(0,0,0,0.3)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 28, fontWeight: 700, marginBottom: 6 }}>⚔ 내전 매니저</div>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>로그인 / 가입 신청</div>
        </div>

        {!isSignUp && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <input
              type="text"
              placeholder="아이디 (또는 소환사명)"
              value={loginId}
              onChange={e => setLoginId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAuth()}
              disabled={loading}
            />
            <input
              type="password"
              placeholder="비밀번호"
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAuth()}
              disabled={loading}
            />
            <div style={{ textAlign: 'right' }}>
              <span
                onClick={() => { setShowFindPassword(v => !v); setFindError(''); setFindMessage('') }}
                style={{ fontSize: 11, color: 'var(--text3)', textDecoration: 'underline', cursor: 'pointer' }}
              >
                비밀번호를 잊으셨나요?
              </span>
            </div>

            {showFindPassword && (
              <div style={{
                padding: 10, background: 'var(--bg1, rgba(0,0,0,0.2))', border: '0.5px solid var(--border2)',
                borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 8
              }}>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                  아이디, 소환사명, 롤계정을 입력하면 비밀번호가 <strong>1234</strong>로 초기화돼요. 로그인 후 반드시 새 비밀번호로 변경해야 해요.
                </div>
                <input
                  type="text"
                  placeholder="아이디"
                  value={findLoginId}
                  onChange={e => setFindLoginId(e.target.value)}
                  disabled={findLoading}
                />
                <input
                  type="text"
                  placeholder="소환사명"
                  value={findSummonerName}
                  onChange={e => setFindSummonerName(e.target.value)}
                  disabled={findLoading}
                />
                <input
                  type="text"
                  placeholder="롤 계정 (예: 임태완#KR1)"
                  value={findRiotId}
                  onChange={e => setFindRiotId(e.target.value)}
                  disabled={findLoading}
                />
                <button className="btn btn-gold btn-sm" onClick={handleFindPassword} disabled={findLoading}>
                  {findLoading ? '처리 중...' : '비밀번호 초기화'}
                </button>
                {findError && <div className="error">{findError}</div>}
                {findMessage && <div style={{ fontSize: 12, color: 'var(--gold, #d4af37)' }}>{findMessage}</div>}
              </div>
            )}
          </div>
        )}

        {isSignUp && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <input
              type="text"
              placeholder="아이디 (영문/숫자/_ 5~20자)"
              value={newLoginId}
              onChange={e => setNewLoginId(e.target.value)}
              disabled={loading}
              maxLength={20}
            />
            <input
              type="password"
              placeholder="비밀번호"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loading}
            />
            <input
              type="text"
              placeholder="소환사명 (인게임 이름)"
              value={summonerName}
              onChange={e => setSummonerName(e.target.value)}
              disabled={loading}
            />
            <input
              type="text"
              placeholder="롤 계정 (예: 임태완#KR1)"
              value={riotId}
              onChange={e => setRiotId(e.target.value)}
              disabled={loading}
            />

            <div style={{ display: 'flex', gap: 8 }}>
              <select value={m1Line} onChange={e => setM1Line(e.target.value as Line)} disabled={loading} style={{ flex: 1 }}>
                {LINES.map(l => <option key={l} value={l}>M1: {l}</option>)}
              </select>
              <select value={m1Tier} onChange={e => setM1Tier(e.target.value)} disabled={loading} style={{ flex: 1 }}>
                {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <select value={m2Line} onChange={e => setM2Line(e.target.value as Line)} disabled={loading} style={{ flex: 1 }}>
                {LINES.filter(l => l !== m1Line).map(l => <option key={l} value={l}>M2: {l}</option>)}
              </select>
              <select value={m2Tier} onChange={e => setM2Tier(e.target.value)} disabled={loading} style={{ flex: 1 }}>
                {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
        )}

        {isSignUp && (
          <div style={{ marginBottom: 16 }}>
            <label style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              fontSize: 12, color: 'var(--text2)', cursor: 'pointer'
            }}>
              <input
                type="checkbox"
                checked={agreed}
                onChange={e => setAgreed(e.target.checked)}
                disabled={loading}
                style={{ marginTop: 2 }}
              />
              <span>
                (필수) 개인정보 수집·이용에 동의합니다.{' '}
                <span
                  onClick={(e) => { e.preventDefault(); setShowConsentDetail(v => !v) }}
                  style={{ color: 'var(--gold, #d4af37)', textDecoration: 'underline', cursor: 'pointer' }}
                >
                  {showConsentDetail ? '내용 접기' : '자세히보기'}
                </span>
              </span>
            </label>

            {showConsentDetail && (
              <div style={{
                marginTop: 8, padding: 10, fontSize: 11, lineHeight: 1.5,
                whiteSpace: 'pre-wrap', color: 'var(--text3)',
                background: 'var(--bg1, rgba(0,0,0,0.2))', border: '0.5px solid var(--border2)',
                borderRadius: 6, maxHeight: 180, overflowY: 'auto'
              }}>
                {PRIVACY_CONSENT_DETAIL}
              </div>
            )}
          </div>
        )}

        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

        <button
          className="btn btn-gold"
          onClick={handleAuth}
          disabled={loading}
          style={{ width: '100%', marginBottom: 12 }}
        >
          {loading ? '처리 중...' : isSignUp ? '가입 신청' : '로그인'}
        </button>

        <button
          className="btn"
          onClick={() => { setIsSignUp(!isSignUp); setError(''); resetSignUpFields() }}
          disabled={loading}
          style={{ width: '100%', fontSize: 12 }}
        >
          {isSignUp ? '로그인 페이지로' : '가입 신청 페이지로'}
        </button>
      </div>
    </div>
  )
}

// ── 가입 신청 탭 (관리자 전용) ──────────────────────────────────────
type SignupRequest = {
  id: number
  login_id: string
  summoner_name: string
  riot_id: string | null
  m1_line: string
  m1_tier: string
  m2_line: string
  m2_tier: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}

function SignupRequestsTab({ onRefresh }: { onRefresh: () => void }) {
  const [requests, setRequests] = useState<SignupRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [processingId, setProcessingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  // 승인 전 관리자가 실제 티어를 확인하고 조정할 수 있도록, 요청별로 편집 중인 티어값을 따로 보관
  const [editedTiers, setEditedTiers] = useState<Record<number, { m1: string; m2: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error: err } = await supabase
      .from('signup_requests')
      .select('*')
      .order('created_at', { ascending: false })
    if (err) {
      setError(err.message)
    } else {
      setRequests(data ?? [])
      setEditedTiers(prev => {
        const next = { ...prev }
        for (const r of data ?? []) {
          if (!next[r.id]) next[r.id] = { m1: r.m1_tier, m2: r.m2_tier }
        }
        return next
      })
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // 실시간 구독: 새 가입 신청이 들어오면 관리자 화면에 자동으로 반영
  useEffect(() => {
    const channel = supabase
      .channel('signup-requests-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'signup_requests' }, () => { load() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const approve = async (id: number) => {
    setProcessingId(id)
    setError('')
    const edited = editedTiers[id]
    const { error: err } = await supabase.rpc('approve_signup_request', {
      p_request_id: id,
      p_m1_tier: edited?.m1 ?? null,
      p_m2_tier: edited?.m2 ?? null,
    })
    if (err) setError('승인 실패: ' + err.message)
    else { await load(); onRefresh() }
    setProcessingId(null)
  }

  const reject = async (id: number) => {
    if (!confirm('이 가입 신청을 거절할까요?')) return
    setProcessingId(id)
    setError('')
    const { error: err } = await supabase.rpc('reject_signup_request', { p_request_id: id })
    if (err) setError('거절 실패: ' + err.message)
    else await load()
    setProcessingId(null)
  }

  const pending = requests.filter(r => r.status === 'pending')
  const reviewed = requests.filter(r => r.status !== 'pending')

  return (
    <div>
      <div className="card">
        <div className="card-title">대기 중인 신청 ({pending.length})</div>
        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="empty">불러오는 중...</div>
        ) : pending.length === 0 ? (
          <div className="empty">대기 중인 가입 신청이 없어요</div>
        ) : (
          pending.map(r => {
            const edited = editedTiers[r.id] ?? { m1: r.m1_tier, m2: r.m2_tier }
            return (
              <div key={r.id} style={{
                marginBottom: 10, padding: '10px 12px', background: 'var(--bg3)',
                borderRadius: 'var(--radius)', border: '0.5px solid var(--border)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={{ fontWeight: 700 }}>{r.summoner_name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>{r.login_id}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text2)', marginBottom: 8 }}>
                  롤 계정: <strong>{r.riot_id || '미입력'}</strong>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, width: 70, color: 'var(--text3)' }}>M1: {r.m1_line}</span>
                    <select
                      value={edited.m1}
                      onChange={e => setEditedTiers(prev => ({ ...prev, [r.id]: { ...edited, m1: e.target.value } }))}
                      style={{ flex: 1, fontSize: 12 }}
                    >
                      {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, width: 70, color: 'var(--text3)' }}>M2: {r.m2_line}</span>
                    <select
                      value={edited.m2}
                      onChange={e => setEditedTiers(prev => ({ ...prev, [r.id]: { ...edited, m2: e.target.value } }))}
                      style={{ flex: 1, fontSize: 12 }}
                    >
                      {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
                  💡 실제 롤 계정을 확인해서 티어가 다르면 위에서 직접 수정한 뒤 승인해줘
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-gold btn-sm" disabled={processingId === r.id} onClick={() => approve(r.id)}>
                    {processingId === r.id ? '처리 중...' : '승인'}
                  </button>
                  <button className="btn btn-danger btn-sm" disabled={processingId === r.id} onClick={() => reject(r.id)}>
                    거절
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {reviewed.length > 0 && (
        <div className="card">
          <div className="card-title" style={{ fontSize: 12 }}>처리된 신청 ({reviewed.length})</div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {reviewed.map(r => (
              <div key={r.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 4px', fontSize: 12, borderBottom: '0.5px solid var(--border2)'
              }}>
                <span>{r.summoner_name} ({r.login_id})</span>
                <span style={{ color: r.status === 'approved' ? 'var(--gold, #d4af37)' : 'var(--red)' }}>
                  {r.status === 'approved' ? '승인됨' : '거절됨'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 라인 변경 신청 탭 (관리자 전용) ────────────────────────────────
type LineChangeRequest = {
  id: number
  summoner_name: string
  line: string
  requested_tier: string
  status: 'pending' | 'approved' | 'rejected'
  created_at: string
}

function LineChangeRequestsTab({ onRefresh }: { onRefresh: () => void }) {
  const [requests, setRequests] = useState<LineChangeRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [processingId, setProcessingId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [editedTiers, setEditedTiers] = useState<Record<number, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error: err } = await supabase
      .from('line_change_requests')
      .select('*')
      .order('created_at', { ascending: false })
    if (err) {
      setError(err.message)
    } else {
      setRequests(data ?? [])
      setEditedTiers(prev => {
        const next = { ...prev }
        for (const r of data ?? []) {
          if (!next[r.id]) next[r.id] = r.requested_tier
        }
        return next
      })
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  // 실시간 구독: 새 라인변경신청이 들어오면 관리자 화면에 자동으로 반영
  useEffect(() => {
    const channel = supabase
      .channel('room-linechange-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'line_change_requests' }, () => { load() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [load])

  const approve = async (id: number) => {
    setProcessingId(id)
    setError('')
    const { error: err } = await supabase.rpc('approve_line_change_request', {
      p_request_id: id,
      p_tier: editedTiers[id] ?? null,
    })
    if (err) setError('승인 실패: ' + err.message)
    else { await load(); onRefresh() }
    setProcessingId(null)
  }

  const reject = async (id: number) => {
    if (!confirm('이 라인 신청을 거절할까요?')) return
    setProcessingId(id)
    setError('')
    const { error: err } = await supabase.rpc('reject_line_change_request', { p_request_id: id })
    if (err) setError('거절 실패: ' + err.message)
    else await load()
    setProcessingId(null)
  }

  const pending = requests.filter(r => r.status === 'pending')
  const reviewed = requests.filter(r => r.status !== 'pending')

  return (
    <div>
      <div className="card">
        <div className="card-title">대기 중인 라인변경신청 ({pending.length})</div>
        {error && <div className="error">{error}</div>}
        {loading ? (
          <div className="empty">불러오는 중...</div>
        ) : pending.length === 0 ? (
          <div className="empty">대기 중인 라인변경신청이 없어요</div>
        ) : (
          pending.map(r => (
            <div key={r.id} style={{
              marginBottom: 10, padding: '10px 12px', background: 'var(--bg3)',
              borderRadius: 'var(--radius)', border: '0.5px solid var(--border)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontWeight: 700 }}>{r.summoner_name}</span>
                <span className="badge b-line" style={{ fontSize: 11 }}>{r.line}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--text3)' }}>신청 티어</span>
                <select
                  value={editedTiers[r.id] ?? r.requested_tier}
                  onChange={e => setEditedTiers(prev => ({ ...prev, [r.id]: e.target.value }))}
                  style={{ flex: 1, fontSize: 12 }}
                >
                  {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-gold btn-sm" disabled={processingId === r.id} onClick={() => approve(r.id)}>
                  {processingId === r.id ? '처리 중...' : '허용'}
                </button>
                <button className="btn btn-danger btn-sm" disabled={processingId === r.id} onClick={() => reject(r.id)}>
                  거절
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {reviewed.length > 0 && (
        <div className="card">
          <div className="card-title" style={{ fontSize: 12 }}>처리된 신청 ({reviewed.length})</div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            {reviewed.map(r => (
              <div key={r.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '6px 4px', fontSize: 12, borderBottom: '0.5px solid var(--border2)'
              }}>
                <span>{r.summoner_name} ({r.line})</span>
                <span style={{ color: r.status === 'approved' ? 'var(--gold, #d4af37)' : 'var(--red)' }}>
                  {r.status === 'approved' ? '승인됨' : '거절됨'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 허가요청 탭 (관리자 전용) — 가입신청 / 라인변경신청 구분 ────────────
function ApprovalRequestsTab({ onRefresh }: { onRefresh: () => void }) {
  const [subTab, setSubTab] = useState<'signup' | 'linechange'>('signup')

  return (
    <div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className={`btn btn-sm${subTab === 'signup' ? ' btn-gold' : ''}`}
            onClick={() => setSubTab('signup')}
          >
            가입신청
          </button>
          <button
            className={`btn btn-sm${subTab === 'linechange' ? ' btn-gold' : ''}`}
            onClick={() => setSubTab('linechange')}
          >
            라인변경신청
          </button>
        </div>
      </div>

      {subTab === 'signup' && <SignupRequestsTab onRefresh={onRefresh} />}
      {subTab === 'linechange' && <LineChangeRequestsTab onRefresh={onRefresh} />}
    </div>
  )
}

// ── 내전방 (로비: 방 생성/목록/입장/퇴장) — 1단계 ──────────────────────
type RoomMember = {
  summoner_name: string
  most1: Line | 'any'
  most2: Line | 'any' | null
  ready: boolean
}

type Room = {
  id: number
  name: string
  host_user_id: string
  host_summoner_name: string
  members: RoomMember[]
  status: 'waiting' | 'playing'
  match_mode: 'line' | 'random'
  max_score_diff: number
  result: BalanceResult | null
  pending_result: BalanceResult | null
  last_result: BalanceResult | null
  balance_started_at: string | null
  created_at: string
  has_password: boolean
}

// 팀편성 결과를 blue/red 구분 없이 비교 가능한 시그니처로 변환 (직전 조합과의 완전 동일 여부 판단용)
function resultSignature(r: BalanceResult): string {
  const teamSig = (team: TeamPlayer[]) => team.map(p => `${p.name}:${p.line}`).sort().join(',')
  const sigs = [teamSig(r.team1), teamSig(r.team2)].sort()
  return sigs.join('|')
}

// ── 내전방 채팅 (방 단위, 방이 사라지면 같이 사라짐) ────────────────────
type RoomMessage = {
  id: number
  room_id: number
  user_id: string
  summoner_name: string
  message: string
  created_at: string
}

function RoomChat({ roomId, myName }: { roomId: number; myName: string }) {
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('room_messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true })
      if (!cancelled) setMessages(data ?? [])
    })()

    // 이 방의 채팅만 실시간 구독
    const channel = supabase
      .channel(`room-chat-${roomId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_messages', filter: `room_id=eq.${roomId}` }, (payload) => {
        setMessages(prev => [...prev, payload.new as RoomMessage])
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [roomId])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setSending(true)
    const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
    if (!user) { setSending(false); return }
    const { error } = await supabase.from('room_messages').insert({
      room_id: roomId,
      user_id: user.id,
      summoner_name: myName,
      message: text,
    })
    if (!error) setInput('')
    setSending(false)
  }

  const fmtTime = (iso: string) => {
    const d = new Date(iso)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="room-chat">
      <div className="room-chat-header">채팅</div>
      <div className="room-chat-messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty">아직 채팅이 없어요</div>
        ) : (
          messages.map(m => {
            const isMe = m.summoner_name === myName
            return (
              <div key={m.id} style={{ alignSelf: isMe ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 2, textAlign: isMe ? 'right' : 'left' }}>
                  {isMe ? '나' : m.summoner_name} · {fmtTime(m.created_at)}
                </div>
                <div style={{
                  fontSize: 12, padding: '6px 10px', borderRadius: 'var(--radius)',
                  background: isMe ? 'rgba(212,175,55,0.15)' : 'var(--bg3)',
                  border: `0.5px solid ${isMe ? 'var(--gold, #d4af37)' : 'var(--border2)'}`,
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                }}>
                  {m.message}
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="room-chat-input">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="메시지 입력... (Shift+Enter 줄바꿈)"
          disabled={sending}
          maxLength={300}
          rows={2}
          style={{ resize: 'none', overflowY: 'auto', maxHeight: 72, fontFamily: 'inherit', lineHeight: 1.4 }}
        />
        <button className="btn btn-gold btn-sm" onClick={send} disabled={sending || !input.trim()} style={{ alignSelf: 'flex-end' }}>전송</button>
      </div>
    </div>
  )
}

function RoomsTab({
  summoners,
  summonerScores,
  records,
  idPrefixMap,
  pendingLinesMap,
  onRecord,
  dbIsAdmin,
  inactiveNames,
}: {
  summoners: SummonerMap
  summonerScores: SummonerScoreMap
  records: GameRecord[]
  idPrefixMap: Record<string, string>
  pendingLinesMap: Record<string, Line[]>
  onRecord: (r: { winner: 'blue' | 'red'; blue: { name: string; line: Line }[]; red: { name: string; line: Line }[]; skipInsert?: boolean }) => void
  dbIsAdmin: boolean
  inactiveNames: Set<string>
}) {
  const [myName, setMyName] = useState<string | null>(null)
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [newRoomName, setNewRoomName] = useState('')
  const [newRoomPassword, setNewRoomPassword] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const [loadError, setLoadError] = useState('')

  // onlyRoomId를 주면 그 방 하나만 갱신(가벼움), 안 주면 전체 방 목록 조회(로비용)
  const loadRooms = useCallback(async (onlyRoomId?: number) => {
    if (onlyRoomId) {
      const { data, error } = await supabase.from('rooms_public').select('*').eq('id', onlyRoomId).maybeSingle()
      if (error) {
        console.error('방 정보 조회 실패:', error)
        return
      }
      setLoadError('')
      setRooms(prev => {
        if (!data) return prev.filter(r => r.id !== onlyRoomId) // 방이 삭제됨
        const exists = prev.some(r => r.id === (data as Room).id)
        return exists ? prev.map(r => (r.id === (data as Room).id ? (data as Room) : r)) : [...prev, data as Room]
      })
      return
    }
    // password_hash가 없는 공개용 뷰에서만 조회 (비밀번호 해시는 절대 클라이언트로 내려오지 않음)
    const { data, error } = await supabase.from('rooms_public').select('*').order('created_at', { ascending: false })
    if (error) {
      console.error('방 목록 조회 실패:', error)
      setLoadError(error.message)
      return
    }
    setLoadError('')
    setRooms((data ?? []) as Room[])
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const { data: { session } } = await supabase.auth.getSession()
        const user = session?.user ?? null
        if (user) {
          setMyUserId(user.id)
          const { data, error: maErr } = await supabase
            .from('member_accounts')
            .select('summoner_name')
            .eq('user_id', user.id)
            .maybeSingle()
          if (maErr) console.error('내 소환사 정보 조회 실패:', maErr)
          if (!cancelled) setMyName(data?.summoner_name ?? null)
        }
        await loadRooms()
      } catch (e) {
        console.error('내전방 초기 로딩 실패:', e)
        if (!cancelled) setLoadError((e as Error).message ?? '알 수 없는 오류')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [loadRooms])

  const myRoom = rooms.find(r => r.members.some(m => m.summoner_name === myName)) ?? null
  const isHost = !!myRoom && myRoom.host_summoner_name === myName

  // 실시간 구독: 로비(방 목록)에 있을 땐 방 전체를 넓게 구독하고,
  // 내가 특정 방에 들어가 있을 땐 "그 방 하나"만 좁혀서 구독함.
  // 다른 방에서 일어나는 일(라인 변경, 준비완료 등) 때문에 불필요하게 전체를 다시 불러오지 않도록 하기 위함
  // — 카운트다운 중 버벅임의 원인이었음.
  useEffect(() => {
    const roomId = myRoom?.id
    const channelName = roomId ? `rooms-realtime-room-${roomId}` : 'rooms-realtime-lobby'
    const filterConfig: any = { event: '*', schema: 'public', table: 'rooms' }
    if (roomId) filterConfig.filter = `id=eq.${roomId}`

    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', filterConfig, () => { loadRooms(roomId) })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [loadRooms, myRoom?.id])

  // 경기 기록 시점에 방의 나머지 참가자 전원에게 "새로고침해" 신호를 즉시 쏴주는 채널.
  const reloadChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  useEffect(() => {
    if (!myRoom?.id) { reloadChannelRef.current = null; return }
    const channel = supabase.channel(`room-events-${myRoom.id}`)
    channel.on('broadcast', { event: 'reload' }, () => { window.location.reload() })
    channel.subscribe()
    reloadChannelRef.current = channel
    return () => { supabase.removeChannel(channel); reloadChannelRef.current = null }
  }, [myRoom?.id])

  // 위 신호(broadcast)가 어떤 이유로든 전달 안 됐을 때를 대비한 보험.
  // 결과 화면이 떠 있는 동안만 짧은 주기로 방 상태를 재확인해서,
  // 신호를 못 받았어도 결국엔 자동으로 참가자 목록으로 돌아가게 함
  // (평소 대기실 화면에서는 작동 안 하니까 부하는 거의 없음).
  useEffect(() => {
    if (!myRoom?.result) return
    const interval = setInterval(() => { loadRooms(myRoom.id) }, 4000)
    return () => clearInterval(interval)
  }, [loadRooms, myRoom?.id, !!myRoom?.result])

  // 소환사의 등록된 라인 목록 (LINE_ORDER 순)
  const getSummonerLines = (n: string): Line[] => {
    if (!summoners[n]) return []
    return (Object.keys(summoners[n]) as Line[]).sort((a, b) => LINE_ORDER[a] - LINE_ORDER[b])
  }

  // 방 만들기/입장 시 초기 M1/M2 값은 이제 DB 함수(create_room/join_room)가 서버에서 계산함
  const createRoom = async () => {
    if (!myName || !myUserId) return
    if (myRoom) { setError('이미 참가 중인 방이 있어요. 먼저 나가주세요.'); return }
    setCreating(true)
    setError('')
    const { error: err } = await supabase.rpc('create_room', {
      p_name: newRoomName.trim() || null,
      p_password: newRoomPassword.trim() || null,
    })
    if (err) setError('방 생성 실패: ' + err.message)
    else { setNewRoomName(''); setNewRoomPassword(''); await loadRooms() }
    setCreating(false)
  }

  const joinRoom = async (room: Room) => {
    if (!myName) return
    if (myRoom) { setError('이미 다른 방에 참가 중이에요. 먼저 나가주세요.'); return }
    if (room.members.length >= 10) { setError('방이 가득 찼어요.'); return }
    if (room.members.some(m => m.summoner_name === myName)) return
    setError('')

    let pwd: string | null = null
    if (room.has_password) {
      pwd = prompt(`"${room.name}"은(는) 비밀번호가 설정된 방이에요. 비밀번호를 입력해주세요.`)
      if (pwd === null) return // 취소
    }

    const { error: err } = await supabase.rpc('join_room', { p_room_id: room.id, p_password: pwd })
    if (err) setError('입장 실패: ' + err.message)
    else await loadRooms()
  }

  const leaveRoom = async () => {
    if (!myRoom || !myName) return
    if (isHost) {
      // 방장이 나가면 방 자체가 삭제됨
      if (!confirm('방장이 나가면 방이 삭제돼요. 나갈까요?')) return
      await supabase.from('rooms').delete().eq('id', myRoom.id)
    } else {
      const newMembers = myRoom.members.filter(m => m.summoner_name !== myName)
      await supabase
        .from('rooms')
        .update({ members: newMembers, updated_at: new Date().toISOString() })
        .eq('id', myRoom.id)
    }
    await loadRooms()
  }

  const updateMyMost = async (field: 'most1' | 'most2', value: string) => {
    if (!myRoom || !myName) return
    const myEntry = myRoom.members.find(m => m.summoner_name === myName)
    if (myEntry?.ready) return // 준비완료 상태에서는 라인 변경 불가 (UI에서도 비활성화되어 있지만 이중 확인)
    const newMembers = myRoom.members.map(m => {
      if (m.summoner_name !== myName) return m
      if (field === 'most1') {
        if (value === 'any') return { ...m, most1: 'any' as const, most2: null }
        return { ...m, most1: value as Line }
      }
      return { ...m, most2: (value || null) as Line | 'any' | null }
    })
    const roomId = myRoom.id
    // 낙관적 업데이트: 서버 응답(왕복)을 기다리지 않고 화면을 즉시 반영해서 클릭 반응성을 높임
    setRooms(prev => prev.map(r => (r.id === roomId ? { ...r, members: newMembers } : r)))
    await supabase.from('rooms').update({ members: newMembers, updated_at: new Date().toISOString() }).eq('id', roomId)
  }

  const toggleReady = async () => {
    if (!myRoom || !myName) return
    const newMembers = myRoom.members.map(m => m.summoner_name === myName ? { ...m, ready: !m.ready } : m)
    const roomId = myRoom.id
    setRooms(prev => prev.map(r => (r.id === roomId ? { ...r, members: newMembers } : r)))
    await supabase.from('rooms').update({ members: newMembers, updated_at: new Date().toISOString() }).eq('id', roomId)
  }

  // 방장이 다른 참가자를 강퇴 (본인 나가기와 동일하게 members 배열에서 제거)
  const kickMember = async (name: string) => {
    if (!myRoom || !isHost || name === myRoom.host_summoner_name) return
    if (!confirm(`${name}님을 강퇴할까요?`)) return
    const newMembers = myRoom.members.filter(m => m.summoner_name !== name)
    const roomId = myRoom.id
    setRooms(prev => prev.map(r => (r.id === roomId ? { ...r, members: newMembers } : r)))
    await supabase.from('rooms').update({ members: newMembers, updated_at: new Date().toISOString() }).eq('id', roomId)
  }

  // 매칭 방식(라인밸런싱/올랜덤)은 방장만 변경 가능
  const updateMatchMode = async (mode: 'line' | 'random') => {
    if (!myRoom || !isHost) return
    const roomId = myRoom.id
    setRooms(prev => prev.map(r => (r.id === roomId ? { ...r, match_mode: mode } : r)))
    await supabase.from('rooms').update({ match_mode: mode, updated_at: new Date().toISOString() }).eq('id', roomId)
  }

  // 팀 간 최대 점수차(0~10점)도 방장만 변경 가능
  const updateMaxScoreDiff = async (value: number) => {
    if (!myRoom || !isHost) return
    const clamped = Math.min(10, Math.max(0, value))
    const roomId = myRoom.id
    setRooms(prev => prev.map(r => (r.id === roomId ? { ...r, max_score_diff: clamped } : r)))
    await supabase.from('rooms').update({ max_score_diff: clamped, updated_at: new Date().toISOString() }).eq('id', roomId)
  }

  // 관리자 전용 테스트 기능: 등록된 다른 소환사들로 방을 10명까지 자동으로 채우고
  // 전부 준비완료 상태로 만들어서, 혼자서도 매칭 테스트를 해볼 수 있게 함.
  // 무작위로 뽑으면 라인이 한쪽으로 쏠려서 밸런싱이 실패할 수 있으므로,
  // "아직 2명이 안 채워진 라인"부터 우선적으로 채우는 방식으로 채움.
  const fillTestMembers = async () => {
    if (!myRoom || !isHost || !dbIsAdmin) return
    const existingNames = new Set(myRoom.members.map(m => m.summoner_name))
    const need = 10 - myRoom.members.length
    if (need <= 0) return

    const targetLines: Line[] = ['탑', '정글', '미드', '원딜', '서포터']
    // 이미 방에 있는 사람들의 M1 기준으로 현재 라인별 인원 카운트 (M1='상관없음'인 사람은 유동적이라 카운트에서 제외)
    const lineCount: Record<Line, number> = { 탑: 0, 정글: 0, 미드: 0, 원딜: 0, 서포터: 0 }
    myRoom.members.forEach(m => {
      if (m.most1 !== 'any') lineCount[m.most1 as Line] = (lineCount[m.most1 as Line] ?? 0) + 1
    })

    // 후보 풀: 아직 방에 없는 + 비활성화되지 않은 + 실제 로그인 계정이 연결된 등록 소환사만
    // (summoners 테이블엔 있지만 member_accounts에 연결된 계정이 없는 "유령 데이터"는 제외)
    let pool = Object.keys(summoners)
      .filter(n => !existingNames.has(n) && !inactiveNames.has(n) && idPrefixMap[n])
      .map(n => ({ name: n, lines: getSummonerLines(n) }))
      .filter(c => c.lines.length > 0)

    const newFilled: RoomMember[] = []

    while (newFilled.length < need && pool.length > 0) {
      // 아직 2명이 안 채워진 라인 중 가장 부족한 라인부터
      const needs = targetLines
        .map(l => ({ line: l, remain: 2 - lineCount[l] }))
        .filter(x => x.remain > 0)
        .sort((a, b) => b.remain - a.remain)

      if (needs.length === 0) break // 5라인 전부 2명씩 채워짐

      const target = needs[0].line
      const candidates = pool.filter(c => c.lines.includes(target))

      if (candidates.length === 0) {
        // 이 라인을 커버할 등록된 후보가 더 없음 → 포기하고 다음 부족 라인으로 넘어감
        lineCount[target] = 2
        continue
      }

      // 등록 라인이 적은(=다른 라인으로 대체하기 어려운) 사람을 우선 선택해서, 라인 많은 사람은 나중을 위해 아낌
      candidates.sort((a, b) => a.lines.length - b.lines.length)
      const chosen = candidates[0]

      const otherLines = chosen.lines.filter(l => l !== target)
      const most2 = otherLines.find(l => lineCount[l] < 2) ?? otherLines[0] ?? null

      newFilled.push({ summoner_name: chosen.name, most1: target, most2, ready: true })
      lineCount[target]++
      pool = pool.filter(c => c.name !== chosen.name)
    }

    // 그래도 인원이 부족하면(등록된 소환사 자체가 적은 경우) 라인 무관하게 남은 후보로 채움
    if (newFilled.length < need) {
      const filledNames = new Set(newFilled.map(f => f.summoner_name))
      const leftover = pool.filter(c => !filledNames.has(c.name)).slice(0, need - newFilled.length)
      leftover.forEach(c => {
        newFilled.push({ summoner_name: c.name, most1: (c.lines[0] ?? '탑') as Line, most2: c.lines[1] ?? null, ready: true })
      })
    }

    const newMembers = [...myRoom.members, ...newFilled]
    await supabase.from('rooms').update({ members: newMembers, updated_at: new Date().toISOString() }).eq('id', myRoom.id)

    const stillShort = targetLines.filter(l => lineCount[l] < 2)
    if (stillShort.length > 0) {
      alert(`다음 라인은 등록된 소환사가 부족해서 2명을 못 채웠어요: ${stillShort.join(', ')}. 팀편성이 실패할 수 있어요.`)
    }
  }

  const [balancing, setBalancing] = useState(false)
  const [balanceError, setBalanceError] = useState('')

  // 팀 편성 (기존 팀뽑기 로직과 동일한 알고리즘을 방 단위로 재사용)
  const runBalance = async () => {
    if (!myRoom) return
    setBalanceError('')
    const players: PlayerEntry[] = myRoom.members.map(m => ({ name: m.summoner_name, most1: m.most1, most2: m.most2 }))
    if (players.length !== 10) { setBalanceError(`정확히 10명이 필요해요. (현재 ${players.length}명)`); return }
    if (!myRoom.members.every(m => m.ready)) { setBalanceError('모든 참가자가 준비완료 상태여야 해요.'); return }

    setBalancing(true)

    const getOptions = (p: PlayerEntry): Line[] => {
      const allLines = getSummonerLines(p.name)
      const opts: Line[] = []
      if (p.most1 === 'any') opts.push(...allLines)
      else opts.push(p.most1 as Line)
      if (p.most2 && p.most2 !== 'any' && !opts.includes(p.most2 as Line)) opts.push(p.most2 as Line)
      return opts.length > 0 ? opts : allLines
    }

    const getAdjustedScore = (name: string, line: Line, tier: string): number => {
      return summonerScores[name]?.[line] ?? getScoreByTier(tier)
    }

    const LINE_PREFERENCE: Record<string, Line> = { '공민규': '정글' }
    const PREFERENCE_RATE = 0.95
    const LINE_AVOID: Record<string, Line[]> = { '강재현': ['미드', '원딜'] }
    const AVOID_RATE = 0.1

    let best: BalanceResult | null = null
    let bestDiff = Infinity
    let bestLineDiff = Infinity
    let fallback: BalanceResult | null = null
    let fallbackDiff = Infinity
    let fallbackLineDiff = Infinity
    const candidates: { diff: number; lineDiff: number; total: number; result: BalanceResult }[] = []
    // 직전 팀편성과 완전히 동일한 조합은 후보에서 제외 (blue/red가 바뀌어도 같은 것으로 취급)
    const lastSig = myRoom.last_result ? resultSignature(myRoom.last_result) : null

    // 시도 횟수를 늘려서, 점수차 제한이 빡빡할 때 "됐다 안됐다" 하는 우연성을 줄임
    for (let i = 0; i < 3000; i++) {
      const assigned = players.map(p => {
        const preferredLine = LINE_PREFERENCE[p.name]
        const allLines = getSummonerLines(p.name)
        if (preferredLine && allLines.includes(preferredLine) && Math.random() < PREFERENCE_RATE) {
          const tier = summoners[p.name]?.[preferredLine] ?? '골드2'
          const score = getAdjustedScore(p.name, preferredLine, tier)
          return { name: p.name, line: preferredLine, score }
        }
        let line: Line
        let isM2 = false
        if (p.most1 === 'any') {
          line = allLines[Math.floor(Math.random() * allLines.length)]
        } else if (!p.most2 || p.most2 === 'any') {
          line = p.most1 as Line
        } else {
          isM2 = Math.random() >= 0.7
          line = isM2 ? p.most2 as Line : p.most1 as Line
        }
        const avoidLines = LINE_AVOID[p.name]
        if (avoidLines && avoidLines.includes(line) && Math.random() >= AVOID_RATE) {
          const altLines = allLines.filter(l => !avoidLines.includes(l))
          if (altLines.length > 0) line = altLines[Math.floor(Math.random() * altLines.length)]
        }
        const tier = summoners[p.name]?.[line] ?? '골드2'
        const score = getAdjustedScore(p.name, line, tier)
        return { name: p.name, line, score }
      })

      const lineCounts: Record<string, number> = {}
      assigned.forEach(p => { lineCounts[p.line] = (lineCounts[p.line] ?? 0) + 1 })
      const valid = LINES.every(l => (lineCounts[l] ?? 0) >= 2)
      if (!valid) continue

      const t1: typeof assigned = [], t2: typeof assigned = []
      let ok = true
      for (const l of LINES) {
        const pool = shuffle(assigned.filter(p => p.line === l))
        if (pool.length < 2) { ok = false; break }
        t1.push(pool[0]); t2.push(pool[1])
      }
      if (!ok) continue

      const used = new Set([...t1, ...t2])
      const rest = shuffle(assigned.filter(p => !used.has(p)))
      const half = Math.ceil(rest.length / 2)
      rest.slice(0, half).forEach(p => t1.push(p))
      rest.slice(half).forEach(p => t2.push(p))
      if (t1.length !== 5 || t2.length !== 5) continue

      const s1 = t1.reduce((a, p) => a + p.score, 0)
      const s2 = t2.reduce((a, p) => a + p.score, 0)
      const diff = Math.abs(s1 - s2)

      let lineDiff = 0
      let maxLineDiff = 0
      for (const l of LINES) {
        const p1 = t1.find(p => p.line === l)
        const p2 = t2.find(p => p.line === l)
        if (p1 && p2) {
          const d = Math.abs(p1.score - p2.score)
          lineDiff += d
          if (d > maxLineDiff) maxLineDiff = d
        }
      }

      const t1Bot = t1.filter(p => p.line === '원딜' || p.line === '서포터').reduce((a, p) => a + p.score, 0)
      const t2Bot = t2.filter(p => p.line === '원딜' || p.line === '서포터').reduce((a, p) => a + p.score, 0)
      const botDiff = Math.abs(t1Bot - t2Bot)

      const candidateResult: BalanceResult = {
        team1: t1.map(p => ({ name: p.name, tier: summoners[p.name]?.[p.line] ?? '골드2', line: p.line, score: p.score })),
        team2: t2.map(p => ({ name: p.name, tier: summoners[p.name]?.[p.line] ?? '골드2', line: p.line, score: p.score })),
        s1, s2,
      }

      // 직전 팀편성과 100% 동일한 조합이면 이번 후보에서 완전히 제외
      if (lastSig && resultSignature(candidateResult) === lastSig) continue

      const isBetterFallback = diff < fallbackDiff || (diff === fallbackDiff && lineDiff < fallbackLineDiff)
      if (isBetterFallback) { fallbackDiff = diff; fallbackLineDiff = lineDiff; fallback = candidateResult }

      // 라인밸런싱 모드에서만 라인별/바텀 격차 필터링 적용. 올랜덤 모드는 팀 총점 차이만 봄. (값이 없으면 라인밸런싱 기본)
      if ((myRoom.match_mode ?? 'line') === 'line' && (maxLineDiff >= 30 || botDiff >= 35)) continue

      candidates.push({ diff, lineDiff, total: s1 + s2, result: candidateResult })

      const isBetter = diff < bestDiff || (diff === bestDiff && lineDiff < bestLineDiff)
      if (isBetter) { bestDiff = diff; bestLineDiff = lineDiff; best = candidateResult }
    }

    // 방장이 설정한 "최대 점수차"(0~10점) 이내인 후보만 사용.
    // (기존 버그: 이 범위 안에서 못 찾으면 범위 밖의 "그나마 나은 후보"로 조용히 대체하고 있었음 —
    //  그래서 설정한 점수차보다 더 크게 매칭되는 문제가 있었음. 이제는 범위 밖 후보로 대체하지 않고
    //  못 찾으면 그대로 실패 처리함.)
    const maxDiff = myRoom.max_score_diff ?? 10
    const goodCandidates = candidates.filter(c => c.diff <= maxDiff)
    best = null
    if (goodCandidates.length > 0) {
      goodCandidates.sort((a, b) => b.total - a.total)
      const top10 = goodCandidates.slice(0, 10)
      const picked = top10[Math.floor(Math.random() * top10.length)]
      best = picked.result
      bestDiff = picked.diff
    }

    if (best) {
      const startedAt = new Date().toISOString()
      await supabase.from('rooms').update({ pending_result: best, balance_started_at: startedAt }).eq('id', myRoom.id)
    } else if (fallback) {
      setBalanceError(`설정한 최대 점수차(${maxDiff}점) 이내의 조합을 찾지 못했어요. (가장 가까운 조합은 ${fallbackDiff.toFixed(1)}점 차이) 최대 점수차를 늘리거나, 같은 설정으로 다시 시도해보세요.`)
    } else {
      const linePossible: Record<string, number> = {}
      LINES.forEach(l => { linePossible[l] = 0 })
      players.forEach(p => {
        const allLines = getSummonerLines(p.name)
        if (p.most1 === 'any') allLines.forEach(l => { linePossible[l] = (linePossible[l] ?? 0) + 1 })
        else linePossible[p.most1] = (linePossible[p.most1] ?? 0) + 1
        if (p.most2 === 'any') allLines.forEach(l => { linePossible[l] = (linePossible[l] ?? 0) + 1 })
        else if (p.most2) linePossible[p.most2] = (linePossible[p.most2] ?? 0) + 1
      })
      const shortLines = LINES.filter(l => (linePossible[l] ?? 0) < 2)
      if (shortLines.length > 0) {
        const msg = shortLines.map(l => `${l} (${linePossible[l] ?? 0}명 → 2명 필요)`).join(', ')
        setBalanceError(`팀 구성 실패. 다음 라인 인원이 부족해요: ${msg}`)
      } else {
        const lineOptions = players.map(p => ({ name: p.name, options: getOptions(p) }))
        const problematic = lineOptions.filter(p => p.options.length === 0)
        if (problematic.length > 0) {
          setBalanceError(`팀 구성 실패. ${problematic.map(p => p.name).join(', ')}의 라인 설정을 확인해주세요.`)
        } else {
          setBalanceError('팀 구성 실패. 라인 조합이 너무 치우쳐 있어요. M1/M2를 다양하게 설정해보세요.')
        }
      }
    }
    setBalancing(false)
  }

  // 팀편성 결과 공개 카운트다운 (3초) — balance_started_at 기준으로 모든 참가자 화면에서 동일하게 진행
  const [countdown, setCountdown] = useState<number | null>(null)
  useEffect(() => {
    if (!myRoom?.balance_started_at || myRoom.result) { setCountdown(null); return }
    const startedAt = myRoom.balance_started_at
    const tick = () => {
      const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000)
      const remaining = 3 - elapsed
      setCountdown(remaining > 0 ? remaining : 0)
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [myRoom?.balance_started_at, !!myRoom?.result])

  useEffect(() => {
    if (countdown === 0 && myRoom?.pending_result && myRoom.result === null) {
      supabase.from('rooms')
        .update({ result: myRoom.pending_result, pending_result: null, balance_started_at: null })
        .eq('id', myRoom.id)
        .is('result', null)
        .then(() => {})
    }
  }, [countdown, myRoom?.id])

  const [isRecording, setIsRecording] = useState(false)
  const recordingRef = useRef(false)

  const recordWin = async (winner: 'blue' | 'red') => {
    if (!myRoom?.result || recordingRef.current || !isHost) return
    recordingRef.current = true
    setIsRecording(true)

    // 동시 클릭 방지: DB에서 원자적으로 선점 (이미 result가 null이면 다른 사람이 처리한 것)
    const { data: claimed } = await supabase
      .from('rooms')
      .update({ result: null, pending_result: null, balance_started_at: null, updated_at: new Date().toISOString() })
      .eq('id', myRoom.id)
      .not('result', 'is', null)
      .select()

    if (!claimed || claimed.length === 0) {
      recordingRef.current = false
      setIsRecording(false)
      return
    }

    const result = myRoom.result
    const winners = winner === 'blue' ? result.team1 : result.team2
    const losers = winner === 'blue' ? result.team2 : result.team1
    const now = new Date()
    const time = `${now.getMonth() + 1}/${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const blueData = result.team1.map(p => ({ name: p.name, line: p.line }))
    const redData = result.team2.map(p => ({ name: p.name, line: p.line }))

    const { data: newRecord } = await supabase.from('records').insert([{ winner, blue: blueData, red: redData, time }]).select()
    const recId = newRecord?.[0]?.id

    const { data: latestRecs } = await supabase.from('records').select('*').order('created_at', { ascending: false })
    const updatedRecords = (latestRecs ?? []) as GameRecord[]

    if (recId) {
      for (const p of winners) {
        if (!summoners[p.name]?.[p.line]) continue
        const { error: rpcErr } = await supabase.rpc('apply_match_score_delta', { p_record_id: recId, p_name: p.name, p_line: p.line, p_delta: 1 })
        if (rpcErr) console.error('점수 반영 실패:', p.name, p.line, rpcErr.message)
      }
      for (const p of losers) {
        if (!summoners[p.name]?.[p.line]) continue
        const { error: rpcErr } = await supabase.rpc('apply_match_score_delta', { p_record_id: recId, p_name: p.name, p_line: p.line, p_delta: -1 })
        if (rpcErr) console.error('점수 반영 실패:', p.name, p.line, rpcErr.message)
      }
    }

    onRecord({ winner, blue: blueData, red: redData, skipInsert: true })

    // 방 초기화: 참가자는 유지하되 전부 준비 해제 (다음 판 위해 다시 준비해야 함)
    // 방금 진행한 팀편성은 last_result로 저장 — 다음 팀편성 때 완전히 같은 조합이 다시 나오지 않게 하기 위함
    const resetMembers = myRoom.members.map(m => ({ ...m, ready: false }))
    await supabase.from('rooms').update({ members: resetMembers, last_result: result }).eq('id', myRoom.id)

    // 디스코드 전송
    try {
      const now2 = new Date()
      const dateStr = `${now2.getFullYear()}년 ${now2.getMonth() + 1}월 ${now2.getDate()}일 ${String(now2.getHours()).padStart(2, '0')}:${String(now2.getMinutes()).padStart(2, '0')}`
      const sortedWinners = [...winners].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))
      const sortedLosers = [...losers].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))

      const getStreak = (name: string, line: Line, recs: GameRecord[]) => {
        const lr = recs.filter(r => r.blue.some(p => p.name === name && p.line === line) || r.red.some(p => p.name === name && p.line === line))
        if (lr.length < 2) return 0
        const first = lr[0]
        const isWin = (first.blue.some(p => p.name === name && p.line === line) && first.winner === 'blue') ||
                      (first.red.some(p => p.name === name && p.line === line) && first.winner === 'red')
        let s = 0
        for (const r of lr) {
          const inBlue = r.blue.some(p => p.name === name && p.line === line)
          const w = (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
          if (w === isWin) s++; else break
        }
        return isWin ? s : -s
      }

      const fmtPlayer = (p: TeamPlayer, isWinner: boolean) => {
        const beforeTier = summoners[p.name]?.[p.line] ?? p.tier
        const beforeScore = summonerScores[p.name]?.[p.line] ?? getScoreByTier(p.tier)
        const afterScore = isWinner ? beforeScore + 1 : beforeScore - 1
        const afterTier = getTierByScore(afterScore)
        const tierChange = afterTier !== beforeTier
          ? `↳ ${beforeTier} → ${afterTier} ${isWinner ? '▲' : '▼'}`
          : `↳ ${afterTier} (변동없음)`
        const scoreChange = `↳ ${beforeScore}점 → ${afterScore}점 (${isWinner ? '+1' : '-1'})`
        const streak = getStreak(p.name, p.line, updatedRecords)
        const abs = Math.abs(streak)
        const streakStr = abs >= 2 ? (streak > 0 ? ` 🔥${abs}연승` : ` 💧${abs}연패`) : ''
        const line1 = `\`${p.line}\` **${p.name}**${streakStr}`
        return [line1, tierChange, scoreChange].join('\n')
      }

      const winLabel = winner === 'blue' ? '🔵 블루팀' : '🔴 레드팀'
      const loseLabel = winner === 'blue' ? '🔴 레드팀' : '🔵 블루팀'
      const payload = {
        username: '내전 매니저',
        embeds: [{
          title: `🏆 ${winLabel} 승리! (${myRoom.name})`,
          color: winner === 'blue' ? 0x0bc4e3 : 0xe84057,
          fields: [
            { name: `${winLabel} (승)`, value: sortedWinners.map(p => fmtPlayer(p, true)).join('\n'), inline: true },
            { name: `${loseLabel} (패)`, value: sortedLosers.map(p => fmtPlayer(p, false)).join('\n'), inline: true },
          ],
          footer: { text: `lol-naegeon.vercel.app · ${dateStr}` }
        }]
      }
      const discordRes = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      })
      if (!discordRes.ok) console.error('Discord webhook failed:', discordRes.status, await discordRes.text())
    } catch (e) { console.error('Discord webhook error:', e) }

    // 나머지 참가자들에게 "지금 새로고침해" 신호를 즉시 전송 (폴링 없이 그 순간 바로 반영됨)
    if (reloadChannelRef.current) {
      try {
        await reloadChannelRef.current.send({ type: 'broadcast', event: 'reload', payload: {} })
      } catch (e) { console.error('reload broadcast 실패:', e) }
    }

    setIsRecording(false)
    recordingRef.current = false
    window.location.reload()
  }

  const sortByLine = (arr: TeamPlayer[]) => [...arr].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))

  if (loading) {
    return <div className="card"><div className="empty">불러오는 중...</div></div>
  }

  if (loadError) {
    return (
      <div className="card">
        <div className="error">내전방 정보를 불러오지 못했어요: {loadError}</div>
        <button className="btn btn-gold" onClick={() => loadRooms()} style={{ width: '100%', marginTop: 8 }}>다시 시도</button>
      </div>
    )
  }

  if (!myName) {
    return <div className="card"><div className="empty">계정에 연결된 소환사 정보가 없어요. 관리자에게 문의해주세요.</div></div>
  }

  // ── 방 안 화면 ──────────────────────────────────────────────
  if (myRoom) {
    const myMember = myRoom.members.find(m => m.summoner_name === myName)
    const allReady = myRoom.members.length === 10 && myRoom.members.every(m => m.ready)

    return (
      <div className="room-layout">
        <div>
        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {myRoom.name}
            {isHost && <span style={{ fontSize: 11, color: 'var(--gold, #d4af37)' }}>👑 방장</span>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>참가자 {myRoom.members.length}/10</div>

          {!myRoom.result && countdown === null && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                {myRoom.members.map(m => {
                  const isMe = m.summoner_name === myName
                  const lines = getSummonerLines(m.summoner_name)
                  const pendingLines = pendingLinesMap[m.summoner_name] ?? []
                  const selectableLines = [...lines, ...pendingLines.filter(l => !lines.includes(l))]
                  return (
                    <div
                      key={m.summoner_name}
                      className="player-row"
                      style={{
                        padding: '8px 10px', flexWrap: 'wrap',
                        background: isMe ? (m.ready ? 'rgba(212,175,55,0.28)' : 'rgba(212,175,55,0.12)') : undefined,
                        border: isMe ? `${m.ready ? 1 : 0.5}px solid var(--gold, #d4af37)` : undefined,
                        borderRadius: isMe ? 'var(--radius)' : undefined,
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 13, minWidth: 80 }}>
                        <NameWithIdBadge name={m.summoner_name} idPrefixMap={idPrefixMap} />
                        {isMe && <span style={{ fontSize: 10, color: 'var(--gold, #d4af37)', marginLeft: 4 }}>(나)</span>}
                        {m.summoner_name === myRoom.host_summoner_name && <span style={{ fontSize: 10, color: 'var(--gold, #d4af37)', marginLeft: 4 }}>방장</span>}
                      </span>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 11, color: m.most1 === 'any' ? 'var(--text2)' : 'var(--gold)', fontWeight: 600 }}>M1</span>
                        {isMe ? (
                          <select
                            value={m.most1}
                            onChange={e => updateMyMost('most1', e.target.value)}
                            disabled={m.ready}
                            style={{ width: 95, padding: '4px 8px', fontSize: 12, opacity: m.ready ? 0.5 : 1, cursor: m.ready ? 'not-allowed' : 'pointer' }}
                          >
                            {lines.length >= 2 && <option value="any">상관없음</option>}
                            {selectableLines.map(l => (
                              <option key={l} value={l} disabled={pendingLines.includes(l)}>
                                {l}{pendingLines.includes(l) ? ' (허가신청)' : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="badge b-line" style={{ minWidth: 60, textAlign: 'center' }}>
                            {m.most1 === 'any' ? '상관없음' : m.most1}
                          </span>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>M2</span>
                        {isMe ? (
                          <select
                            value={m.most2 ?? ''}
                            onChange={e => updateMyMost('most2', e.target.value)}
                            disabled={m.most1 === 'any' || m.ready}
                            style={{ width: 95, padding: '4px 8px', fontSize: 12, opacity: (m.most1 === 'any' || m.ready) ? 0.4 : 1, cursor: m.ready ? 'not-allowed' : 'pointer' }}
                          >
                            <option value=''>없음</option>
                            {selectableLines.filter(l => l !== m.most1 && m.most1 !== 'any').map(l => (
                              <option key={l} value={l} disabled={pendingLines.includes(l)}>
                                {l}{pendingLines.includes(l) ? ' (허가신청)' : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="badge b-line" style={{ minWidth: 60, textAlign: 'center', opacity: m.most1 === 'any' || !m.most2 ? 0.4 : 1 }}>
                            {m.most1 === 'any' ? '-' : (m.most2 ?? '없음')}
                          </span>
                        )}
                      </div>

                      <span
                        className="badge"
                        style={{
                          marginLeft: 'auto', fontSize: m.ready ? 9 : 11, padding: '3px 8px', borderRadius: 999,
                          background: m.ready ? 'rgba(212,175,55,0.2)' : 'var(--bg3)',
                          color: m.ready ? 'var(--gold, #d4af37)' : 'var(--text3)',
                          border: `0.5px solid ${m.ready ? 'var(--gold, #d4af37)' : 'var(--border2)'}`,
                          fontWeight: m.ready ? 600 : 400,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {m.ready ? '✓준비완료' : '대기중'}
                      </span>

                      {isHost && m.summoner_name !== myRoom.host_summoner_name && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => kickMember(m.summoner_name)}
                          style={{ width: 'auto', flexShrink: 0, padding: '2px 8px', fontSize: 10, marginLeft: 4 }}
                        >
                          강퇴
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
                padding: '8px 10px', background: 'var(--bg3)', borderRadius: 'var(--radius)',
                border: '0.5px solid var(--border)'
              }}>
                <span style={{ fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap', flexShrink: 0 }}>팀 간 최대 점수차</span>
                {isHost ? (
                  <>
                    <input
                      type="range"
                      min={0}
                      max={10}
                      step={1}
                      value={myRoom.max_score_diff ?? 10}
                      onChange={e => updateMaxScoreDiff(Number(e.target.value))}
                      style={{ flex: 1, width: 'auto' }}
                    />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gold)', minWidth: 32, textAlign: 'right', flexShrink: 0 }}>
                      {myRoom.max_score_diff ?? 10}점
                    </span>
                  </>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 'auto' }}>{myRoom.max_score_diff ?? 10}점</span>
                )}
              </div>

              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
                padding: '8px 10px', background: 'var(--bg3)', borderRadius: 'var(--radius)',
                border: '0.5px solid var(--border)', flexWrap: 'nowrap', overflowX: 'auto'
              }}>
                <span style={{ fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap', flexShrink: 0 }}>매칭 방식</span>
                {isHost ? (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'nowrap' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      <input
                        type="radio"
                        checked={(myRoom.match_mode ?? 'line') === 'line'}
                        onChange={() => updateMatchMode('line')}
                        style={{ width: 'auto', flexShrink: 0 }}
                      />
                      라인밸런싱
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      <input
                        type="radio"
                        checked={myRoom.match_mode === 'random'}
                        onChange={() => updateMatchMode('random')}
                        style={{ width: 'auto', flexShrink: 0 }}
                      />
                      올랜덤
                    </label>
                  </div>
                ) : (
                  <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {(myRoom.match_mode ?? 'line') === 'line' ? '라인밸런싱' : '올랜덤'}
                  </span>
                )}
              </div>

              {isHost && dbIsAdmin && myRoom.members.length < 10 && (
                <button
                  className="btn"
                  onClick={fillTestMembers}
                  style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
                >
                  🧪 테스트 인원 채우기 (등록된 소환사로 {10 - myRoom.members.length}명 자동 추가 + 준비완료)
                </button>
              )}

              {myMember && (
                <button
                  className={`btn ${myMember.ready ? '' : 'btn-gold'}`}
                  onClick={toggleReady}
                  style={{ width: '100%', marginBottom: 8 }}
                >
                  {myMember.ready ? '준비 취소' : '준비완료'}
                </button>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger" onClick={leaveRoom} style={{ flex: 1 }}>
                  나가기
                </button>
                {isHost && (
                  <button
                    className="btn btn-gold"
                    onClick={runBalance}
                    disabled={!allReady || balancing}
                    style={{ flex: 1 }}
                  >
                    {balancing ? '편성 중...' : `팀편성 (${myRoom.members.filter(m => m.ready).length}/${myRoom.members.length})`}
                  </button>
                )}
              </div>
              {balanceError && <div className="error" style={{ marginTop: 8 }}>{balanceError}</div>}
            </>
          )}

          {!myRoom.result && countdown !== null && (
            <div style={{ textAlign: 'center', padding: '20px 0' }}>
              <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 8 }}>팀 편성 완료! 공개까지</div>
              <div style={{ fontSize: 64, fontWeight: 700, color: 'var(--blue)', lineHeight: 1, marginBottom: 16 }}>{countdown}</div>
              <div style={{ height: 4, background: 'var(--bg3)', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(3 - countdown) / 3 * 100}%`, background: 'var(--blue)', borderRadius: 2, transition: 'width 0.9s linear' }} />
              </div>
            </div>
          )}

          {myRoom.result && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <button className="btn btn-gold" onClick={async () => {
                  const sortedT1 = sortByLine(myRoom.result!.team1)
                  const sortedT2 = sortByLine(myRoom.result!.team2)
                  const t1Lines = sortedT1.map(p => `${p.line} **${p.name}** (${p.tier})`).join('\n')
                  const t2Lines = sortedT2.map(p => `${p.line} **${p.name}** (${p.tier})`).join('\n')
                  const diff = Math.abs(myRoom.result!.s1 - myRoom.result!.s2).toFixed(1)
                  const msg = {
                    embeds: [{
                      title: `🎮 팀 편성 결과 (${myRoom.name})`,
                      color: 0x0bc4e3,
                      fields: [
                        { name: `🔵 블루팀 (${myRoom.result!.s1.toFixed(1)}점)`, value: t1Lines, inline: true },
                        { name: `🔴 레드팀 (${myRoom.result!.s2.toFixed(1)}점)`, value: t2Lines, inline: true },
                      ],
                      footer: { text: `점수 차이: ${diff}점` },
                      timestamp: new Date().toISOString(),
                    }]
                  }
                  try {
                    const res = await fetch(DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
                    if (res.ok) alert('디스코드에 공유됐어요! 🎉')
                    else alert(`디스코드 전송 실패 (${res.status}): ${await res.text()}`)
                  } catch (err) {
                    alert('디스코드 전송 중 오류 발생: ' + (err as Error).message)
                  }
                }}>📢 디스코드 공유</button>
                {isHost && (
                  <button className="btn btn-danger" onClick={async () => {
                    if (!confirm('팀편성을 취소하고 대기 화면으로 돌아갈까요?')) return
                    // 취소한 조합도 last_result로 남겨서, 다시 팀편성할 때 같은 조합이 반복되지 않게 함
                    await supabase.from('rooms').update({ result: null, pending_result: null, balance_started_at: null, last_result: myRoom.result, updated_at: new Date().toISOString() }).eq('id', myRoom.id)
                  }}>🚪 탈주하기</button>
                )}
              </div>

              <div className="teams-grid">
                {[
                  { label: '🔵 블루팀', players: sortByLine(myRoom.result.team1), score: myRoom.result.s1, cls: 'blue' },
                  { label: '🔴 레드팀', players: sortByLine(myRoom.result.team2), score: myRoom.result.s2, cls: 'red' },
                ].map(team => (
                  <div key={team.cls} className={`team-card ${team.cls}`}>
                    <div className="team-header">
                      <span style={{ fontWeight: 700 }}>{team.label}</span>
                      <span style={{ fontSize: 13, color: 'var(--text2)' }}>{team.score.toFixed(1)}점</span>
                    </div>
                    {team.players.map(p => (
                      <div key={p.name} className="team-player">
                        <span style={{ width: 36, fontSize: 11, fontWeight: 500, color: 'var(--text2)', flexShrink: 0 }}>{p.line}</span>
                        <span style={{ flex: 1, fontWeight: 500 }}><NameWithIdBadge name={p.name} idPrefixMap={idPrefixMap} /></span>
                        <span className="badge b-tier" style={{ fontSize: 10 }}>{p.tier}</span>
                        <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 4 }}>{p.score.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <div style={{ textAlign: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text2)' }}>
                  점수 차이: <strong style={{ color: 'var(--gold)' }}>{Math.abs(myRoom.result.s1 - myRoom.result.s2).toFixed(1)}점</strong>
                </span>
              </div>

              {/* 예상 승률 */}
              {(() => {
                const result = myRoom.result!
                const blue1 = sortByLine(result.team1)
                const red1 = sortByLine(result.team2)
                const TIER_SCORE_MAP: Record<string, number> = {}
                TIERS.forEach((t, i) => { TIER_SCORE_MAP[t] = (TIERS.length - i) * 10 })

                const lineWrs = LINES.map(line => {
                  const bp = blue1.find(p => p.line === line)
                  const rp = red1.find(p => p.line === line)
                  if (!bp || !rp) return null
                  const matchRecs = records.filter(r => {
                    const bpInBlue = r.blue.some(p => p.name === bp.name && p.line === line)
                    const bpInRed = r.red.some(p => p.name === bp.name && p.line === line)
                    const rpInBlue = r.blue.some(p => p.name === rp.name && p.line === line)
                    const rpInRed = r.red.some(p => p.name === rp.name && p.line === line)
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
                    const bs = TIER_SCORE_MAP[bp.tier] ?? 50
                    const rs = TIER_SCORE_MAP[rp.tier] ?? 50
                    const diff2 = bs - rs
                    const wr = Math.min(0.9, Math.max(0.1, 0.5 + diff2 * 0.01))
                    return { line, wr, total: 0, estimated: true }
                  }
                }).filter(Boolean) as { line: string; wr: number; total: number; estimated: boolean }[]

                const totalWeight = lineWrs.reduce((s, l) => s + (l.total > 0 ? l.total : 3), 0)
                const blueWr = lineWrs.reduce((s, l) => s + l.wr * (l.total > 0 ? l.total : 3), 0) / totalWeight
                const blueWrPct = Math.round(blueWr * 100)
                const redWrPct = 100 - blueWrPct
                const hasEstimated = lineWrs.some(l => l.estimated)

                return (
                  <div className="card">
                    <div className="card-title">예상 승률</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--blue)' }}>🔵 블루팀</div>
                      <div style={{ fontSize: 11, color: 'var(--gold)', letterSpacing: 2 }}>VS</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--red)' }}>🔴 레드팀</div>
                    </div>
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
                  const result = myRoom.result!
                  const blue1 = sortByLine(result.team1)
                  const red1 = sortByLine(result.team2)
                  const matchups = LINES.map(line => {
                    const bp = blue1.find(p => p.line === line)
                    const rp = red1.find(p => p.line === line)
                    if (!bp || !rp) return null
                    const matchRecords = records.filter(r => {
                      const bpInBlue = r.blue.some(p => p.name === bp.name && p.line === line)
                      const bpInRed = r.red.some(p => p.name === bp.name && p.line === line)
                      const rpInBlue = r.blue.some(p => p.name === rp.name && p.line === line)
                      const rpInRed = r.red.some(p => p.name === rp.name && p.line === line)
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
                            <div style={{ flex: 1, textAlign: 'right' }}>
                              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--blue)' }}>{m.bp.name}</div>
                              <div style={{ fontSize: 11, color: 'var(--text2)' }}>{m.bp.tier}</div>
                            </div>
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

              <div className="card" style={{ textAlign: 'center' }}>
                <div className="card-title" style={{ marginBottom: 8 }}>경기 결과 기록</div>
                <div style={{ fontSize: 13, color: 'var(--text2)', marginBottom: 4 }}>어느 팀이 이겼나요?</div>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>🏆 이긴 팀은 티어 UP, 진 팀은 티어 DOWN</div>
                {!isHost ? (
                  <div className="empty">방장만 경기 결과를 기록할 수 있어요</div>
                ) : !isRecording ? (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button className="btn btn-blue" onClick={() => recordWin('blue')}>🔵 블루팀 승리</button>
                    <button className="btn btn-red" onClick={() => recordWin('red')}>🔴 레드팀 승리</button>
                  </div>
                ) : (
                  <div className="empty">기록 중...</div>
                )}
              </div>
            </>
          )}

          {(myRoom.result || countdown !== null) && (
            <button className="btn btn-danger" onClick={leaveRoom} style={{ width: '100%', marginTop: 12 }}>
              나가기
            </button>
          )}
        </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <RoomChat roomId={myRoom.id} myName={myName} />

          <div className="room-chat" style={{ height: 'auto', position: 'static' }}>
            <div className="room-chat-header">라인별 인원 (M1+M2 합산, 상관없음 포함)</div>
            <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {LINES.map(l => {
                const count = myRoom.members.reduce((acc, m) => {
                  let c = acc
                  if (m.most1 === l) c++
                  else if (m.most1 === 'any' && getSummonerLines(m.summoner_name).includes(l)) c++
                  if (m.most2 === l) c++
                  return c
                }, 0)
                const pct = myRoom.members.length > 0 ? Math.min(100, (count / myRoom.members.length) * 100) : 0
                return (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="badge b-line" style={{ width: 44, textAlign: 'center', flexShrink: 0 }}>{l}</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: 'var(--gold)', borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--text2)', minWidth: 28, textAlign: 'right', flexShrink: 0 }}>{count}명</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── 로비 화면 (방 만들기 / 목록) ──────────────────────────────
  return (
    <div>
      <div className="card">
        <div className="card-title">방 만들기</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            value={newRoomName}
            onChange={e => setNewRoomName(e.target.value)}
            placeholder={`방 이름 (예: ${myName}의 방)`}
            onKeyDown={e => e.key === 'Enter' && createRoom()}
          />
          <input
            type="password"
            value={newRoomPassword}
            onChange={e => setNewRoomPassword(e.target.value)}
            placeholder="비밀번호 (선택사항, 비워두면 누구나 입장 가능)"
            onKeyDown={e => e.key === 'Enter' && createRoom()}
          />
          <button className="btn btn-gold" onClick={createRoom} disabled={creating}>
            {creating ? '생성 중...' : '방 만들기'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>

      <div className="card">
        <div className="card-title">참가 가능한 방 ({rooms.filter(r => r.status === 'waiting').length})</div>
        {rooms.filter(r => r.status === 'waiting').length === 0 ? (
          <div className="empty">현재 열린 방이 없어요. 방을 만들어보세요!</div>
        ) : (
          rooms.filter(r => r.status === 'waiting').map(r => (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              background: 'var(--bg3)', borderRadius: 'var(--radius)', marginBottom: 8,
              border: '0.5px solid var(--border)'
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {r.name}
                  {r.has_password && <span style={{ fontSize: 11 }} title="비밀번호 방">🔒</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>방장: {r.host_summoner_name} · {r.members.length}/10명</div>
              </div>
              <button className="btn btn-sm" onClick={() => joinRoom(r)} disabled={r.members.length >= 10}>
                {r.members.length >= 10 ? '가득참' : '입장'}
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
// ── 비밀번호 강제 변경 화면 (초기화된 계정이 로그인했을 때) ────────────
function ForcePasswordChangeGate({ onDone }: { onDone: () => void }) {
  const [displayId, setDisplayId] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
      const loginIdMeta = (user?.user_metadata?.login_id ?? user?.user_metadata?.phone) as string | undefined
      if (loginIdMeta) { setDisplayId(loginIdMeta); return }
      if (user) {
        const { data } = await supabase.from('member_accounts').select('summoner_name').eq('user_id', user.id).maybeSingle()
        setDisplayId(data?.summoner_name ?? '')
      }
    })()
  }, [])

  const save = async () => {
    if (!oldPassword || !newPassword || !newPassword2) { setError('모든 항목을 입력해주세요'); return }
    if (newPassword.length < 4) { setError('새 비밀번호가 너무 짧아요'); return }
    if (newPassword === '1234') { setError('1234는 초기 비밀번호라 다른 값으로 설정해주세요'); return }
    if (newPassword !== newPassword2) { setError('새 비밀번호가 서로 일치하지 않아요'); return }
    setSaving(true)
    setError('')

    // 아이디를 추측해서 내부 인증키를 재구성하지 않고, 지금 로그인된 세션에 저장된 실제 값을 그대로 사용
    const { data: { session: currentSession } } = await supabase.auth.getSession()
    const currentUser = currentSession?.user ?? null
    if (!currentUser?.email) {
      setError('계정 정보를 확인할 수 없어요. 새로고침 후 다시 시도해주세요.')
      setSaving(false)
      return
    }
    const { error: verifyErr } = await supabase.auth.signInWithPassword({
      email: currentUser.email,
      password: oldPassword,
    })
    if (verifyErr) {
      setError('현재 비밀번호가 일치하지 않아요')
      setSaving(false)
      return
    }

    const { error: updateErr } = await supabase.auth.updateUser({ password: newPassword })
    if (updateErr) {
      setError('변경 실패: ' + updateErr.message)
      setSaving(false)
      return
    }

    const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
    if (user) {
      await supabase.from('member_accounts').update({ must_change_password: false }).eq('user_id', user.id)
    }

    setSaving(false)
    onDone()
  }

  return (
    <div style={{ maxWidth: 380, margin: '60px auto', padding: '0 16px' }}>
      <div className="card">
        <div className="card-title">비밀번호 변경 필요</div>
        <div style={{ color: 'var(--red)', fontWeight: 700, fontSize: 13, marginBottom: 14, lineHeight: 1.5 }}>
          비밀번호가 초기화된 계정이에요. 비밀번호를 변경하지 않으면 이용이 불가합니다.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input type="password" placeholder="현재 비밀번호 (1234)" value={oldPassword} onChange={e => setOldPassword(e.target.value)} disabled={saving} />
          <input type="password" placeholder="새 비밀번호" value={newPassword} onChange={e => setNewPassword(e.target.value)} disabled={saving} />
          <input type="password" placeholder="새 비밀번호 확인" value={newPassword2} onChange={e => setNewPassword2(e.target.value)} disabled={saving} onKeyDown={e => e.key === 'Enter' && save()} />
          <button className="btn btn-gold" onClick={save} disabled={saving}>{saving ? '변경 중...' : '비밀번호 변경'}</button>
        </div>
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
        <button
          className="btn btn-sm"
          onClick={async () => { await supabase.auth.signOut(); window.location.reload() }}
          style={{ width: '100%', marginTop: 12, fontSize: 11 }}
        >
          로그아웃
        </button>
      </div>
    </div>
  )
}

// ── 메인 페이지 ──────────────────────────────────────────────
function MainApp() {
  const [tab, setTab] = useState<'team' | 'record' | 'ranking' | 'hall' | 'stats' | 'summoners' | 'requests' | 'admin'>('team')
  const [dbIsAdmin, setDbIsAdmin] = useState(false)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [records, setRecords] = useState<GameRecord[]>([])
  const [summoners, setSummoners] = useState<SummonerMap>({})
  const [summonerScores, setSummonerScores] = useState<SummonerScoreMap>({})

  const [tierHistory, setTierHistory] = useState<{ record_id: number; name: string; line: string; tier_before: string; tier_after: string }[]>([])
  const [idPrefixMap, setIdPrefixMap] = useState<Record<string, string>>({})
  const [pendingLinesMap, setPendingLinesMap] = useState<Record<string, Line[]>>({})
  const [inactiveNames, setInactiveNames] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const fetchAll = useCallback(async () => {
    const [{ data: recs }, { data: sums }, { data: hist }, { data: prefixes }, { data: pendingLines }] = await Promise.all([
      supabase.from('records').select('*').order('created_at', { ascending: false }),
      supabase.from('summoners').select('*'),
      supabase.from('tier_history').select('*').order('id', { ascending: true }),
      supabase.rpc('summoner_id_prefixes'),
      supabase.rpc('pending_line_requests'),
    ])
    if (recs) setRecords(recs)
    if (hist) setTierHistory(hist)
    if (prefixes) {
      const pm: Record<string, string> = {}
      prefixes.forEach((p: { summoner_name: string; id_prefix: string }) => { pm[p.summoner_name] = p.id_prefix })
      setIdPrefixMap(pm)
    }
    if (pendingLines) {
      const plm: Record<string, Line[]> = {}
      pendingLines.forEach((p: { summoner_name: string; line: Line }) => {
        if (!plm[p.summoner_name]) plm[p.summoner_name] = []
        plm[p.summoner_name].push(p.line)
      })
      setPendingLinesMap(plm)
    }
    if (sums) {
      const map: SummonerMap = {}
      const scoreMap: SummonerScoreMap = {}
      const inactiveSet = new Set<string>()
      sums.forEach((s: { name: string; tier: string; line: Line; score?: number; is_inactive?: boolean }) => {
        if (!map[s.name]) map[s.name] = {} as Record<Line, string>
        if (!scoreMap[s.name]) scoreMap[s.name] = {} as Record<Line, number>
        if (s.is_inactive) inactiveSet.add(s.name)
        // score 컬럼이 있으면 그걸로 티어명 재계산, 없으면(마이그레이션 전) 기존 tier 그대로 사용
        const score = s.score ?? getScoreByTier(s.tier)
        scoreMap[s.name][s.line] = score
        map[s.name][s.line] = getTierByScore(score)
      })
      setSummoners(map)
      setSummonerScores(scoreMap)
      setInactiveNames(inactiveSet)
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])

  // 진짜 관리자 여부 확인 (DB의 member_accounts.is_admin 기준 — 비밀번호가 아니라 계정 자체의 권한)
  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc('is_admin')
      if (!error) setDbIsAdmin(!!data)
    })()
  }, [])

  // 비밀번호 강제 변경 필요 여부 확인 (비밀번호 찾기로 초기화된 계정인지)
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
      if (!user) return
      const { data } = await supabase.from('member_accounts').select('must_change_password').eq('user_id', user.id).maybeSingle()
      if (data?.must_change_password) setMustChangePassword(true)
    })()
  }, [])



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
    // 삭제할 전적 정보 조회 (승/패 참가자)
    const target = records.find(r => r.id === id)
    if (target) {
      const winners = target.winner === 'blue' ? target.blue : target.red
      const losers = target.winner === 'blue' ? target.red : target.blue
      // 승리자는 +1점 받았으니 -1점으로 되돌리고, 패배자는 -1점 받았으니 +1점으로 되돌림
      for (const p of winners) {
        const { data: row } = await supabase.from('summoners').select('score, tier').eq('name', p.name).eq('line', p.line).single()
        if (row) {
          const newScore = (row.score ?? getScoreByTier(row.tier)) - 1
          await supabase.from('summoners').update({ score: newScore, tier: getTierByScore(newScore) }).eq('name', p.name).eq('line', p.line)
        }
      }
      for (const p of losers) {
        const { data: row } = await supabase.from('summoners').select('score, tier').eq('name', p.name).eq('line', p.line).single()
        if (row) {
          const newScore = (row.score ?? getScoreByTier(row.tier)) + 1
          await supabase.from('summoners').update({ score: newScore, tier: getTierByScore(newScore) }).eq('name', p.name).eq('line', p.line)
        }
      }
    }
    await supabase.from('tier_history').delete().eq('record_id', id)
    await supabase.from('records').delete().eq('id', id)
    setRecords(prev => prev.filter(r => r.id !== id))
    await fetchAll()
  }

  const clearRecords = async () => {
    if (!confirm('전체 기록을 삭제할까요? 티어(점수)도 전부 0판 상태로 롤백돼요!')) return
    if (!checkPassword()) return
    // 모든 전적을 역순으로 롤백
    for (const r of records) {
      const winners = r.winner === 'blue' ? r.blue : r.red
      const losers = r.winner === 'blue' ? r.red : r.blue
      for (const p of winners) {
        const { data: row } = await supabase.from('summoners').select('score, tier').eq('name', p.name).eq('line', p.line).single()
        if (row) {
          const newScore = (row.score ?? getScoreByTier(row.tier)) - 1
          await supabase.from('summoners').update({ score: newScore, tier: getTierByScore(newScore) }).eq('name', p.name).eq('line', p.line)
        }
      }
      for (const p of losers) {
        const { data: row } = await supabase.from('summoners').select('score, tier').eq('name', p.name).eq('line', p.line).single()
        if (row) {
          const newScore = (row.score ?? getScoreByTier(row.tier)) + 1
          await supabase.from('summoners').update({ score: newScore, tier: getTierByScore(newScore) }).eq('name', p.name).eq('line', p.line)
        }
      }
    }
    await supabase.from('tier_history').delete().neq('id', 0)
    await supabase.from('records').delete().neq('id', 0)
    setRecords([])
    await fetchAll()
  }


  return (
    <div className="layout">
      {/* 양옆 캐릭터 이미지 */}
      <div style={{
        position: 'fixed', left: 0, top: 0, bottom: 0, width: 280,
        display: 'flex', alignItems: 'flex-end', pointerEvents: 'none', zIndex: 0,
        overflow: 'hidden',
      } as React.CSSProperties} className="char-side">
        <img
          src="https://ddragon.leagueoflegends.com/cdn/img/champion/splash/LeeSin_0.jpg"
          alt="리신"
          style={{
            height: '90vh', maxHeight: 750, objectFit: 'cover', objectPosition: '30% top',
            opacity: 0.5,
            transform: 'translateX(-55%)',
            WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 55%, black 100%), linear-gradient(to top, transparent 0%, black 20%)',
            WebkitMaskComposite: 'destination-in',
            maskImage: 'linear-gradient(to right, transparent 0%, black 55%, black 100%), linear-gradient(to top, transparent 0%, black 20%)',
            maskComposite: 'intersect',
          }}
        />
      </div>
      <div style={{
        position: 'fixed', right: 0, top: 0, bottom: 0, width: 280,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', pointerEvents: 'none', zIndex: 0,
        overflow: 'hidden',
      } as React.CSSProperties} className="char-side">
        <img
          src="https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Ahri_0.jpg"
          alt="아리"
          style={{
            height: '90vh', maxHeight: 750, objectFit: 'cover', objectPosition: '70% top',
            opacity: 0.5,
            transform: 'translateX(40%)',
            WebkitMaskImage: 'linear-gradient(to left, transparent 0%, black 55%, black 100%), linear-gradient(to top, transparent 0%, black 20%)',
            WebkitMaskComposite: 'destination-in',
            maskImage: 'linear-gradient(to left, transparent 0%, black 55%, black 100%), linear-gradient(to top, transparent 0%, black 20%)',
            maskComposite: 'intersect',
          }}
        />
      </div>

      <div className="header" style={{ background: 'transparent', backdropFilter: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div className="header-title">⚔ 내전 매니저</div>
          <div className="header-sub">티어·라인 기반 팀 균형 매칭 + 전적 기록</div>
        </div>
        <button
          className="btn btn-sm"
          onClick={async () => {
            await supabase.auth.signOut()
            window.location.reload()
          }}
          style={{ fontSize: 11, whiteSpace: 'nowrap' }}
        >
          로그아웃
        </button>
      </div>

      {mustChangePassword ? (
        <ForcePasswordChangeGate onDone={() => setMustChangePassword(false)} />
      ) : (
        <>
          <div className="tabs" style={{ background: 'rgba(6,17,31,0.75)' }}>
            {(['team', 'record', 'ranking', 'hall', 'stats', 'summoners'] as const).map((t, i) => (
              <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
                {['내전방', '전적 기록', '전체 랭킹', '명예의 전당', '개인 통계', '내 정보'][i]}
              </button>
            ))}
            {dbIsAdmin && (
              <button className={`tab${tab === 'requests' ? ' active' : ''}`} onClick={() => setTab('requests')}>
                허가요청
              </button>
            )}
            {dbIsAdmin && (
              <button className={`tab${tab === 'admin' ? ' active' : ''}`} onClick={() => setTab('admin')}>
                소환사 관리
              </button>
            )}
          </div>

          {loading ? (
            <div className="empty">불러오는 중...</div>
          ) : (
            <>
              {tab === 'team' && <RoomsTab summoners={summoners} summonerScores={summonerScores} records={records} idPrefixMap={idPrefixMap} pendingLinesMap={pendingLinesMap} onRecord={addRecord} dbIsAdmin={dbIsAdmin} inactiveNames={inactiveNames} />}
              {tab === 'record' && <RecordTab records={records} onDelete={deleteRecord} onClear={clearRecords} isAdmin={dbIsAdmin} />}
              {tab === 'ranking' && <RankingTab records={records} />}
              {tab === 'hall' && <HallOfFameTab records={records} />}
              {tab === 'stats' && <StatsTab records={records} summoners={summoners} summonerScores={summonerScores} tierHistory={tierHistory} idPrefixMap={idPrefixMap} />}

              {tab === 'summoners' && <MyInfoTab summoners={summoners} summonerScores={summonerScores} onRefresh={fetchAll} />}

              {tab === 'requests' && dbIsAdmin && <ApprovalRequestsTab onRefresh={fetchAll} />}

              {tab === 'admin' && dbIsAdmin && (
                <div>
                  <AdminTab summoners={summoners} summonerScores={summonerScores} records={records} />
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Auth 래퍼 (로그인 체크) ──────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 초기 auth 상태 체크
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      setUser(session?.user ?? null)
      setLoading(false)
    }
    checkAuth()

    // auth 상태 변화 리스닝
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null)
    })

    return () => subscription?.unsubscribe()
  }, [])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center',
        background: 'linear-gradient(135deg, #0a0e27 0%, #1a1f3a 100%)'
      }}>
        <div style={{ color: 'var(--text2)' }}>로드 중...</div>
      </div>
    )
  }

  if (!user) {
    return <LoginPage onAuthSuccess={() => {}} />
  }

  return <MainApp />
}
