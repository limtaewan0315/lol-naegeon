'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Line } from '@/lib/data'
import { LINES, TIERS, getScore, getTierByScore, getScoreByTier, shuffle } from '@/lib/data'
import {
  supabase, SummonerMap, SummonerScoreMap, GameRecord, TeamPlayer, BalanceResult,
  PlayerEntry, NameWithIdBadge, LINE_ORDER, DISCORD_WEBHOOK_URL
} from '@/lib/shared'
import RoomChat from './RoomChat'

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

function riotIdToLolPsUrl(riotId: string): string | null {
  const parts = riotId.split('#')
  if (parts.length !== 2) return null
  const [gameName, tag] = parts
  if (!gameName.trim() || !tag.trim()) return null
  return `https://lol.ps/summoner/${encodeURIComponent(`${gameName.trim()}_${tag.trim()}`)}?region=kr`
}

export default function RoomsTab({
  summoners,
  summonerScores,
  records,
  idPrefixMap,
  riotIdMap,
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

  // 매칭 방식(라인밸런싱/올랜덤)은 방장만 변경 가능
  const updateMatchMode = async (mode: 'line' | 'random') => {
    if (!myRoom || !isHost) return
    const roomId = myRoom.id
    setRooms(prev => prev.map(r => (r.id === roomId ? { ...r, match_mode: mode } : r)))
    await supabase.from('rooms').update({ match_mode: mode, updated_at: new Date().toISOString() }).eq('id', roomId)
  }

  // 관리자 전용 테스트 기능: 등록된 다른 소환사들로 방을 10명까지 자동으로 채우고
  // 전부 준비완료 상태로 만들어서, 혼자서도 매칭 테스트를 해볼 수 있게 함.
  // 무작위로 뽑으면 라인이 한쪽으로 쏠려서 밸런싱이 실패할 수 있으므로,
  // "아직 2명이 안 채워진 라인"부터 우선적으로 채우는 방식으로 채움.
  const fillTestMembers = async () => {
    if (!myRoom || !isHost || !dbIsAdmin) return
    const existingIds = new Set(myRoom.members.map(m => m.user_id))
    const need = 10 - myRoom.members.length
    if (need <= 0) return

    const targetLines: Line[] = ['탑', '정글', '미드', '원딜', '서포터']
    // 이미 방에 있는 사람들의 M1 기준으로 현재 라인별 인원 카운트 (M1='상관없음'인 사람은 유동적이라 카운트에서 제외)
    const lineCount: Record<Line, number> = { 탑: 0, 정글: 0, 미드: 0, 원딜: 0, 서포터: 0 }
    myRoom.members.forEach(m => {
      if (m.most1 !== 'any') lineCount[m.most1 as Line] = (lineCount[m.most1 as Line] ?? 0) + 1
    })

    // 후보 풀: 아직 방에 없는 + 비활성화되지 않은 실제 계정만 (계정ID 기준 — 동명이인도 각자 정확히 후보가 됨)
    let pool = Object.entries(nameByUserId)
      .filter(([uid, name]) => !existingIds.has(uid) && !inactiveNames.has(uid))
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

      // 등록 라인이 적은(=다른 라인으로 대체하기 어려운) 사람을 우선 선택해서, 라인 많은 사람은 나중을 위해 아낌
      candidates.sort((a, b) => a.lines.length - b.lines.length)
      const chosen = candidates[0]

      const otherLines = chosen.lines.filter(l => l !== target)
      const most2 = otherLines.find(l => lineCount[l] < 2) ?? otherLines[0] ?? null

      newFilled.push({ user_id: chosen.userId, summoner_name: chosen.name, most1: target, most2, ready: true })
      lineCount[target]++
      pool = pool.filter(c => c.userId !== chosen.userId)
    }

    // 그래도 인원이 부족하면(등록된 소환사 자체가 적은 경우) 라인 무관하게 남은 후보로 채움
    if (newFilled.length < need) {
      const filledIds = new Set(newFilled.map(f => f.user_id))
      const leftover = pool.filter(c => !filledIds.has(c.userId)).slice(0, need - newFilled.length)
      leftover.forEach(c => {
        newFilled.push({ user_id: c.userId, summoner_name: c.name, most1: (c.lines[0] ?? '탑') as Line, most2: c.lines[1] ?? null, ready: true })
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

    setBalancing(true)

    const getOptions = (p: PlayerEntry): Line[] => {
      const allLines = getSummonerLines(p.userId)
      const opts: Line[] = []
      if (p.most1 === 'any') opts.push(...allLines)
      else opts.push(p.most1 as Line)
      if (p.most2 && p.most2 !== 'any' && !opts.includes(p.most2 as Line)) opts.push(p.most2 as Line)
      return opts.length > 0 ? opts : allLines
    }

    const getAdjustedScore = (userId: string, line: Line, tier: string): number => {
      return summonerScores[userId]?.[line] ?? getScoreByTier(tier)
    }

    // 라인별로 "이 라인을 받을 수 있는 사람"이 몇 명인지 미리 계산 (M1/M2/상관없음 기준)
    const linePossibleUpfront: Record<Line, number> = { 탑: 0, 정글: 0, 미드: 0, 원딜: 0, 서포터: 0 }
    players.forEach(p => {
      const allLines = getSummonerLines(p.userId)
      if (p.most1 === 'any') allLines.forEach(l => { linePossibleUpfront[l] = (linePossibleUpfront[l] ?? 0) + 1 })
      else linePossibleUpfront[p.most1 as Line] = (linePossibleUpfront[p.most1 as Line] ?? 0) + 1
      if (p.most2 === 'any') allLines.forEach(l => { linePossibleUpfront[l] = (linePossibleUpfront[l] ?? 0) + 1 })
      else if (p.most2) linePossibleUpfront[p.most2 as Line] = (linePossibleUpfront[p.most2 as Line] ?? 0) + 1
    })
    const supplyInsufficient = LINES.some(l => (linePossibleUpfront[l] ?? 0) < 2)

    // ── 인원 부족 규칙: 원래대로면 라인당 2명이 안 나와서 매칭이 실패했을 상황에서만 발동 ──
    // M1/M2를 최대한 존중하되, 부족한 라인은 롤의 "라인 튕김"처럼 다른 사람을 배정함.
    // 튕긴 사람은 이 방이 사라질 때까지 다시 안 튕기고, 바로 다음 판엔 M1이 보장됨.
    if (supplyInsufficient) {
      const protectedIds = new Set<string>(myRoom.autofill_protected_ids ?? [])
      const guaranteedIds = new Set<string>(myRoom.guaranteed_m1_ids ?? [])

      const slots: Record<Line, PlayerEntry[]> = { 탑: [], 정글: [], 미드: [], 원딜: [], 서포터: [] }
      const assignedIds = new Set<string>()
      const tryAssign = (p: PlayerEntry, line: Line) => {
        if (slots[line].length < 2 && !assignedIds.has(p.userId)) {
          slots[line].push(p)
          assignedIds.add(p.userId)
        }
      }

      // 0순위: 지난판에 튕긴 사람은 이번 판 M1을 무조건 보장
      shuffle(players.filter(p => guaranteedIds.has(p.userId) && p.most1 !== 'any'))
        .forEach(p => tryAssign(p, p.most1 as Line))

      // 1순위: M1 희망자
      for (const line of LINES) {
        shuffle(players.filter(p => !assignedIds.has(p.userId) && p.most1 === line))
          .forEach(p => tryAssign(p, line))
      }
      // 2순위: M2 희망자
      for (const line of LINES) {
        shuffle(players.filter(p => !assignedIds.has(p.userId) && p.most2 === line))
          .forEach(p => tryAssign(p, line))
      }
      // 3순위: "상관없음"인 사람 (본인이 이미 동의한 것이므로 튕김으로 취급 안 함)
      for (const line of LINES) {
        if (slots[line].length >= 2) continue
        shuffle(players.filter(p => !assignedIds.has(p.userId) && p.most1 === 'any'))
          .forEach(p => tryAssign(p, line))
      }
      // 4순위: 진짜 라인 튕김 — 아직 남은 사람을 남은 자리에. 보호 중인 사람은 최대한 피함
      for (const line of LINES) {
        while (slots[line].length < 2) {
          const remaining = players.filter(p => !assignedIds.has(p.userId))
          if (remaining.length === 0) break
          const eligible = remaining.filter(p => !protectedIds.has(p.userId))
          const pool = eligible.length > 0 ? eligible : remaining
          tryAssign(shuffle(pool)[0], line)
        }
      }

      const buildPlayer = (p: PlayerEntry, line: Line): TeamPlayer => {
        const tier = summoners[p.userId]?.[line] ?? '골드2'
        return { userId: p.userId, name: p.name, tier, line, score: getAdjustedScore(p.userId, line, tier) }
      }

      // 라인별 2명을 team1/team2로 나누는 32가지 경우의 수를 전부 만들어서 그중 최선을 고름
      const pairs = LINES.map(line => slots[line].map(p => buildPlayer(p, line)))
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
      allCombos.sort((a, b) => Math.abs(a.s1 - a.s2) - Math.abs(b.s1 - b.s2))

      const lastSigAF = myRoom.last_result ? resultSignature(myRoom.last_result) : null
      const historyTeamsAF: string[][] = (myRoom.recent_team_history ?? []).flatMap(h => [h.ids1, h.ids2])
      const violatesRepeatAF = (team: TeamPlayer[]) => {
        const ids = new Set(team.map(p => p.userId))
        return historyTeamsAF.some(t => t.filter(id => ids.has(id)).length >= 2)
      }
      const isCleanAF = (c: BalanceResult) =>
        (!lastSigAF || resultSignature(c) !== lastSigAF) && !violatesRepeatAF(c.team1) && !violatesRepeatAF(c.team2)

      const chosen =
        allCombos.find(c => Math.abs(c.s1 - c.s2) <= 5 && isCleanAF(c)) ??
        allCombos.find(c => Math.abs(c.s1 - c.s2) <= 5) ??
        allCombos.find(c => isCleanAF(c)) ??
        allCombos[0]

      // 이번에 M1/M2가 아닌 라인이 걸린 사람 = "튕긴" 사람
      const allAssigned = [...chosen.team1, ...chosen.team2]
      const newlyAutofilled = allAssigned.filter(tp => {
        const orig = players.find(p => p.userId === tp.userId)!
        return orig.most1 !== 'any' && orig.most1 !== tp.line && orig.most2 !== tp.line
      }).map(tp => tp.userId)

      // 지난판 보장을 이번에 실제로 받은 사람은 보장 목록에서 제거
      const fulfilledGuarantees = allAssigned.filter(tp => {
        const orig = players.find(p => p.userId === tp.userId)!
        return guaranteedIds.has(tp.userId) && orig.most1 === tp.line
      }).map(tp => tp.userId)

      const newProtected = Array.from(new Set([...(myRoom.autofill_protected_ids ?? []), ...newlyAutofilled]))
      const newGuaranteed = Array.from(new Set([
        ...(myRoom.guaranteed_m1_ids ?? []).filter((id: string) => !fulfilledGuarantees.includes(id)),
        ...newlyAutofilled,
      ]))
      // 이번 판에서 뭐가 바뀌었는지 기록해둠 — 이 판이 취소되면 이 델타로 되돌림
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
      return
    }

    const LINE_PREFERENCE: Record<string, Line> = { '공민규': '정글' }
    const PREFERENCE_RATE = 0.95

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
        const allLines = getSummonerLines(p.userId)
        if (preferredLine && allLines.includes(preferredLine) && Math.random() < PREFERENCE_RATE) {
          const tier = summoners[p.userId]?.[preferredLine] ?? '골드2'
          const score = getAdjustedScore(p.userId, preferredLine, tier)
          return { userId: p.userId, name: p.name, line: preferredLine, score }
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
        const tier = summoners[p.userId]?.[line] ?? '골드2'
        const score = getAdjustedScore(p.userId, line, tier)
        return { userId: p.userId, name: p.name, line, score }
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
        team1: t1.map(p => ({ userId: p.userId, name: p.name, tier: summoners[p.userId]?.[p.line] ?? '골드2', line: p.line, score: p.score })),
        team2: t2.map(p => ({ userId: p.userId, name: p.name, tier: summoners[p.userId]?.[p.line] ?? '골드2', line: p.line, score: p.score })),
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

    // 항상 "가장 작은 점수차"를 최우선으로 찾음 (더 이상 최대 점수차 제한을 안 둠)
    candidates.sort((a, b) => a.diff - b.diff)

    // 최근 4판 동안 같은 팀이었던 5명 중 2명 이상이 다시 같은 팀이 되는 조합은 피함
    const historyTeams: string[][] = (myRoom.recent_team_history ?? []).flatMap(h => [h.ids1, h.ids2])
    const violatesRepeat = (team: TeamPlayer[]): boolean => {
      const ids = new Set(team.map(p => p.userId))
      return historyTeams.some(histTeam => histTeam.filter(id => ids.has(id)).length >= 2)
    }
    const isRepeatFree = (c: { result: BalanceResult }) => !violatesRepeat(c.result.team1) && !violatesRepeat(c.result.team2)

    best = candidates.find(c => c.diff <= 5 && isRepeatFree(c))?.result ?? null
    if (!best) best = candidates.find(c => c.diff <= 5)?.result ?? null
    if (!best) best = candidates.find(c => isRepeatFree(c))?.result ?? null
    if (!best) best = candidates[0]?.result ?? null

    if (best) {
      const startedAt = new Date().toISOString()
      await supabase.from('rooms').update({ pending_result: best, balance_started_at: startedAt, pending_autofill_delta: null }).eq('id', myRoom.id)
    } else if (fallback) {
      setBalanceError(`팀 편성에 필요한 라인 밸런스 조건을 만족하는 조합을 못 찾았어요. (가장 가까운 조합은 ${fallbackDiff.toFixed(1)}점 차이) 다시 시도해보세요.`)
    } else {
      const linePossible: Record<string, number> = {}
      LINES.forEach(l => { linePossible[l] = 0 })
      players.forEach(p => {
        const allLines = getSummonerLines(p.userId)
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
    const blueData = result.team1.map(p => ({ userId: p.userId, name: p.name, line: p.line }))
    const redData = result.team2.map(p => ({ userId: p.userId, name: p.name, line: p.line }))
    // 서버(apply_match_score_delta)가 실제로 적용한 정확한 적용전/후 값을 여기 담아둠 —
    // 디스코드 메시지가 이 값을 그대로 써서, 화면(브라우저)이 새로고침 안 됐어도 항상 정확하게 표시됨
    const scoreResults: Record<string, { old_score: number; old_tier: string; new_score: number; new_tier: string; delta_applied: number }> = {}
    const scoreFailures: string[] = []

    const { data: newRecord } = await supabase.from('records').insert([{ winner, blue: blueData, red: redData, time }]).select()
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
    }

    onRecord({ winner, blue: blueData, red: redData, skipInsert: true })

    // 방 초기화: 참가자는 유지하되 전부 준비 해제 (다음 판 위해 다시 준비해야 함)
    // 방금 진행한 팀편성은 last_result로 저장 — 다음 팀편성 때 완전히 같은 조합이 다시 나오지 않게 하기 위함
    // recent_team_history에도 추가(최근 4판까지만 유지) — 5명 중 2명 이상 다시 같은 팀 되는 것 방지용
    const newHistoryEntry = { ids1: result.team1.map(p => p.userId), ids2: result.team2.map(p => p.userId) }
    const updatedHistory = [newHistoryEntry, ...(myRoom.recent_team_history ?? [])].slice(0, 4)
    const roomShouldClose = updatedHistory.length >= 4

    if (roomShouldClose) {
      // 탈주하기(취소) 제외, 실제로 플레이된 경기가 4판이 되면 방을 자동으로 삭제 (채팅도 같이 삭제됨)
      await supabase.from('rooms').delete().eq('id', myRoom.id)
    } else {
      const resetMembers = myRoom.members.map(m => ({ ...m, ready: false }))
      // 경기가 실제로 기록됐으니 튕김 보호/보장은 이미 반영된 상태를 그대로 유지 (되돌릴 델타는 정리)
      await supabase.from('rooms').update({ members: resetMembers, last_result: result, recent_team_history: updatedHistory, pending_autofill_delta: null }).eq('id', myRoom.id)
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
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>참가자 {myRoom.members.length}/10</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }} title={`이번 방에서 ${myRoom.recent_team_history?.length ?? 0}/4판 진행됨 (4판을 채우면 방이 자동으로 사라져요)`}>
              {[0, 1, 2, 3].map(i => (
                <span
                  key={i}
                  style={{
                    width: 7, height: 7, borderRadius: '50%',
                    background: i < (myRoom.recent_team_history?.length ?? 0) ? 'var(--gold, #d4af37)' : 'transparent',
                    border: `1px solid ${i < (myRoom.recent_team_history?.length ?? 0) ? 'var(--gold, #d4af37)' : 'var(--border2)'}`,
                  }}
                />
              ))}
            </span>
          </div>

          {!myRoom.result && countdown === null && (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
                {myRoom.members.map(m => {
                  const isMe = m.user_id === myUserId
                  const lines = getSummonerLines(m.user_id)
                  return (
                    <div
                      key={m.user_id}
                      className="player-row"
                      style={{
                        padding: '8px 10px', flexWrap: 'wrap',
                        background: isMe ? (m.ready ? 'rgba(212,175,55,0.28)' : 'rgba(212,175,55,0.12)') : undefined,
                        border: isMe ? `${m.ready ? 1 : 0.5}px solid var(--gold, #d4af37)` : undefined,
                        borderRadius: isMe ? 'var(--radius)' : undefined,
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 13, minWidth: 80 }}>
                        <NameWithIdBadge name={m.summoner_name} idPrefixMap={idPrefixMap} userId={m.user_id} />
                        {isMe && <span style={{ fontSize: 10, color: 'var(--gold, #d4af37)', marginLeft: 4 }}>(나)</span>}
                        {m.user_id === myRoom.host_user_id && <span style={{ fontSize: 10, color: 'var(--gold, #d4af37)', marginLeft: 4 }}>방장</span>}
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
                            {lines.map(l => (
                              <option key={l} value={l}>{l}</option>
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
                            {lines.filter(l => l !== m.most1 && m.most1 !== 'any').map(l => (
                              <option key={l} value={l}>{l}</option>
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

                      {isHost && m.user_id !== myRoom.host_user_id && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => kickMember(m.user_id, m.summoner_name)}
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

              {myMember && (() => {
                const hasRiotId = !!(myUserId && riotIdMap[myUserId])
                if (myMember.ready || hasRiotId) {
                  return (
                    <button
                      className={`btn ${myMember.ready ? '' : 'btn-gold'}`}
                      onClick={toggleReady}
                      style={{ width: '100%', marginBottom: 8 }}
                    >
                      {myMember.ready ? '준비 취소' : '준비완료'}
                    </button>
                  )
                }
                return (
                  <div style={{ marginBottom: 8 }}>
                    <div style={{
                      fontSize: 11, color: 'var(--red)', marginBottom: 6,
                      background: 'var(--red-bg)', border: '0.5px solid var(--red-border)',
                      borderRadius: 'var(--radius)', padding: '6px 10px',
                    }}>
                      ⚠ 롤 계정이 등록되어 있지 않아요. "내 정보"에서 롤 계정을 입력한 뒤 이 탭으로 돌아와 새로고침하면 준비완료를 누를 수 있어요.
                    </div>
                    <button
                      className="btn btn-danger"
                      disabled
                      style={{ width: '100%', opacity: 0.6, cursor: 'not-allowed', padding: '8px 16px', fontSize: 13, fontWeight: 500 }}
                    >
                      준비완료 (롤 계정 등록 필요)
                    </button>
                  </div>
                )
              })()}

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
                                style={{ color: 'inherit', textDecoration: 'underline dotted', textUnderlineOffset: 2, cursor: 'pointer' }}
                                title="lol.ps에서 전적 보기"
                              >
                                <NameWithIdBadge name={p.name} idPrefixMap={idPrefixMap} userId={p.userId} />
                              </a>
                            ) : (
                              <NameWithIdBadge name={p.name} idPrefixMap={idPrefixMap} userId={p.userId} />
                            )}
                          </span>
                          <span className="badge b-tier" style={{ fontSize: 10 }}>{p.tier}</span>
                          <span style={{ fontSize: 12, color: 'var(--text2)', marginLeft: 4 }}>{p.score.toFixed(1)}</span>
                        </div>
                      )
                    })}
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
                    const bpInBlue = r.blue.some(p => p.userId === bp.userId && p.line === line)
                    const bpInRed = r.red.some(p => p.userId === bp.userId && p.line === line)
                    const rpInBlue = r.blue.some(p => p.userId === rp.userId && p.line === line)
                    const rpInRed = r.red.some(p => p.userId === rp.userId && p.line === line)
                    return (bpInBlue && rpInRed) || (bpInRed && rpInBlue)
                  })
                  const total = matchRecs.length
                  if (total > 0) {
                    const bpWin = matchRecs.filter(r => {
                      const bpInBlue = r.blue.some(p => p.userId === bp.userId && p.line === line)
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
          <RoomChat roomId={myRoom.id} myName={myName} myUserId={myUserId ?? ''} />

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
