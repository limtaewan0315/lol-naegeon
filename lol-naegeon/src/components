'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Line } from '@/lib/data'
import { getScoreByTier, getTierByScore } from '@/lib/data'
import { supabase, GameRecord, SummonerMap, SummonerScoreMap, checkPassword } from '@/lib/shared'
import RoomsTab from './RoomsTab'
import RecordTab from './RecordTab'
import RankingTab from './RankingTab'
import HallOfFameTab from './HallOfFameTab'
import StatsTab from './StatsTab'
import MyInfoTab from './MyInfoTab'
import AdminTab from './AdminTab'
import { ApprovalRequestsTab } from './SignupRequestsTab'
import ForcePasswordChangeGate from './ForcePasswordChangeGate'

export default function MainApp() {
  const [tab, setTab] = useState<'team' | 'record' | 'ranking' | 'hall' | 'stats' | 'summoners' | 'requests' | 'admin'>('team')
  const [dbIsAdmin, setDbIsAdmin] = useState(false)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [records, setRecords] = useState<GameRecord[]>([])
  const [summoners, setSummoners] = useState<SummonerMap>({})
  const [summonerScores, setSummonerScores] = useState<SummonerScoreMap>({})
  const [nameByUserId, setNameByUserId] = useState<Record<string, string>>({})

  const [idPrefixMap, setIdPrefixMap] = useState<Record<string, string>>({})
  const [riotIdMap, setRiotIdMap] = useState<Record<string, string>>({})
  const [inactiveNames, setInactiveNames] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const fetchAll = useCallback(async () => {
    const [{ data: recs }, { data: sums }, { data: prefixes }, { data: riotIds }] = await Promise.all([
      supabase.from('records').select('*').order('created_at', { ascending: false }),
      supabase.from('summoners').select('*'),
      supabase.rpc('summoner_id_prefixes'),
      supabase.rpc('member_riot_ids'),
    ])
    if (recs) setRecords(recs)
    if (prefixes) {
      const pm: Record<string, string> = {}
      prefixes.forEach((p: { user_id: string; summoner_name: string; id_prefix: string }) => { pm[p.user_id] = p.id_prefix })
      setIdPrefixMap(pm)
    }
    if (riotIds) {
      const rm: Record<string, string> = {}
      riotIds.forEach((r: { user_id: string; riot_id: string }) => { rm[r.user_id] = r.riot_id })
      setRiotIdMap(rm)
    }
    if (sums) {
      const map: SummonerMap = {}
      const scoreMap: SummonerScoreMap = {}
      const inactiveSet = new Set<string>()
      const nameMap: Record<string, string> = {}
      sums.forEach((s: { name: string; tier: string; line: Line; score?: number; is_inactive?: boolean; user_id?: string }) => {
        const uid = s.user_id
        // 진짜 식별자(계정ID) 기준으로 데이터를 쌓음 — 동명이인이어도 서로 안 섞임
        if (uid) {
          if (!map[uid]) map[uid] = {} as Record<Line, string>
          if (!scoreMap[uid]) scoreMap[uid] = {} as Record<Line, number>
          if (s.is_inactive) inactiveSet.add(uid)
          const score = s.score ?? getScoreByTier(s.tier)
          scoreMap[uid][s.line] = score
          map[uid][s.line] = getTierByScore(score)
          nameMap[uid] = s.name
        }
      })
      // 하위호환: 방/팀편성 등 아직 이름으로 조회하는 화면들이 계속 작동하도록,
      // 계정ID로 쌓은 데이터를 이름으로도 조회 가능하게 별칭을 걸어둠.
      // (동명이인이 있으면 이름으로는 마지막에 처리된 한 명의 데이터만 보임 — 다음 단계에서 방/팀편성도
      //  계정ID 기준으로 전환하면 완전히 해결됨. 계정ID로 직접 조회하는 코드는 지금도 정확함.)
      Object.keys(map).forEach(uid => {
        const nm = nameMap[uid]
        if (nm) {
          map[nm] = map[uid]
          scoreMap[nm] = scoreMap[uid]
        }
      })
      setSummoners(map)
      setSummonerScores(scoreMap)
      setInactiveNames(inactiveSet)
      setNameByUserId(nameMap)
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
      // 실제로 그 경기에서 각 사람에게 적용됐던 정확한 값(score_events)을 그대로 반대로 되돌림
      // (연승/연패로 ±2, ±3이 적용됐을 수 있으므로 무조건 ±1이 아니라 실제 적용값 기준으로 되돌려야 함)
      const { data: events } = await supabase.from('score_events').select('user_id, line, delta').eq('record_id', id)
      for (const ev of events ?? []) {
        if (!ev.user_id) continue
        const { data: row } = await supabase.from('summoners').select('score, tier').eq('user_id', ev.user_id).eq('line', ev.line).single()
        if (row) {
          const newScore = (row.score ?? getScoreByTier(row.tier)) - ev.delta
          await supabase.from('summoners').update({ score: newScore, tier: getTierByScore(newScore) }).eq('user_id', ev.user_id).eq('line', ev.line)
        }
      }
      await supabase.from('score_events').delete().eq('record_id', id)
    }
    await supabase.from('tier_history').delete().eq('record_id', id)
    await supabase.from('records').delete().eq('id', id)
    setRecords(prev => prev.filter(r => r.id !== id))
    await fetchAll()
  }

  const clearRecords = async () => {
    if (!confirm('전체 기록을 삭제할까요? 티어(점수)도 전부 0판 상태로 롤백돼요!')) return
    if (!checkPassword()) return
    // 모든 전적을 역순으로 롤백 — 각 경기에 실제 적용됐던 값(score_events)을 정확히 되돌림
    for (const r of records) {
      const { data: events } = await supabase.from('score_events').select('user_id, line, delta').eq('record_id', r.id)
      for (const ev of events ?? []) {
        if (!ev.user_id) continue
        const { data: row } = await supabase.from('summoners').select('score, tier').eq('user_id', ev.user_id).eq('line', ev.line).single()
        if (row) {
          const newScore = (row.score ?? getScoreByTier(row.tier)) - ev.delta
          await supabase.from('summoners').update({ score: newScore, tier: getTierByScore(newScore) }).eq('user_id', ev.user_id).eq('line', ev.line)
        }
      }
    }
    await supabase.from('score_events').delete().neq('id', 0)
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
          <div className="header-title">내전 매니저</div>
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
            {(['team', 'ranking', 'hall', 'stats', 'summoners'] as const).map((t, i) => (
              <button key={t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
                {['내전방', '전체 랭킹', '명예의 전당', '개인 통계', '내 정보'][i]}
              </button>
            ))}
            {dbIsAdmin && (
              <button className={`tab${tab === 'record' ? ' active' : ''}`} onClick={() => setTab('record')}>
                전적 기록
              </button>
            )}
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
              {tab === 'team' && <RoomsTab summoners={summoners} summonerScores={summonerScores} records={records} idPrefixMap={idPrefixMap} riotIdMap={riotIdMap} onRecord={addRecord} dbIsAdmin={dbIsAdmin} inactiveNames={inactiveNames} nameByUserId={nameByUserId} />}
              {tab === 'record' && dbIsAdmin && <RecordTab records={records} onDelete={deleteRecord} onClear={clearRecords} isAdmin={dbIsAdmin} />}
              {tab === 'ranking' && <RankingTab records={records} idPrefixMap={idPrefixMap} />}
              {tab === 'hall' && <HallOfFameTab records={records} idPrefixMap={idPrefixMap} />}
              {tab === 'stats' && <StatsTab records={records} summoners={summoners} summonerScores={summonerScores} idPrefixMap={idPrefixMap} nameByUserId={nameByUserId} />}

              {tab === 'summoners' && <MyInfoTab summoners={summoners} summonerScores={summonerScores} records={records} idPrefixMap={idPrefixMap} onRefresh={fetchAll} />}

              {tab === 'requests' && dbIsAdmin && <ApprovalRequestsTab onRefresh={fetchAll} />}

              {tab === 'admin' && dbIsAdmin && (
                <div>
                  <AdminTab summoners={summoners} summonerScores={summonerScores} records={records} nameByUserId={nameByUserId} idPrefixMap={idPrefixMap} />
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
