'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Line } from '@/lib/data'
import { LINES, getScore, getTierByScore, getScoreByTier, shuffle } from '@/lib/data'
import {
  supabase, SummonerMap, SummonerScoreMap, GameRecord, TeamPlayer, BalanceResult,
  PlayerEntry, NameWithIdBadge, LINE_ORDER, DISCORD_WEBHOOK_URL, tierBadgeStyle, lineBadgeStyle,
  riotIdToLolPsUrl
} from '@/lib/shared'
import RoomChat from './RoomChat'

// 방 채팅 기능 on/off 스위치 — 롤 내부 채팅이 있어서 당장은 불필요하다고 판단해 UI만 꺼둠.
// 기능/코드는 그대로 남겨뒀으니, 나중에 다시 켜고 싶으면 이 값만 true로 바꾸면 됨.
const CHAT_ENABLED = false

type RoomMember = {
  user_id: string
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
  detailed_matching: boolean | null
  used_champions: Partial<Record<Line, string[]>> | null
  result: BalanceResult | null
  pending_result: BalanceResult | null
  last_result: BalanceResult | null
  recent_team_history: { ids1: string[]; ids2: string[] }[]
  autofill_protected_ids: string[]
  guaranteed_m1_ids: string[]
  pending_autofill_delta: { added: string[]; removedFromGuaranteed: string[] } | null
  balance_started_at: string | null
  created_at: string
  has_password: boolean
}

function resultSignature(r: BalanceResult): string {
  const teamSig = (team: TeamPlayer[]) => team.map(p => `${p.userId}:${p.line}`).sort().join(',')
  const sigs = [teamSig(r.team1), teamSig(r.team2)].sort()
  return sigs.join('|')
}

// 라인 영향력(캐리력) 가중치 — 2026-09 시즌1 데이터 분석 결과(미드>원딜>탑>정글 >> 서포터)를 약하게 반영.
// 최고수준팀편성(runBalance)과 예상 승률 카드가 같은 값을 공유하도록 모듈 레벨로 뺌.
const LINE_CARRY_WEIGHT: Record<Line, number> = { 미드: 1.0, 원딜: 1.0, 탑: 1.0, 정글: 1.0, 서포터: 0.7 }
// 상대전적을 신뢰할 수 있다고 보는 최소 표본 수
const MIN_H2H_SAMPLE = 10

// 점수(티어)차이 → 예상 승률. 시즌1 데이터 분석 결과 diff 0~5점은 실제 승률에 거의 영향이 없었고(47~48%대,
// 50%와 통계적으로 구분 안 됨), diff 6점부터 실제로 승률이 갈리기 시작(diff 6+ 구간 58.8%)하는 패턴을 반영.
// line을 넘기면 그 라인의 캐리력 가중치만큼 "50%에서 벗어나는 정도"를 스케일링(서포터는 약하게, 나머지는 그대로).
function estimateWrFromScoreDiff(diff: number, line?: Line): number {
  const abs = Math.abs(diff)
  if (abs <= 5) return 0.5
  const weight = line ? LINE_CARRY_WEIGHT[line] : 1
  const extra = Math.min(0.35, 0.09 + (abs - 6) * 0.02) * weight
  const wr = 0.5 + Math.sign(diff) * extra
  return Math.min(0.9, Math.max(0.1, wr))
}

// team1(블루) 승률 예측 — "예상 승률" 카드에 쓰는 것과 완전히 동일한 로직(라인별 티어차이+라인영향력 +
// 상대전적 10판 이상 블렌딩 → 라인별 신뢰도 가중평균)을 최고수준팀편성(runBalance)에서도 그대로 재사용.
// 두 곳이 서로 다른 기준으로 계산하면 화면에 보이는 예상 승률과 실제 선택 기준이 어긋날 수 있으므로
// 하나의 함수로 통일함(최고수준팀편성 자체는 승률이 아니라 총점 기준으로 고르지만, 점수 산정 로직은 공유).
function predictTeamWinRate(team1: TeamPlayer[], team2: TeamPlayer[], records: GameRecord[]): {
  blueWr: number
  lineWrs: { line: Line; wr: number; total: number; blended: boolean }[]
} {
  const lineWrs = LINES.map(line => {
    const bp = team1.find(p => p.line === line)
    const rp = team2.find(p => p.line === line)
    if (!bp || !rp) return null
    const scoreWr = estimateWrFromScoreDiff(bp.score - rp.score, line)
    const matchRecs = records.filter(r => {
      const bpInBlue = r.blue.some(p => p.userId === bp.userId && p.line === line)
      const bpInRed = r.red.some(p => p.userId === bp.userId && p.line === line)
      const rpInBlue = r.blue.some(p => p.userId === rp.userId && p.line === line)
      const rpInRed = r.red.some(p => p.userId === rp.userId && p.line === line)
      return (bpInBlue && rpInRed) || (bpInRed && rpInBlue)
    })
    const total = matchRecs.length
    if (total >= MIN_H2H_SAMPLE) {
      const bpWin = matchRecs.filter(r => {
        const bpInBlue = r.blue.some(p => p.userId === bp.userId && p.line === line)
        return (bpInBlue && r.winner === 'blue') || (!bpInBlue && r.winner === 'red')
      }).length
      const h2hWr = bpWin / total
      const h2hWeight = Math.min(0.8, total / 25)
      const wr = h2hWeight * h2hWr + (1 - h2hWeight) * scoreWr
      return { line, wr, total, blended: true }
    }
    return { line, wr: scoreWr, total, blended: false }
  }).filter(Boolean) as { line: Line; wr: number; total: number; blended: boolean }[]

  const lineWeight = (l: { total: number; blended: boolean }) => l.blended ? 5 + l.total : 1
  const totalWeight = lineWrs.reduce((s, l) => s + lineWeight(l), 0)
  const blueWr = totalWeight > 0 ? lineWrs.reduce((s, l) => s + l.wr * lineWeight(l), 0) / totalWeight : 0.5
  return { blueWr, lineWrs }
}

// 검색형 챔피언 선택 드롭다운 — 챔피언이 160개가 넘어서 일반 select 스크롤은 보기 힘들어서,
// 타이핑해서 검색하고 결과를 최대 5개까지만 보여주는 방식으로 만듦
function ChampionSelect({
  champions, value, onChange, placeholderName, disabled,
}: {
  champions: { id: string; name: string }[]
  value: string
  onChange: (id: string) => void
  placeholderName: string
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const selected = champions.find(c => c.id === value)
  const filtered = (query ? champions.filter(c => c.name.includes(query)) : champions).slice(0, 5)

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <input
        value={focused ? query : (selected?.name ?? '')}
        onFocus={() => { setFocused(true); setQuery('') }}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        onChange={e => setQuery(e.target.value)}
        placeholder={`${placeholderName} 챔피언 검색`}
        disabled={disabled}
        style={{ width: '100%', fontSize: 10, padding: '3px 4px', boxSizing: 'border-box' }}
      />
      {focused && filtered.length > 0 && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          marginTop: 2, maxHeight: 5 * 24, overflowY: 'auto',
        }}>
          {filtered.map(c => (
            <div
              key={c.id}
              onMouseDown={() => { onChange(c.id); setQuery(''); setFocused(false) }}
              style={{ padding: '4px 8px', fontSize: 11, cursor: 'pointer' }}
            >
              {c.name}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RoomsTab({
  summoners,
  summonerScores,
  records,
  idPrefixMap,
  riotIdMap,
  correctionMap,
  loginIdStatusMap,
  onRecord,
  dbIsAdmin,
  inactiveNames,
  nameByUserId,
}: {
  summoners: SummonerMap
  summonerScores: SummonerScoreMap
  records: GameRecord[]
  idPrefixMap: Record<string, string>
  riotIdMap: Record<string, string>
  correctionMap: Record<string, { needs_correction: boolean; correction_note: string | null }>
  loginIdStatusMap: Record<string, boolean>
  onRecord: (r: { winner: 'blue' | 'red'; blue: { name: string; line: Line }[]; red: { name: string; line: Line }[]; skipInsert?: boolean }) => void
  dbIsAdmin: boolean
  inactiveNames: Set<string>
  nameByUserId: Record<string, string>
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

  const myRoom = rooms.find(r => r.members.some(m => m.user_id === myUserId)) ?? null
  const isHost = !!myRoom && myRoom.host_user_id === myUserId

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
  const [roomClosedNotice, setRoomClosedNotice] = useState(false)
  useEffect(() => {
    if (!myRoom?.id) { reloadChannelRef.current = null; return }
    const channel = supabase.channel(`room-events-${myRoom.id}`)
    channel.on('broadcast', { event: 'reload' }, () => { window.location.reload() })
    // 4판을 채워서 방이 자동으로 닫힐 때는 곧바로 새로고침하지 않고, 이유를 먼저 안내함
    channel.on('broadcast', { event: 'room_closed_4games' }, () => { setRoomClosedNotice(true) })
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
    if (!myName || !myUserId) return
    if (myRoom) { setError('이미 다른 방에 참가 중이에요. 먼저 나가주세요.'); return }
    if (room.members.length >= 10) { setError('방이 가득 찼어요.'); return }
    if (room.members.some(m => m.user_id === myUserId)) return
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

  // 관리자가 방 목록에서 임의의 방을 강제 삭제 (방장이 나가면 방장 본인 방은 어차피 자동삭제되므로,
  // 이건 방장이 아니라 관리자용 — 방치되거나 꼬인 방을 정리하기 위한 기능)
  const deleteRoomAsAdmin = async (room: Room) => {
    if (!dbIsAdmin) return
    if (!confirm(`"${room.name}" 방을 삭제할까요? 참가자 전원이 방에서 나가지게 돼요.`)) return
    const { error: err } = await supabase.rpc('admin_delete_room', { p_room_id: room.id })
    if (err) setError('방 삭제 실패: ' + err.message)
    else await loadRooms()
  }

  const leaveRoom = async () => {
    if (!myRoom || !myUserId) return
    if (isHost) {
      // 방장이 나가면 방 자체가 삭제됨
      if (!confirm('방장이 나가면 방이 삭제돼요. 나갈까요?')) return
      await supabase.from('rooms').delete().eq('id', myRoom.id)
    } else {
      const { error: err } = await supabase.rpc('leave_room_member', { p_room_id: myRoom.id })
      if (err) console.error('방 나가기 실패:', err.message)
    }
    await loadRooms()
  }

  const updateMyMost = async (field: 'most1' | 'most2', value: string) => {
    if (!myRoom || !myUserId) return
    const myEntry = myRoom.members.find(m => m.user_id === myUserId)
    if (myEntry?.ready) return // 준비완료 상태에서는 라인 변경 불가 (UI에서도 비활성화되어 있지만 이중 확인)
    const roomId = myRoom.id
    // 낙관적 업데이트: 내 화면은 즉시 반영 (실제 저장은 서버에서 원자적으로 처리되어 다른 사람 변경과 안 부딪힘)
    setRooms(prev => prev.map(r => {
      if (r.id !== roomId) return r
      const newMembers = r.members.map(m => {
        if (m.user_id !== myUserId) return m
        if (field === 'most1') {
          if (value === 'any') return { ...m, most1: 'any' as const, most2: null }
          const clearedMost2 = m.most2 === value ? null : m.most2
          return { ...m, most1: value as Line, most2: clearedMost2 }
        }
        return { ...m, most2: (value || null) as Line | 'any' | null }
      })
      return { ...r, members: newMembers }
    }))
    const { error: err } = await supabase.rpc('set_my_most', { p_room_id: roomId, p_field: field, p_value: value })
    if (err) { console.error('라인 변경 실패:', err.message); await loadRooms() }
  }

  const toggleReady = async () => {
    if (!myRoom || !myUserId) return
    const roomId = myRoom.id
    const newReady = !myRoom.members.find(m => m.user_id === myUserId)?.ready
    setRooms(prev => prev.map(r => r.id === roomId
      ? { ...r, members: r.members.map(m => m.user_id === myUserId ? { ...m, ready: newReady } : m) }
      : r))
    const { error: err } = await supabase.rpc('set_ready', { p_room_id: roomId, p_ready: newReady })
    if (err) { console.error('준비 상태 변경 실패:', err.message); await loadRooms() }
  }

  // 방장이 다른 참가자를 강퇴 — 계정ID로 정확히 그 사람만 지목, 서버에서 원자적으로 처리
  const kickMember = async (targetUserId: string, targetName: string) => {
    if (!myRoom || !isHost || targetUserId === myRoom.host_user_id) return
    if (!confirm(`${targetName}님을 강퇴할까요?`)) return
    const roomId = myRoom.id
    setRooms(prev => prev.map(r => r.id === roomId
      ? { ...r, members: r.members.filter(m => m.user_id !== targetUserId) }
      : r))
    const { error: err } = await supabase.rpc('kick_member', { p_room_id: roomId, p_target_user_id: targetUserId })
    if (err) { console.error('강퇴 실패:', err.message); await loadRooms() }
  }

  // 관리자 전용 테스트 기능: 등록된 다른 소환사들로 방을 10명까지 자동으로 채우고
  // 전부 준비완료 상태로 만들어서, 혼자서도 매칭 테스트를 해볼 수 있게 함.
  // 무작위로 뽑으면 라인이 한쪽으로 쏠려서 밸런싱이 실패할 수 있으므로,
  // "아직 2명이 안 채워진 라인"부터 우선적으로 채우는 방식으로 채움.
  // 실전과 비슷하게 테스트되도록, 같은 라인 필요 인원 중에서는 판수(경험치) 많은 사람을 우선 선택함
  // — 판수가 많을수록 자연스럽게 다른 사람들과의 상대전적도 쌓여있을 확률이 높아서, "상대전적 없는 사람들끼리만
  // 붙는" 비현실적인 테스트 세팅을 피할 수 있음.
  const fillTestMembers = async () => {
    if (!myRoom || !isHost || !dbIsAdmin) return
    const existingIds = new Set(myRoom.members.map(m => m.user_id))
    const need = 10 - myRoom.members.length
    if (need <= 0) {
      // 이미 10명 채워진 상태(예: 직전 테스트판 기록 후 전원 준비 해제됨)에서 다시 누르면,
      // 새로 채울 필요는 없으니 지금 있는 10명을 전부 다시 준비완료로 돌려서 같은 방에서 반복 테스트가 되게 함
      const reReadied = myRoom.members.map(m => ({ ...m, ready: true }))
      await supabase.from('rooms').update({ members: reReadied, updated_at: new Date().toISOString() }).eq('id', myRoom.id)
      return
    }

    const targetLines: Line[] = ['탑', '정글', '미드', '원딜', '서포터']
    // 이미 방에 있는 사람들의 M1 기준으로 현재 라인별 인원 카운트 (M1='상관없음'인 사람은 유동적이라 카운트에서 제외)
    const lineCount: Record<Line, number> = { 탑: 0, 정글: 0, 미드: 0, 원딜: 0, 서포터: 0 }
    myRoom.members.forEach(m => {
      if (m.most1 !== 'any') lineCount[m.most1 as Line] = (lineCount[m.most1 as Line] ?? 0) + 1
    })

    // 라인별/전체 판수 집계 — 전적 데이터 기준으로 "얼마나 활동적인 유저인지" 판단
    const totalGamesCache = new Map<string, number>()
    const totalGames = (uid: string): number => {
      const cached = totalGamesCache.get(uid)
      if (cached !== undefined) return cached
      const n = records.filter(r => r.blue.some(p => p.userId === uid) || r.red.some(p => p.userId === uid)).length
      totalGamesCache.set(uid, n)
      return n
    }
    const linePlayCache = new Map<string, number>()
    const linePlayCount = (uid: string, line: Line): number => {
      const key = `${uid}|${line}`
      const cached = linePlayCache.get(key)
      if (cached !== undefined) return cached
      const n = records.filter(r =>
        r.blue.some(p => p.userId === uid && p.line === line) ||
        r.red.some(p => p.userId === uid && p.line === line)
      ).length
      linePlayCache.set(key, n)
      return n
    }

    // 후보 풀: 아직 방에 없는 + 비활성화되지 않은 + 롤 계정이 등록된 실제 계정만
    // (계정ID 기준 — 동명이인도 각자 정확히 후보가 됨. 롤 계정 미등록자는 ready:true로 강제 채워도
    //  실제 게임이 불가능한 상태라 애초에 후보에서 제외해야 함)
    let pool = Object.entries(nameByUserId)
      .filter(([uid, name]) => !existingIds.has(uid) && !inactiveNames.has(uid) && !!riotIdMap[uid])
      .map(([uid, name]) => ({ userId: uid, name, lines: getSummonerLines(uid) }))
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

      // 우선순위: ① 그 라인 판수 많은 사람 → ② 전체 판수(활동량) 많은 사람 → ③ 동률이면 등록 라인 적은(대체 어려운) 사람
      candidates.sort((a, b) => {
        const lineDiff = linePlayCount(b.userId, target) - linePlayCount(a.userId, target)
        if (lineDiff !== 0) return lineDiff
        const totalDiff = totalGames(b.userId) - totalGames(a.userId)
        if (totalDiff !== 0) return totalDiff
        return a.lines.length - b.lines.length
      })
      const chosen = candidates[0]

      // M2도 그냥 아무 다른 라인이 아니라, 부족한 라인 중(있으면) 본인이 가장 많이 해본 라인으로
      const otherLines = chosen.lines.filter(l => l !== target)
      const neededOthers = otherLines.filter(l => lineCount[l] < 2)
      const pickFrom = neededOthers.length > 0 ? neededOthers : otherLines
      const most2 = pickFrom.length > 0
        ? pickFrom.reduce((best, l) => linePlayCount(chosen.userId, l) > linePlayCount(chosen.userId, best) ? l : best, pickFrom[0])
        : null

      newFilled.push({ user_id: chosen.userId, summoner_name: chosen.name, most1: target, most2, ready: true })
      lineCount[target]++
      pool = pool.filter(c => c.userId !== chosen.userId)
    }

    // 그래도 인원이 부족하면(등록된 소환사 자체가 적은 경우) 라인 무관하게 남은 후보로 채움 — 이때도 판수 많은 사람 우선
    if (newFilled.length < need) {
      const filledIds = new Set(newFilled.map(f => f.user_id))
      const leftover = pool.filter(c => !filledIds.has(c.userId))
        .sort((a, b) => totalGames(b.userId) - totalGames(a.userId))
        .slice(0, need - newFilled.length)
      leftover.forEach(c => {
        const sortedLines = [...c.lines].sort((a, b) => linePlayCount(c.userId, b) - linePlayCount(c.userId, a))
        newFilled.push({ user_id: c.userId, summoner_name: c.name, most1: (sortedLines[0] ?? '탑') as Line, most2: sortedLines[1] ?? null, ready: true })
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
    const players: PlayerEntry[] = myRoom.members.map(m => ({ userId: m.user_id, name: m.summoner_name, most1: m.most1, most2: m.most2 }))
    if (players.length !== 10) { setBalanceError(`정확히 10명이 필요해요. (현재 ${players.length}명)`); return }
    if (!myRoom.members.every(m => m.ready)) { setBalanceError('모든 참가자가 준비완료 상태여야 해요.'); return }
    // ready 상태가 어떤 경로로 true가 됐든(테스트 인원 채우기 등), 롤 계정 미등록자가 섞여 있으면
    // 여기서 다시 한번 막음 — "준비완료" 버튼 우회로 인한 미등록자 참여를 근본적으로 차단
    const noRiotMembers = myRoom.members.filter(m => !riotIdMap[m.user_id])
    if (noRiotMembers.length > 0) {
      setBalanceError(`롤 계정이 등록되지 않은 참가자가 있어요: ${noRiotMembers.map(m => m.summoner_name).join(', ')}`)
      return
    }

    setBalancing(true)

    const getAdjustedScore = (userId: string, line: Line, tier: string): number => {
      return summonerScores[userId]?.[line] ?? getScoreByTier(tier)
    }
    // 등록되지 않은 라인(M1/M2 외 라인)에 배정될 때의 점수 추정 — 고정 골드2 대신,
    // 본인 M2 라인 점수보다 5점 낮게 잡음 (M2 등록 정보가 없으면 M1 기준으로 5점 낮게, 그마저 없으면 최후 수단으로 골드2)
    const resolveTierScore = (p: PlayerEntry, line: Line): { tier: string; score: number } => {
      const regTier = summoners[p.userId]?.[line]
      if (regTier) return { tier: regTier, score: getAdjustedScore(p.userId, line, regTier) }
      const m2Line = (p.most2 && p.most2 !== 'any') ? p.most2 as Line : null
      const m1Line = (p.most1 && p.most1 !== 'any') ? p.most1 as Line : null
      const baseLine = m2Line ?? m1Line
      const baseTier = baseLine ? summoners[p.userId]?.[baseLine] : undefined
      if (baseLine && baseTier) {
        const score = getAdjustedScore(p.userId, baseLine, baseTier) - 5
        return { tier: getTierByScore(score), score }
      }
      // 등록된 라인 정보가 전혀 없는 예외적인 경우의 최후 fallback
      return { tier: '골드2', score: getScoreByTier('골드2') }
    }
    const buildPlayer = (p: PlayerEntry, line: Line): TeamPlayer => {
      const { tier, score } = resolveTierScore(p, line)
      return { userId: p.userId, name: p.name, tier, line, score }
    }

    // ── 최고수준팀편성 ──────────────────────
    const useDetailedMatching = !!myRoom.detailed_matching
    const MIN_PROVEN_GAMES = 10
    const MAX_DIFF = useDetailedMatching ? 2 : 5
    const linePlayCountCache = new Map<string, number>()
    const linePlayCount = (userId: string, line: Line): number => {
      const key = `${userId}|${line}`
      const cached = linePlayCountCache.get(key)
      if (cached !== undefined) return cached
      const n = records.filter(r =>
        r.blue.some(p => p.userId === userId && p.line === line) ||
        r.red.some(p => p.userId === userId && p.line === line)
      ).length
      linePlayCountCache.set(key, n)
      return n
    }
    // 최고수준팀편성: 라인별 점수뿐 아니라 "이 사람 자체가 전체적으로 고티어인지"도 우선순위에 반영 —
    // 본인이 등록한 라인들 중 가장 높은 점수(피크 티어)를 그 사람의 전체 수준으로 봄.
    const overallScoreCache = new Map<string, number>()
    const overallScore = (userId: string): number => {
      const cached = overallScoreCache.get(userId)
      if (cached !== undefined) return cached
      const lines = getSummonerLines(userId)
      const scores = lines.map(l => summonerScores[userId]?.[l]).filter((s): s is number => typeof s === 'number')
      const s = scores.length > 0 ? Math.max(...scores) : 0
      overallScoreCache.set(userId, s)
      return s
    }

    const protectedIds = new Set<string>(myRoom.autofill_protected_ids ?? [])
    const guaranteedIds = new Set<string>(myRoom.guaranteed_m1_ids ?? [])
    const lastSig = myRoom.last_result ? resultSignature(myRoom.last_result) : null
    const historyTeams: string[][] = (myRoom.recent_team_history ?? []).flatMap(h => [h.ids1, h.ids2])
    const violatesRepeat = (team: TeamPlayer[]): boolean => {
      const ids = new Set(team.map(p => p.userId))
      return historyTeams.some(histTeam => histTeam.filter(id => ids.has(id)).length >= 2)
    }

    // ── 직전 판과 비교해서, 같은 라인에서 같은 두 명이 다시 붙는 경우(팀은 바뀌어도 매치업 자체가 동일)를 세어서
    // 5라인 중 3라인까지만 허용 (4~5라인이 겹치면 사실상 팀이 거의 그대로인 거라 제외) ──
    const lastResult = myRoom.last_result ?? null
    const MAX_SAME_LINE_MATCHUPS = 3
    const getLinePair = (r: BalanceResult, line: Line): Set<string> | null => {
      const a = r.team1.find(p => p.line === line)?.userId
      const b = r.team2.find(p => p.line === line)?.userId
      return (a && b) ? new Set([a, b]) : null
    }
    const countSameLineMatchups = (r: BalanceResult): number => {
      if (!lastResult) return 0
      let count = 0
      for (const l of LINES) {
        const prevPair = getLinePair(lastResult, l)
        const curPair = getLinePair(r, l)
        if (prevPair && curPair && prevPair.size === 2 && Array.from(prevPair).every(id => curPair.has(id))) count++
      }
      return count
    }
    const isLineDiverse = (r: BalanceResult): boolean => countSameLineMatchups(r) <= MAX_SAME_LINE_MATCHUPS

    // ── 라인별 공급 계산: M1/M2/상관없음을 다 합쳐서 2명이 안 되는 라인만 "부족한 라인"으로 취급 ──
    // M1='상관없음'은 실제로 전 라인에 랜덤 배정될 수 있으므로 모든 라인의 공급으로 카운트.
    // M2='상관없음'은 실제 배정 로직상 항상 M1으로 고정되고(=없음과 동일), 다른 라인에는 절대 안 걸리므로
    // '없음'과 똑같이 공급 계산에서 제외 — 예전엔 여기서 전 라인 공급으로 잘못 카운트해서
    // 실제로는 부족한 라인이 "충분한 라인"으로 착각되는 불일치가 있었음
    const linePossible: Record<Line, number> = { 탑: 0, 정글: 0, 미드: 0, 원딜: 0, 서포터: 0 }
    players.forEach(p => {
      const allLines = getSummonerLines(p.userId)
      if (p.most1 === 'any') allLines.forEach(l => { linePossible[l] = (linePossible[l] ?? 0) + 1 })
      else linePossible[p.most1 as Line] = (linePossible[p.most1 as Line] ?? 0) + 1
      if (p.most2 && p.most2 !== 'any') linePossible[p.most2 as Line] = (linePossible[p.most2 as Line] ?? 0) + 1
    })
    const insufficientLines = LINES.filter(l => linePossible[l] < 2)
    const sufficientLines = LINES.filter(l => linePossible[l] >= 2)

    const slots: Record<Line, PlayerEntry[]> = { 탑: [], 정글: [], 미드: [], 원딜: [], 서포터: [] }
    const assignedIds = new Set<string>()
    const tryAssign = (p: PlayerEntry, line: Line) => {
      if (slots[line].length < 2 && !assignedIds.has(p.userId)) {
        slots[line].push(p)
        assignedIds.add(p.userId)
      }
    }
    // 지난판 튕긴 사람의 M1 보장은, 그 라인이 이번에도 부족한 라인일 때만 여기서 강제로 확정 (충분한 라인이면 아래 일반 탐색에서 자연스럽게 배정됨)
    shuffle(players.filter(p => guaranteedIds.has(p.userId) && p.most1 !== 'any' && insufficientLines.includes(p.most1 as Line)))
      .forEach(p => tryAssign(p, p.most1 as Line))

    // 부족한 라인만 먼저 우선순위대로 강제 확정 (M1 → M2 → 상관없음 → 진짜 튕김)
    const priorityFillLine = (line: Line) => {
      // 부족한 라인은 정의상 M1+M2+상관없음을 합쳐도 2명 미만이라, 굳이 순서를 나눌 필요 없이
      // 그 라인을 원했던 사람(M1/M2/상관없음)이 있으면 그대로 쓰고, 나머지는 강제 배정.
      // 최고수준팀편성일 때는 여기서도 무작위(shuffle) 대신 점수 높은 사람을 우선해서, 같은 멤버로 여러 번
      // 눌러도 부족한 라인에 매번 다른 티어의 사람이 랜덤하게 끼어들어 총점이 들쭉날쭉해지는 걸 막음.
      // 최고수준팀편성 우선순위: 전체적으로 고티어인 사람(overallScore)을 먼저 보고, 같은 수준이면 그 라인 점수로 판가름
      const detailedPriority = (a: PlayerEntry, b: PlayerEntry) =>
        (overallScore(b.userId) - overallScore(a.userId)) || (resolveTierScore(b, line).score - resolveTierScore(a, line).score)
      const wantsLine = players.filter(p => !assignedIds.has(p.userId) && (p.most1 === line || p.most2 === line || p.most1 === 'any'))
      ;(useDetailedMatching
        ? [...wantsLine].sort(detailedPriority)
        : shuffle(wantsLine)
      ).forEach(p => tryAssign(p, line))
      while (slots[line].length < 2) {
        const remaining = players.filter(p => !assignedIds.has(p.userId))
        if (remaining.length === 0) break
        // 보호 대상(직전 판에 튕겼던 사람)은 무조건 피함 — 후보가 없으면 이 자리는 그냥 비워둠(강제로 보호 깨지 않음)
        const eligible = remaining.filter(p => !protectedIds.has(p.userId))
        if (eligible.length === 0) break
        const pick = useDetailedMatching
          ? [...eligible].sort(detailedPriority)[0]
          : shuffle(eligible)[0]
        tryAssign(pick, line)
      }
    }
    insufficientLines.forEach(priorityFillLine)

    // ── 남은 사람 + 남은(충분한) 라인만으로 기존 점수 밸런싱 탐색 (부족했던 라인은 이미 확정됐으니 건드리지 않음) ──
    const remainingPlayers = players.filter(p => !assignedIds.has(p.userId))
    const remainingLines = sufficientLines
    const candidates: { diff: number; result: BalanceResult }[] = []

    // 최고수준팀편성 전용: 라인 배정에 "우선순위"를 둠 — 같은 라인(특히 M1)을 원하는 사람들끼리는
    // 검증된 라인(10판 이상) 중 티어(점수) 높은 사람이 먼저 그 라인을 가져가도록 미리 한 번만 계산해둠.
    // (일반 모드처럼 매 반복마다 무작위로 배정하면 고티어가 밀려날 수 있어서, 이 모드에서는 결정론적으로 고정함)
    const detailedFixedLine = new Map<string, Line>()
    if (useDetailedMatching && remainingLines.length > 0) {
      const capacity: Partial<Record<Line, number>> = {}
      remainingLines.forEach(l => { capacity[l] = 2 })
      const unassigned = new Set(remainingPlayers.map(p => p.userId))
      type Req = { p: PlayerEntry; line: Line; score: number; overall: number; isM1: boolean }
      const candidateLinesFor = (p: PlayerEntry): Line[] => {
        const allLines = getSummonerLines(p.userId)
        return p.most1 === 'any'
          ? allLines.filter(l => remainingLines.includes(l))
          : [p.most1 as Line, ...(p.most2 && p.most2 !== 'any' ? [p.most2 as Line] : [])].filter(l => remainingLines.includes(l))
      }
      const buildRequests = (): Req[] => {
        const reqs: Req[] = []
        remainingPlayers.forEach(p => {
          if (!unassigned.has(p.userId)) return
          const candidateLines = candidateLinesFor(p)
          const provenLines = candidateLines.filter(l => linePlayCount(p.userId, l) >= MIN_PROVEN_GAMES)
          const useLines = provenLines.length > 0 ? provenLines : candidateLines
          useLines.forEach(l => reqs.push({ p, line: l, score: resolveTierScore(p, l).score, overall: overallScore(p.userId), isM1: p.most1 === l }))
        })
        return reqs
      }
      // 전체적으로 고티어인 사람(overall)을 최우선으로, 같은 수준이면 그 라인에서의 점수로 판가름
      const reqPriority = (a: Req, b: Req) => (b.overall - a.overall) || (b.score - a.score)
      // 1단계: M1 요청만 우선순위 순으로 우선 배정
      for (let round = 0; unassigned.size > 0 && round < 10; round++) {
        const m1Reqs = buildRequests().filter(r => r.isM1 && (capacity[r.line] ?? 0) > 0).sort(reqPriority)
        if (m1Reqs.length === 0) break
        let progressed = false
        for (const r of m1Reqs) {
          if (!unassigned.has(r.p.userId) || (capacity[r.line] ?? 0) <= 0) continue
          detailedFixedLine.set(r.p.userId, r.line)
          capacity[r.line] = (capacity[r.line] ?? 0) - 1
          unassigned.delete(r.p.userId)
          progressed = true
        }
        if (!progressed) break
      }
      // 2단계: 남은 사람은 M2/그 외 검증된 후보 중 우선순위 순으로, 자리가 남은 라인에 배정
      for (let round = 0; unassigned.size > 0 && round < 10; round++) {
        const reqs = buildRequests().filter(r => (capacity[r.line] ?? 0) > 0).sort(reqPriority)
        if (reqs.length === 0) break
        let progressed = false
        for (const r of reqs) {
          if (!unassigned.has(r.p.userId) || (capacity[r.line] ?? 0) <= 0) continue
          detailedFixedLine.set(r.p.userId, r.line)
          capacity[r.line] = (capacity[r.line] ?? 0) - 1
          unassigned.delete(r.p.userId)
          progressed = true
        }
        if (!progressed) break
      }
      // 3단계: 그래도 남으면(후보 라인이 전부 꽉 찼거나 후보 자체가 없는 예외 상황) 남은 라인에 강제 배정
      Array.from(unassigned).forEach(uid => {
        const p = remainingPlayers.find(pl => pl.userId === uid)!
        const openLine = remainingLines.find(l => (capacity[l] ?? 0) > 0)
        if (openLine) {
          detailedFixedLine.set(uid, openLine)
          capacity[openLine] = (capacity[openLine] ?? 0) - 1
          unassigned.delete(uid)
        }
      })
    }

    if (remainingLines.length > 0 && remainingPlayers.length === remainingLines.length * 2) {
      for (let i = 0; i < 3000; i++) {
        const assigned = remainingPlayers.map(p => {
          // 전판에 튕겼던 사람의 M1 보장 — 이 라인이 충분한 라인이라 강제확정 대상은 아니지만,
          // 랜덤 탐색 안에서 아주 높은 확률로 M1을 받도록 우선 처리 (거의 모든 후보에서 보장이 지켜짐)
          if (guaranteedIds.has(p.userId) && p.most1 !== 'any' && remainingLines.includes(p.most1 as Line) && Math.random() < 0.97) {
            const line = p.most1 as Line
            const { score } = resolveTierScore(p, line)
            return { userId: p.userId, name: p.name, line, score }
          }
          const allLines = getSummonerLines(p.userId)
          let line: Line
          if (useDetailedMatching) {
            // 최고수준팀편성: 위에서 미리 계산해둔 우선순위 기반(검증된 라인 + 고티어 M1 우선) 배정을 그대로 사용
            line = detailedFixedLine.get(p.userId) ?? (
              remainingLines.includes(p.most1 as Line) ? p.most1 as Line : remainingLines[0]
            )
          } else if (p.most1 === 'any') {
            const opts = allLines.filter(l => remainingLines.includes(l))
            const pool = opts.length > 0 ? opts : remainingLines
            line = pool[Math.floor(Math.random() * pool.length)]
          } else if (!p.most2 || p.most2 === 'any') {
            line = p.most1 as Line
          } else {
            const isM2 = Math.random() >= 0.7
            line = isM2 ? p.most2 as Line : p.most1 as Line
          }
          const { score } = resolveTierScore(p, line)
          return { userId: p.userId, name: p.name, line, score }
        })

        const lineCounts: Record<string, number> = {}
        assigned.forEach(p => { lineCounts[p.line] = (lineCounts[p.line] ?? 0) + 1 })
        const valid = remainingLines.every(l => (lineCounts[l] ?? 0) === 2)
        if (!valid) continue

        const t1: TeamPlayer[] = [], t2: TeamPlayer[] = []
        let ok = true
        for (const l of LINES) {
          let pair: TeamPlayer[]
          if (insufficientLines.includes(l)) {
            pair = slots[l].map(p => buildPlayer(p, l))
          } else {
            pair = shuffle(assigned.filter(p => p.line === l)).map(p => {
              const entry = remainingPlayers.find(pl => pl.userId === p.userId)!
              const { tier } = resolveTierScore(entry, l)
              return { userId: p.userId, name: p.name, tier, line: l, score: p.score }
            })
          }
          if (pair.length < 2) { ok = false; break }
          t1.push(pair[0]); t2.push(pair[1])
        }
        if (!ok || t1.length !== 5 || t2.length !== 5) continue

        const s1 = t1.reduce((a, p) => a + p.score, 0)
        const s2 = t2.reduce((a, p) => a + p.score, 0)
        const diff = Math.abs(s1 - s2)

        // 한 명의 점수가 팀 총점의 5분의 2(40%) 이상을 차지하면 그 팀 구성은 제외 (매칭 방식 상관없이 항상 적용)
        const t1MaxPlayer = Math.max(...t1.map(p => p.score))
        const t2MaxPlayer = Math.max(...t2.map(p => p.score))
        if (t1MaxPlayer >= s1 * 2 / 5 || t2MaxPlayer >= s2 * 2 / 5) continue

        const candidateResult: BalanceResult = { team1: t1, team2: t2, s1, s2 }
        // 최고수준팀편성은 라인 배정 자체가 고정이라 나올 수 있는 조합의 가짓수가 원래도 적은데,
        // "직전 판과 똑같은 조합이면 제외" 규칙까지 걸리면 하필 그 유일한 조합이 걸려서 매칭이 통째로 실패할 수 있음
        // → 반복회피 규칙은 이 모드에서 애초에 무시하기로 했으니 여기서도 적용 안 함
        if (!useDetailedMatching && lastSig && resultSignature(candidateResult) === lastSig) continue

        let maxLineDiff = 0
        for (const l of LINES) {
          const p1 = t1.find(p => p.line === l)
          const p2 = t2.find(p => p.line === l)
          if (p1 && p2) maxLineDiff = Math.max(maxLineDiff, Math.abs(p1.score - p2.score))
        }
        const t1Bot = t1.filter(p => p.line === '원딜' || p.line === '서포터').reduce((a, p) => a + p.score, 0)
        const t2Bot = t2.filter(p => p.line === '원딜' || p.line === '서포터').reduce((a, p) => a + p.score, 0)
        const botDiff = Math.abs(t1Bot - t2Bot)
        if ((myRoom.match_mode ?? 'line') === 'line' && (maxLineDiff >= 40 || botDiff >= 35)) continue

        candidates.push({ diff, result: candidateResult })
      }
    }

    const isRepeatFree = (c: { result: BalanceResult }) => !violatesRepeat(c.result.team1) && !violatesRepeat(c.result.team2)
    const isDiverse = (c: { result: BalanceResult }) => isLineDiverse(c.result)

    // 5점을 넘는 조합은 어떤 경우에도 쓰지 않음.
    // diff가 가장 낮은 조합 "딱 1개"만 쓰면 같은 멤버로 여러 판 돌릴 때 매번 거의 같은 팀 구성이 나오는 경향이 있어서,
    // diff<=5(안전 기준)를 만족하는 후보들 중에서는 밸런스 차이가 없다고 보고 무작위로 하나를 뽑음.
    // 우선순위: (반복회피 + 직전판 라인매치업 3라인 이하) > (라인매치업 3라인 이하) > (반복회피만) > 아무거나
    // — 라인 다양성 조건을 못 맞추면 단계적으로 완화해서, 그래도 5점 이내 조합이 있으면 반드시 하나는 뽑음
    const okCandidates = candidates.filter(c => c.diff <= MAX_DIFF)
    let basePickPool: typeof okCandidates
    if (useDetailedMatching) {
      // 최고수준팀편성: 반복회피/라인 다양성 같은 소프트 제약은 전부 무시하고 diff<=5 후보 전체를 대상으로 함
      basePickPool = okCandidates
    } else {
      const bestPool = okCandidates.filter(c => isRepeatFree(c) && isDiverse(c))
      const diversePool = bestPool.length > 0 ? bestPool : okCandidates.filter(isDiverse)
      const repeatFreePool = diversePool.length > 0 ? diversePool : okCandidates.filter(isRepeatFree)
      basePickPool = repeatFreePool.length > 0 ? repeatFreePool : okCandidates
    }
    // 최고수준팀편성 on: diff<=5 후보들 중에서 총점(s1+s2)이 가장 높은 조합을 최우선으로 고름.
    // 완전히 매번 똑같은 조합만 나오진 않게, 최고 총점 기준 아주 좁은 오차범위(±1점) 안에 든 조합들 중에서만 무작위 선택.
    let pickPool = basePickPool
    if (useDetailedMatching && basePickPool.length > 1) {
      const scored = basePickPool
        .map(c => ({ c, total: c.result.s1 + c.result.s2 }))
        .sort((a, b) => b.total - a.total)
      const bestTotal = scored[0].total
      pickPool = scored.filter(s => s.total >= bestTotal - 1).map(s => s.c)
    }
    let chosen: BalanceResult | null =
      pickPool.length > 0 ? pickPool[Math.floor(Math.random() * pickPool.length)].result : null

    // 위에서도 못 찾았으면(남은 라인들도 밸런스가 전혀 안 맞았던 경우), 남은 라인까지 전부 강제 배정으로 완성한 뒤
    // 팀을 나누는 32가지 경우의 수 중 최선을 찾음 (그래도 5점 넘으면 실패 처리)
    if (!chosen) {
      remainingLines.forEach(priorityFillLine)

      const pairs = LINES.map(line => slots[line].map(p => buildPlayer(p, line)))
      if (pairs.some(pair => pair.length < 2)) {
        setBalanceError('보호 대상(직전 판에 튕겼던 사람)을 피하다 보니 자리를 다 못 채웠어요. 잠시 후 다시 시도해주세요.')
        setBalancing(false)
        return
      }
      const allCombos: BalanceResult[] = []
      for (let mask = 0; mask < 32; mask++) {
        const team1: TeamPlayer[] = [], team2: TeamPlayer[] = []
        LINES.forEach((_, i) => {
          const [a, b] = pairs[i]
          const bit = (mask >> i) & 1
          team1.push(bit === 0 ? a : b)
          team2.push(bit === 0 ? b : a)
        })
        const s1 = team1.reduce((s, p) => s + p.score, 0)
        const s2 = team2.reduce((s, p) => s + p.score, 0)
        allCombos.push({ team1, team2, s1, s2 })
      }
      const isCleanAF = (c: BalanceResult) =>
        (!lastSig || resultSignature(c) !== lastSig) && !violatesRepeat(c.team1) && !violatesRepeat(c.team2)
      // 한 명의 점수가 팀 총점의 5분의 2(40%) 이상을 차지하면 그 조합은 제외
      const isFairAF = (c: BalanceResult) => {
        const t1Max = Math.max(...c.team1.map(p => p.score))
        const t2Max = Math.max(...c.team2.map(p => p.score))
        return t1Max < c.s1 * 2 / 5 && t2Max < c.s2 * 2 / 5
      }

      // 여기도 마찬가지로 diff<=5를 만족하는 후보 중 "가장 낮은 diff 1개"가 아니라 무작위로 선택해서
      // 매번 같은 팀 모양이 나오는 걸 줄임. 우선순위는 메인 탐색과 동일하게 단계적으로 완화
      const fairCombos = allCombos.filter(c => Math.abs(c.s1 - c.s2) <= MAX_DIFF && isFairAF(c))
      let baseComboPool: BalanceResult[]
      if (useDetailedMatching) {
        // 최고수준팀편성: 반복회피/라인 다양성 무시하고 diff<=5 조합 전체를 대상으로 함
        baseComboPool = fairCombos
      } else {
        const bestFairCombos = fairCombos.filter(c => isCleanAF(c) && isLineDiverse(c))
        const diverseFairCombos = bestFairCombos.length > 0 ? bestFairCombos : fairCombos.filter(isLineDiverse)
        const cleanFairCombos = diverseFairCombos.length > 0 ? diverseFairCombos : fairCombos.filter(isCleanAF)
        baseComboPool = cleanFairCombos.length > 0 ? cleanFairCombos : fairCombos
      }
      let comboPool = baseComboPool
      if (useDetailedMatching && baseComboPool.length > 1) {
        const scoredCombos = baseComboPool
          .map(c => ({ c, total: c.s1 + c.s2 }))
          .sort((a, b) => b.total - a.total)
        const bestTotal = scoredCombos[0].total
        comboPool = scoredCombos.filter(s => s.total >= bestTotal - 1).map(s => s.c)
      }
      chosen = comboPool.length > 0 ? comboPool[Math.floor(Math.random() * comboPool.length)] : null
    }

    if (!chosen) {
      setBalanceError(`점수차 ${MAX_DIFF}점 이내로 맞는 조합을 찾지 못했어요. M1/M2 설정을 조정하거나 인원 구성을 바꿔서 다시 시도해주세요.`)
      setBalancing(false)
      return
    }

    // 이번에 M1/M2가 아닌 라인이 걸린 사람 = "튕긴" 사람 → 보호/보장 목록 갱신
    const allAssigned = [...chosen.team1, ...chosen.team2]
    const newlyAutofilled = allAssigned.filter(tp => {
      const orig = players.find(p => p.userId === tp.userId)!
      return orig.most1 !== 'any' && orig.most1 !== tp.line && orig.most2 !== tp.line
    }).map(tp => tp.userId)

    const fulfilledGuarantees = allAssigned.filter(tp => {
      const orig = players.find(p => p.userId === tp.userId)!
      return guaranteedIds.has(tp.userId) && orig.most1 === tp.line
    }).map(tp => tp.userId)

    const newProtected = Array.from(new Set([...(myRoom.autofill_protected_ids ?? []), ...newlyAutofilled]))
    const newGuaranteed = Array.from(new Set([
      ...(myRoom.guaranteed_m1_ids ?? []).filter((id: string) => !fulfilledGuarantees.includes(id)),
      ...newlyAutofilled,
    ]))
    const delta = { added: newlyAutofilled, removedFromGuaranteed: fulfilledGuarantees }

    const startedAt = new Date().toISOString()
    await supabase.from('rooms').update({
      pending_result: chosen,
      balance_started_at: startedAt,
      autofill_protected_ids: newProtected,
      guaranteed_m1_ids: newGuaranteed,
      pending_autofill_delta: delta,
    }).eq('id', myRoom.id)

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
  // 전적 기록 2중 확인장치: 버튼 누르면 바로 기록하지 않고, 한 번 더 확인받은 후에만 기록
  const [confirmingWinner, setConfirmingWinner] = useState<'blue' | 'red' | null>(null)
  const recordingRef = useRef(false)

  // 피어리스+챔피언 전적 기록용: 라이엇 Data Dragon에서 최신 챔피언 목록을 받아와 드롭다운으로 씀
  // (패치마다 새 챔피언이 나와도 코드 수정 없이 항상 최신 목록을 유지하기 위해, 하드코딩 대신 런타임에 가져옴)
  const [championList, setChampionList] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    (async () => {
      try {
        const versRes = await fetch('https://ddragon.leagueoflegends.com/api/versions.json')
        const vers: string[] = await versRes.json()
        const latest = vers[0]
        const champRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/ko_KR/champion.json`)
        const champJson = await champRes.json()
        const list = Object.values(champJson.data as Record<string, { id: string; name: string }>)
          .map(c => ({ id: c.id, name: c.name }))
          .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
        setChampionList(list)
      } catch (e) {
        console.error('챔피언 목록을 불러오지 못했어요:', e)
      }
    })()
  }, [])
  // userId -> 이번 판에 등록한 챔피언
  const [pendingChampions, setPendingChampions] = useState<Record<string, string>>({})

  const recordWin = async (winner: 'blue' | 'red') => {
    if (!myRoom?.result || recordingRef.current || !isHost) return
    recordingRef.current = true
    setConfirmingWinner(null)
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
    const blueData = result.team1.map(p => ({ userId: p.userId, name: p.name, line: p.line, champion: pendingChampions[p.userId] ?? null }))
    const redData = result.team2.map(p => ({ userId: p.userId, name: p.name, line: p.line, champion: pendingChampions[p.userId] ?? null }))
    // 서버(apply_match_score_delta)가 실제로 적용한 정확한 적용전/후 값을 여기 담아둠 —
    // 디스코드 메시지가 이 값을 그대로 써서, 화면(브라우저)이 새로고침 안 됐어도 항상 정확하게 표시됨
    const scoreResults: Record<string, { old_score: number; old_tier: string; new_score: number; new_tier: string; delta_applied: number }> = {}
    const scoreFailures: string[] = []

    const { data: newRecord } = await supabase.from('records').insert([{ winner, blue: blueData, red: redData, time, blue_score: result.s1, red_score: result.s2 }]).select()
    const recId = newRecord?.[0]?.id

    const { data: latestRecs } = await supabase.from('records').select('*').order('created_at', { ascending: false })
    const updatedRecords = (latestRecs ?? []) as GameRecord[]

    if (recId) {
      for (const p of winners) {
        const { data: rpcData, error: rpcErr } = await supabase.rpc('apply_match_score_delta', { p_record_id: recId, p_user_id: p.userId, p_name: p.name, p_line: p.line, p_delta: 1 })
        if (rpcErr) { console.error('점수 반영 실패:', p.name, p.line, rpcErr.message); scoreFailures.push(`${p.name}(${p.line})`) }
        else if (rpcData?.[0]) scoreResults[p.userId] = rpcData[0]
      }
      for (const p of losers) {
        const { data: rpcData, error: rpcErr } = await supabase.rpc('apply_match_score_delta', { p_record_id: recId, p_user_id: p.userId, p_name: p.name, p_line: p.line, p_delta: -1 })
        if (rpcErr) { console.error('점수 반영 실패:', p.name, p.line, rpcErr.message); scoreFailures.push(`${p.name}(${p.line})`) }
        else if (rpcData?.[0]) scoreResults[p.userId] = rpcData[0]
      }

      // 서버(apply_match_score_delta)가 돌려준 "적용 직전 정확한 점수"를 그대로 blue/red JSON에 박아둠 —
      // 이제부턴 경기 시점 점수를 나중에 score_events로 역산할 필요 없이, records 테이블만 보면 항상 정확한 매치 당시 점수를 알 수 있음.
      // (RPC가 실패한 극히 드문 경우에만 팀편성 당시 클라이언트 점수로 대체)
      const withScore = (arr: { userId: string; name: string; line: Line; champion: string | null }[], side: TeamPlayer[]) =>
        arr.map(p => ({
          ...p,
          score: scoreResults[p.userId]?.old_score ?? side.find(t => t.userId === p.userId)?.score ?? null,
        }))
      const blueDataFinal = withScore(blueData, result.team1)
      const redDataFinal = withScore(redData, result.team2)
      const blueScoreBefore = blueDataFinal.reduce((a, p) => a + (p.score ?? 0), 0)
      const redScoreBefore = redDataFinal.reduce((a, p) => a + (p.score ?? 0), 0)
      await supabase.from('records').update({
        blue: blueDataFinal,
        red: redDataFinal,
        blue_score: blueScoreBefore,
        red_score: redScoreBefore,
      }).eq('id', recId)
    }

    onRecord({ winner, blue: blueData, red: redData, skipInsert: true })
    setPendingChampions({})

    // 방 초기화: 참가자는 유지하되 전부 준비 해제 (다음 판 위해 다시 준비해야 함)
    // 방금 진행한 팀편성은 last_result로 저장 — 다음 팀편성 때 완전히 같은 조합이 다시 나오지 않게 하기 위함
    // recent_team_history에도 추가(최근 4판까지만 유지) — 5명 중 2명 이상 다시 같은 팀 되는 것 방지용
    const newHistoryEntry = { ids1: result.team1.map(p => p.userId), ids2: result.team2.map(p => p.userId) }
    const updatedHistory = [newHistoryEntry, ...(myRoom.recent_team_history ?? [])].slice(0, 4)
    const roomShouldClose = updatedHistory.length >= 4

    // 피어리스: 이번 판에 등록한 챔피언을 라인별로 누적(중복 제거) — 이 방(=이 세션)이 살아있는 동안만 유지되고,
    // 방이 닫히면(4판 소진) 자연히 초기화됨
    const updatedUsedChampions: Partial<Record<Line, string[]>> = { ...(myRoom.used_champions ?? {}) }
    for (const p of [...blueData, ...redData]) {
      if (!p.champion) continue
      const existing = updatedUsedChampions[p.line] ?? []
      if (!existing.includes(p.champion)) updatedUsedChampions[p.line] = [...existing, p.champion]
    }

    if (roomShouldClose) {
      // 탈주하기(취소) 제외, 실제로 플레이된 경기가 4판이 되면 방을 자동으로 삭제 (채팅도 같이 삭제됨)
      await supabase.from('rooms').delete().eq('id', myRoom.id)
    } else {
      const resetMembers = myRoom.members.map(m => ({ ...m, ready: false }))
      // 경기가 실제로 기록됐으니 튕김 보호/보장은 이미 반영된 상태를 그대로 유지 (되돌릴 델타는 정리)
      await supabase.from('rooms').update({
        members: resetMembers, last_result: result, recent_team_history: updatedHistory,
        pending_autofill_delta: null, used_champions: updatedUsedChampions,
      }).eq('id', myRoom.id)
    }

    // 디스코드 전송
    try {
      const now2 = new Date()
      const dateStr = `${now2.getFullYear()}년 ${now2.getMonth() + 1}월 ${now2.getDate()}일 ${String(now2.getHours()).padStart(2, '0')}:${String(now2.getMinutes()).padStart(2, '0')}`
      const sortedWinners = [...winners].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))
      const sortedLosers = [...losers].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))

      const getStreak = (userId: string, line: Line, recs: GameRecord[]) => {
        const lr = recs.filter(r => r.blue.some(p => p.userId === userId && p.line === line) || r.red.some(p => p.userId === userId && p.line === line))
        if (lr.length < 2) return 0
        const first = lr[0]
        const isWin = (first.blue.some(p => p.userId === userId && p.line === line) && first.winner === 'blue') ||
                      (first.red.some(p => p.userId === userId && p.line === line) && first.winner === 'red')
        let s = 0
        for (const r of lr) {
          const inBlue = r.blue.some(p => p.userId === userId && p.line === line)
          const w = (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
          if (w === isWin) s++; else break
        }
        return isWin ? s : -s
      }

      const fmtPlayer = (p: TeamPlayer, isWinner: boolean) => {
        const sr = scoreResults[p.userId]
        // 서버가 실제로 적용한 값이 있으면 그걸 그대로 씀 (항상 정확함). 없으면(드문 예외 상황) 기존 방식으로 대략 계산
        const beforeTier = sr?.old_tier ?? (summoners[p.userId]?.[p.line] ?? p.tier)
        const beforeScore = sr?.old_score ?? (summonerScores[p.userId]?.[p.line] ?? getScoreByTier(p.tier))
        const afterTier = sr?.new_tier ?? beforeTier
        const afterScore = sr?.new_score ?? beforeScore
        const actualDelta = sr ? Math.abs(sr.delta_applied) : 1
        const streak = getStreak(p.userId, p.line, updatedRecords)
        const abs = Math.abs(streak)
        const tierChange = afterTier !== beforeTier
          ? `↳ ${beforeTier} → ${afterTier} ${isWinner ? '▲' : '▼'}`
          : `↳ ${afterTier} (변동없음)`
        const scoreChange = `↳ ${beforeScore}점 → ${afterScore}점 (${isWinner ? '+' : '-'}${actualDelta})`
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

    // 나머지 참가자들에게 신호 전송: 방이 4판을 채워서 닫혔으면 이유 안내, 아니면 그냥 새로고침
    if (reloadChannelRef.current) {
      try {
        await reloadChannelRef.current.send({
          type: 'broadcast',
          event: roomShouldClose ? 'room_closed_4games' : 'reload',
          payload: {},
        })
      } catch (e) { console.error('알림 전송 실패:', e) }
    }

    setIsRecording(false)
    recordingRef.current = false

    if (scoreFailures.length > 0) {
      alert(`⚠ 다음 플레이어의 점수 반영이 실패했어요: ${scoreFailures.join(', ')}\n관리자에게 알려서 수동으로 확인해달라고 해주세요.`)
    }

    if (roomShouldClose) {
      // 방장 본인 화면에도 동일하게 안내 (본인이 보낸 브로드캐스트는 본인한테 안 돌아오므로 직접 처리)
      setRoomClosedNotice(true)
    } else {
      window.location.reload()
    }
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

  // ── 방 4판 만료 안내 (다른 화면보다 우선 표시) ──────────────────────
  if (roomClosedNotice) {
    return (
      <div className="card" style={{ maxWidth: 420, margin: '40px auto', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>🏁</div>
        <div className="card-title" style={{ textAlign: 'center', fontSize: 16, marginBottom: 10 }}>4판 만료</div>
        <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.6, marginBottom: 20 }}>
          이 방은 4판을 모두 진행해서 자동으로 종료됐어요.<br />
          <span style={{ color: 'var(--gold, #d4af37)' }}>피어리스 초기화</span> — 새로운 방부터는 팀 반복 방지 기록도 새로 시작돼요.
        </div>
        <button className="btn btn-gold" style={{ width: '100%' }} onClick={() => window.location.reload()}>
          확인
        </button>
      </div>
    )
  }

  // ── 방 안 화면 ──────────────────────────────────────────────
  if (myRoom) {
    const myMember = myRoom.members.find(m => m.user_id === myUserId)
    const allReady = myRoom.members.length === 10 && myRoom.members.every(m => m.ready)

    return (
      <div className="room-layout">
        <div>
        <div className="card">
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {myRoom.name}
            {isHost && <span style={{ fontSize: 11, color: 'var(--gold, #d4af37)' }}>👑 방장</span>}
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }} title={`이번 방에서 ${4 - (myRoom.recent_team_history?.length ?? 0)}/4판 남음 (다 쓰면 방이 자동으로 사라져요)`}>
              {[0, 1, 2, 3].map(i => {
                const remaining = 4 - (myRoom.recent_team_history?.length ?? 0)
                const filled = i < remaining
                return (
                  <span
                    key={i}
                    style={{
                      width: 8, height: 8, borderRadius: 2,
                      background: filled ? 'var(--gold2)' : 'var(--text3)',
                      opacity: filled ? 1 : 0.4,
                    }}
                  />
                )
              })}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>
            참가자 {myRoom.members.length}/10
          </div>

          {!myRoom.result && countdown === null && (
            <>
              {/* 피어리스: 이 방에서 이미 쓴 챔피언을 라인별로(팀 구분 없이) 표시 */}
              {myRoom.used_champions && LINES.some(l => (myRoom.used_champions?.[l]?.length ?? 0) > 0) && (
                <div style={{ padding: '10px 13px', borderRadius: 12, background: 'var(--bg3)', marginBottom: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--gold3)', marginBottom: 6 }}>
                    🚫 이번 방에서 사용한 챔피언 (피어리스)
                  </div>
                  {LINES.map(line => {
                    const usedIds = myRoom.used_champions?.[line] ?? []
                    if (usedIds.length === 0) return null
                    return (
                      <div key={line} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 4 }}>
                        <span className="badge b-line" style={{ flexShrink: 0, fontSize: 9 }}>{line}</span>
                        <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.5 }}>
                          {usedIds.map(id => championList.find(c => c.id === id)?.name ?? id).join(', ')}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                {myRoom.members.map(m => {
                  const isMe = m.user_id === myUserId
                  const isHostRow = m.user_id === myRoom.host_user_id
                  const lines = getSummonerLines(m.user_id)
                  return (
                    <div
                      key={m.user_id}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 13px',
                        borderRadius: 12, background: 'var(--bg3)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                          {(() => {
                            const riotId = riotIdMap[m.user_id]
                            const lolPsUrl = riotId ? riotIdToLolPsUrl(riotId) : null
                            return lolPsUrl ? (
                              <a
                                href={lolPsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
                                title="lol.ps에서 전적 보기"
                              >
                                {m.summoner_name}
                              </a>
                            ) : m.summoner_name
                          })()}
                          {isMe && <span style={{ fontSize: 10, color: 'var(--gold2)', marginLeft: 4 }}>(나)</span>}
                          {isHostRow && <span style={{ fontSize: 10, color: 'var(--gold2)', marginLeft: 4 }}>👑</span>}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                          {isMe ? (
                            <>
                              <select
                                value={m.most1}
                                onChange={e => updateMyMost('most1', e.target.value)}
                                disabled={m.ready}
                                style={{ width: 78, padding: '2px 4px', fontSize: 10, opacity: m.ready ? 0.5 : 1, cursor: m.ready ? 'not-allowed' : 'pointer' }}
                              >
                                {lines.length >= 2 && <option value="any">상관없음</option>}
                                {lines.map(l => (
                                  <option key={l} value={l}>{l}</option>
                                ))}
                              </select>
                              <select
                                value={m.most2 ?? ''}
                                onChange={e => updateMyMost('most2', e.target.value)}
                                disabled={m.most1 === 'any' || m.ready}
                                style={{ width: 78, padding: '2px 4px', fontSize: 10, opacity: (m.most1 === 'any' || m.ready) ? 0.4 : 1, cursor: m.ready ? 'not-allowed' : 'pointer' }}
                              >
                                <option value=''>상관없음</option>
                                {lines.filter(l => l !== m.most1 && m.most1 !== 'any').map(l => (
                                  <option key={l} value={l}>{l}</option>
                                ))}
                              </select>
                            </>
                          ) : (
                            <>
                              <span className="badge" style={{ fontSize: 9, padding: '1px 7px', ...(m.most1 === 'any' ? { background: 'var(--bg)', color: 'var(--text2)' } : lineBadgeStyle(m.most1)) }}>
                                {m.most1 === 'any' ? '상관없음' : m.most1}
                              </span>
                              {m.most1 !== 'any' && m.most2 && (
                                <span className="badge" style={{ fontSize: 9, padding: '1px 7px', ...lineBadgeStyle(m.most2) }}>
                                  {m.most2}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>

                      <span style={{
                        fontSize: 10, padding: '3px 9px', borderRadius: 20, flexShrink: 0,
                        background: m.ready ? 'rgba(62,207,142,0.15)' : 'var(--bg)',
                        color: m.ready ? 'var(--green)' : 'var(--text3)',
                        fontWeight: 600, whiteSpace: 'nowrap',
                      }}>
                        ● {m.ready ? '준비완료' : '대기중'}
                      </span>

                      {isHost && !isHostRow && (
                        <button
                          onClick={() => kickMember(m.user_id, m.summoner_name)}
                          style={{
                            fontSize: 9, padding: '3px 8px', borderRadius: 7, flexShrink: 0,
                            background: 'rgba(239,84,104,0.12)', color: 'var(--red)',
                            border: 'none', fontWeight: 600, cursor: 'pointer',
                          }}
                        >
                          강퇴
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              {isHost && dbIsAdmin && myRoom.members.length === 10 && !myRoom.members.every(m => m.ready) && (
                <button
                  className="btn"
                  onClick={fillTestMembers}
                  style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
                >
                  🧪 테스트 인원 전원 다시 준비완료
                </button>
              )}
              {isHost && dbIsAdmin && myRoom.members.length < 10 && (
                <button
                  className="btn"
                  onClick={fillTestMembers}
                  style={{ width: '100%', marginBottom: 8, fontSize: 12 }}
                >
                  🧪 테스트 인원 채우기 (등록된 소환사로 {10 - myRoom.members.length}명 자동 추가 + 준비완료)
                </button>
              )}

              {myMember && (() => {
                const hasRiotId = !!(myUserId && riotIdMap[myUserId])
                const isFlagged = !!(myUserId && correctionMap[myUserId]?.needs_correction)
                const needsLoginIdChange = !!(myUserId && loginIdStatusMap[myUserId] === false)
                const canReady = myMember.ready || (hasRiotId && !isFlagged && !needsLoginIdChange)

                return (
                  <>
                    {!canReady && (
                      <div style={{
                        fontSize: 11, color: 'var(--red)', marginBottom: 6,
                        background: 'var(--red-bg)', border: '0.5px solid var(--red-border)',
                        borderRadius: 'var(--radius)', padding: '6px 10px',
                      }}>
                        {isFlagged ? (
                          <>
                            ⚠ 관리자가 정보 수정을 요청했어요: {correctionMap[myUserId!]?.correction_note || '내용 없음'}
                            <br />"내 정보"에서 수정하고 관리자 확인을 기다려주세요.
                          </>
                        ) : needsLoginIdChange ? (
                          '⚠ 아이디와 비밀번호를 새로 변경하세요. "내 정보"에서 아이디를 변경한 뒤 이 탭으로 돌아와 새로고침하면 준비완료를 누를 수 있어요.'
                        ) : (
                          '⚠ 롤 계정이 등록되어 있지 않아요. "내 정보"에서 롤 계정을 입력한 뒤 이 탭으로 돌아와 새로고침하면 준비완료를 누를 수 있어요.'
                        )}
                      </div>
                    )}

                    {isHost && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text3)', marginBottom: 8, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!myRoom.detailed_matching}
                          onChange={async e => {
                            const checked = e.target.checked
                            setRooms(prev => prev.map(r => r.id === myRoom.id ? { ...r, detailed_matching: checked } : r))
                            await supabase.from('rooms').update({ detailed_matching: checked }).eq('id', myRoom.id)
                          }}
                        />
                        🏆 최고수준팀편성
                      </label>
                    )}

                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-danger" onClick={leaveRoom} style={{ flex: 1 }}>
                        나가기
                      </button>
                      {canReady ? (
                        <button
                          className={`btn ${myMember.ready ? '' : 'btn-gold'}`}
                          onClick={toggleReady}
                          style={{ flex: 2 }}
                        >
                          {myMember.ready ? '준비 취소' : '준비완료'}
                        </button>
                      ) : (
                        <button
                          className="btn btn-danger"
                          disabled
                          style={{ flex: 2, opacity: 0.6, cursor: 'not-allowed' }}
                        >
                          {isFlagged ? '준비 불가 (정보 수정 필요)' : needsLoginIdChange ? '준비 불가 (아이디 변경 필요)' : '준비 불가 (롤 계정 등록 필요)'}
                        </button>
                      )}
                      {isHost && (
                        <button
                          className="btn btn-gold"
                          onClick={runBalance}
                          disabled={!allReady || balancing}
                          style={{
                            flex: 2,
                            ...(allReady ? { boxShadow: '0 0 20px rgba(224,198,143,0.5), 0 4px 14px rgba(200,170,110,0.35)', fontWeight: 800 } : {}),
                          }}
                        >
                          {balancing ? '편성 중...' : allReady ? `✓ 팀편성 시작` : `팀편성 (${myRoom.members.filter(m => m.ready).length}/${myRoom.members.length})`}
                        </button>
                      )}
                    </div>
                  </>
                )
              })()}
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
                    // 이번 판이 "라인 튕김" 규칙으로 만들어졌었다면, 그 튕김 보호/보장 변경도 원래대로 되돌림
                    const delta = myRoom.pending_autofill_delta
                    const revertedProtected = delta
                      ? (myRoom.autofill_protected_ids ?? []).filter(id => !delta.added.includes(id))
                      : myRoom.autofill_protected_ids
                    const revertedGuaranteed = delta
                      ? Array.from(new Set([
                          ...(myRoom.guaranteed_m1_ids ?? []).filter(id => !delta.added.includes(id)),
                          ...delta.removedFromGuaranteed,
                        ]))
                      : myRoom.guaranteed_m1_ids
                    await supabase.from('rooms').update({
                      result: null, pending_result: null, balance_started_at: null,
                      last_result: myRoom.result, updated_at: new Date().toISOString(),
                      autofill_protected_ids: revertedProtected,
                      guaranteed_m1_ids: revertedGuaranteed,
                      pending_autofill_delta: null,
                    }).eq('id', myRoom.id)
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
                    {team.players.map(p => {
                      const riotId = riotIdMap[p.userId]
                      const lolPsUrl = riotId ? riotIdToLolPsUrl(riotId) : null
                      return (
                        <div key={p.userId} className="team-player">
                          <span style={{ width: 36, fontSize: 11, fontWeight: 500, color: 'var(--text2)', flexShrink: 0 }}>{p.line}</span>
                          <span style={{ flex: 1, fontWeight: 500 }}>
                            {lolPsUrl ? (
                              <a
                                href={lolPsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
                                title="lol.ps에서 전적 보기"
                              >
                                <NameWithIdBadge name={p.name} idPrefixMap={idPrefixMap} userId={p.userId} />
                              </a>
                            ) : (
                              <NameWithIdBadge name={p.name} idPrefixMap={idPrefixMap} userId={p.userId} />
                            )}
                          </span>
                          <span className="badge" style={{ fontSize: 10, ...tierBadgeStyle(p.tier) }}>{p.tier}</span>
                          <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 4 }}>{p.score.toFixed(1)}</span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              {/* 해당 라인 전적이 적은(10판 미만) 배치 인원이 있으면 경고 문구 표시 —
                  이런 선수의 점수는 실전적 대신 추정치(resolveTierScore 등)에 기반해 밸런싱됐을 가능성이 높아
                  팀 언밸런싱이 발생할 수 있음 */}
              {(() => {
                const allPlayers = [...myRoom.result.team1, ...myRoom.result.team2]
                const linePlayCount = (userId: string, line: Line) => records.filter(r =>
                  r.blue.some(p => p.userId === userId && p.line === line) ||
                  r.red.some(p => p.userId === userId && p.line === line)
                ).length
                const lowExpPlayers = allPlayers.filter(p => linePlayCount(p.userId, p.line) < 10)
                if (lowExpPlayers.length === 0) return null
                return (
                  <div style={{
                    fontSize: 10, color: 'var(--red)', textAlign: 'center', marginBottom: 8,
                    opacity: 0.85,
                  }}>
                    ⚠ {lowExpPlayers.map(p => `${p.name}(${p.line})`).join(', ')} — 해당 라인 10판 미만(배치 인원)이라 팀 밸런싱이 부정확할 수 있어요
                  </div>
                )
              })()}

              <div style={{ textAlign: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--text2)' }}>
                  점수 차이: <strong style={{ color: 'var(--gold)' }}>{Math.abs(myRoom.result.s1 - myRoom.result.s2).toFixed(1)}점</strong>
                </span>
              </div>

              {/* 예상 승률 */}
              {(() => {
                const result = myRoom.result!
                // runBalance가 팀을 고를 때 점수를 계산하는 것과 완전히 동일한 함수로 계산 — 기준이 다르면
                // 화면에 보이는 예상 승률과 실제 팀편성 기준이 어긋날 수 있기 때문에 하나로 통일함.
                const { blueWr, lineWrs } = predictTeamWinRate(result.team1, result.team2, records)
                const blueWrPct = Math.round(blueWr * 100)
                const redWrPct = 100 - blueWrPct
                const hasLowSample = lineWrs.some(l => !l.blended)

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
                    {hasLowSample && (
                      <div style={{ fontSize: 10, color: 'var(--gold3)', background: 'rgba(120,90,40,0.08)', border: '1px solid rgba(120,90,40,0.2)', borderRadius: 'var(--radius)', padding: '5px 9px', marginTop: 7 }}>
                        ⚠ 상대전적이 {MIN_H2H_SAMPLE}판 미만인 라인은 티어 점수(라인 영향력 반영)로만 추정되어 정확도가 낮을 수 있어요
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
                      const bpInBlue = r.blue.some(p => p.userId === bp.userId && p.line === line)
                      const bpInRed = r.red.some(p => p.userId === bp.userId && p.line === line)
                      const rpInBlue = r.blue.some(p => p.userId === rp.userId && p.line === line)
                      const rpInRed = r.red.some(p => p.userId === rp.userId && p.line === line)
                      return (bpInBlue && rpInRed) || (bpInRed && rpInBlue)
                    })
                    const total = matchRecords.length
                    const bpWin = matchRecords.filter(r => {
                      const bpInBlue = r.blue.some(p => p.userId === bp.userId && p.line === line)
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
                ) : isRecording ? (
                  <div className="empty">기록 중...</div>
                ) : confirmingWinner ? (() => {
                  const t1 = myRoom.result!.team1
                  const t2 = myRoom.result!.team2
                  const allPlayers = [...t1, ...t2]
                  const allChampionsPicked = allPlayers.every(p => !!pendingChampions[p.userId])
                  return (
                    <div>
                      <div style={{
                        fontSize: 13, fontWeight: 700, marginBottom: 10,
                        color: confirmingWinner === 'blue' ? 'var(--blue, #4a90e2)' : 'var(--red)',
                      }}>
                        {confirmingWinner === 'blue' ? '🔵 블루팀 승리' : '🔴 레드팀 승리'}가 맞나요?
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 10 }}>
                        한 번 기록하면 점수가 즉시 반영돼요. 다시 한번 확인해주세요.
                      </div>

                      {/* 피어리스+챔피언 전적 기록: 라인별 블루/레드 챔피언 등록 */}
                      <div style={{ textAlign: 'left', marginBottom: 12 }}>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>
                          라인별 챔피언을 등록해주세요{championList.length === 0 ? ' (챔피언 목록 불러오는 중...)' : ''}
                        </div>
                        {LINES.map(line => {
                          const bp = t1.find(p => p.line === line)
                          const rp = t2.find(p => p.line === line)
                          if (!bp || !rp) return null
                          // 이번 판(10명) 안에서는 같은 챔피언 중복 선택 불가 + 이 방에서 어느 라인이든 이미 쓴 챔피언(피어리스)도 불가.
                          // 본인이 이미 골라둔 챔피언은 그대로 유지할 수 있어야 하니 본인 선택은 제외하고 계산.
                          const usedAnywhere = new Set(Object.values(myRoom.used_champions ?? {}).flatMap(arr => arr ?? []))
                          const disallowedFor = (userId: string) => {
                            const pickedByOthers = Object.entries(pendingChampions)
                              .filter(([uid, champ]) => uid !== userId && !!champ)
                              .map(([, champ]) => champ)
                            return new Set([...pickedByOthers, ...Array.from(usedAnywhere)])
                          }
                          const bpChampions = championList.filter(c => !disallowedFor(bp.userId).has(c.id))
                          const rpChampions = championList.filter(c => !disallowedFor(rp.userId).has(c.id))
                          return (
                            <div key={line} style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 5 }}>
                              <span className="badge b-line" style={{ width: 36, flexShrink: 0, textAlign: 'center', fontSize: 9, padding: '2px 0' }}>{line}</span>
                              <ChampionSelect
                                champions={bpChampions}
                                value={pendingChampions[bp.userId] ?? ''}
                                onChange={id => setPendingChampions(prev => ({ ...prev, [bp.userId]: id }))}
                                placeholderName={bp.name}
                                disabled={championList.length === 0}
                              />
                              <ChampionSelect
                                champions={rpChampions}
                                value={pendingChampions[rp.userId] ?? ''}
                                onChange={id => setPendingChampions(prev => ({ ...prev, [rp.userId]: id }))}
                                placeholderName={rp.name}
                                disabled={championList.length === 0}
                              />
                            </div>
                          )
                        })}
                        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 4 }}>
                          같은 판 내 챔피언 중복 선택, 이번 방에서 라인 상관없이 이미 쓴 챔피언은 목록에서 자동으로 제외돼요(피어리스)
                        </div>
                        {!allChampionsPicked && (
                          <div style={{ fontSize: 10, color: 'var(--gold3)', marginTop: 4 }}>
                            ⚠ 10명 전원의 챔피언을 선택해야 기록할 수 있어요
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                        <button className="btn btn-sm" onClick={() => setConfirmingWinner(null)} style={{ flex: 1 }}>
                          아니요, 다시 선택
                        </button>
                        <button
                          className={`btn ${confirmingWinner === 'blue' ? 'btn-blue' : 'btn-red'}`}
                          onClick={() => recordWin(confirmingWinner)}
                          disabled={!allChampionsPicked}
                          style={{ flex: 1, opacity: allChampionsPicked ? 1 : 0.5, cursor: allChampionsPicked ? 'pointer' : 'not-allowed' }}
                        >
                          맞아요, 전적 기록
                        </button>
                      </div>
                    </div>
                  )
                })() : (
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button className="btn btn-blue" onClick={() => setConfirmingWinner('blue')}>🔵 블루팀 승리</button>
                    <button className="btn btn-red" onClick={() => setConfirmingWinner('red')}>🔴 레드팀 승리</button>
                  </div>
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
          {CHAT_ENABLED && <RoomChat roomId={myRoom.id} myName={myName} myUserId={myUserId ?? ''} />}

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
                const lc = lineBadgeStyle(l)
                return (
                  <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 40, textAlign: 'left', flexShrink: 0, fontSize: 11, fontWeight: 600, color: lc.color as string }}>{l}</span>
                    <div style={{ flex: 1, height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${pct}%`, background: lc.color as string, borderRadius: 3 }} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text2)', minWidth: 20, textAlign: 'right', flexShrink: 0 }}>{count}</span>
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
              {dbIsAdmin && (
                <button className="btn btn-sm btn-danger" onClick={() => deleteRoomAsAdmin(r)}>
                  삭제
                </button>
              )}
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
