'use client'

import { useState, useMemo, useEffect } from 'react'
import type { Line } from '@/lib/data'
import { LINES, TIERS, getScoreByTier } from '@/lib/data'
import { supabase, SummonerMap, SummonerScoreMap, GameRecord, NameWithIdBadge, tierFontSize } from '@/lib/shared'

export default function AdminTab({ summoners, summonerScores, records, nameByUserId, idPrefixMap }: { summoners: SummonerMap; summonerScores: SummonerScoreMap; records: GameRecord[]; nameByUserId: Record<string, string>; idPrefixMap: Record<string, string> }) {
  const [subTab, setSubTab] = useState<'summoners' | 'inactive'>('summoners')
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editingLine, setEditingLine] = useState<Line | ''>('')
  const [editingTier, setEditingTier] = useState('')
  const [error, setError] = useState('')
  const [inactiveStatusMap, setInactiveStatusMap] = useState<Map<string, boolean>>(new Map())

  // 계정ID+이름 쌍 목록 (동명이인도 각자 별개의 항목으로 정확히 구분됨)
  const allSummoners = Object.entries(nameByUserId)
    .map(([userId, name]) => ({ userId, name }))
    .sort((a, b) => a.name.localeCompare(b.name))

  // 14일 이상 미참여자 목록 — 계정ID 기준으로 마지막 경기 조회
  const inactiveList = useMemo(() => {
    const now = Date.now()
    const result: { userId: string; name: string; days: number }[] = []
    for (const { userId, name } of allSummoners) {
      const lastGame = records.find(r => r.blue.some(p => p.userId === userId) || r.red.some(p => p.userId === userId))
      if (!lastGame) continue
      const lastDate = new Date((lastGame as any).created_at ?? '')
      if (isNaN(lastDate.getTime())) continue
      const days = Math.floor((now - lastDate.getTime()) / (1000 * 60 * 60 * 24))
      if (days >= 14) result.push({ userId, name, days })
    }
    return result.sort((a, b) => b.days - a.days)
  }, [allSummoners, records])

  // 페이지 로드 시 DB에서 기존 비활성화 상태 읽어오기 (계정ID 기준)
  useEffect(() => {
    const loadInactiveStatus = async () => {
      const { data } = await supabase.from('summoners').select('user_id, is_inactive').eq('is_inactive', true)
      if (data) {
        const statusMap = new Map<string, boolean>()
        for (const record of data) {
          if ((record as any).user_id) statusMap.set((record as any).user_id, true)
        }
        setInactiveStatusMap(statusMap)
      }
    }
    loadInactiveStatus()
  }, [])

  const deleteSummoner = async (userId: string, name: string) => {
    if (!confirm(`${name}을(를) 완전히 삭제할까요?`)) return
    setError('')
    await supabase.from('summoners').delete().eq('user_id', userId)
    window.location.reload()
  }

  const toggleInactive = async (userId: string, currentInactive: boolean) => {
    const newInactiveStatus = !currentInactive
    // 로컬 상태에 즉시 반영 (UI 업데이트)
    setInactiveStatusMap(prev => new Map(prev).set(userId, newInactiveStatus))
    // DB에 저장
    const { error: err } = await supabase
      .from('summoners')
      .update({ is_inactive: newInactiveStatus })
      .eq('user_id', userId)
    if (err) {
      setError('업데이트 실패: ' + err.message)
      // 실패 시 로컬 상태 되돌리기
      setInactiveStatusMap(prev => new Map(prev).set(userId, currentInactive))
      return
    }
  }

  const startEdit = (userId: string, line: Line, tier: string) => {
    setEditingUserId(userId)
    setEditingLine(line)
    setEditingTier(tier)
    setError('')
  }

  const saveEdit = async () => {
    if (!editingUserId || editingLine === '') return
    setError('')

    const { error: err } = await supabase
      .from('summoners')
      .update({ tier: editingTier, score: getScoreByTier(editingTier) })
      .eq('user_id', editingUserId)
      .eq('line', editingLine)

    if (err) {
      setError('업데이트 실패: ' + err.message)
      return
    }

    setEditingUserId(null)
    setEditingLine('')
    setEditingTier('')
    window.location.reload()
  }

  const cancelEdit = () => {
    setEditingUserId(null)
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
              allSummoners.map(({ userId, name }) => (
                <div key={userId} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '0.5px solid var(--border2)' }}>
                  <div style={{ fontWeight: 700, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span><NameWithIdBadge name={name} idPrefixMap={idPrefixMap} userId={userId} /></span>
                    <button className="btn btn-danger btn-sm" onClick={() => deleteSummoner(userId, name)}>삭제</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
                    {LINES.map(line => {
                      const tier = summoners[userId]?.[line]
                      const isEditing = editingUserId === userId && editingLine === line
                      return (
                        <div key={line} style={{
                          background: 'var(--bg3)', padding: '12px 6px 10px',
                          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-inset)',
                          textAlign: 'center', transition: 'box-shadow 0.15s',
                        }}>
                          <div style={{
                            fontSize: 10, color: 'var(--text3)', marginBottom: 8,
                            fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                          }}>{line}</div>
                          {isEditing ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              <select
                                value={editingTier}
                                onChange={e => setEditingTier(e.target.value)}
                                style={{ width: '100%', padding: '2px 4px', fontSize: 10 }}
                              >
                                {TIERS.map(t => <option key={t} value={t}>{t}</option>)}
                              </select>
                              <div style={{ display: 'flex', gap: 2 }}>
                                <button className="btn btn-sm" style={{ flex: 1, padding: '2px 0', fontSize: 10 }} onClick={saveEdit}>저장</button>
                                <button className="btn btn-sm" style={{ flex: 1, padding: '2px 0', fontSize: 10 }} onClick={cancelEdit}>취소</button>
                              </div>
                            </div>
                          ) : tier ? (
                            <span
                              className="badge b-tier"
                              onClick={() => startEdit(userId, line, tier)}
                              style={{ fontSize: tierFontSize(tier), padding: '2px 6px', whiteSpace: 'nowrap', cursor: 'pointer' }}
                            >
                              {tier}
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>없음</span>
                          )}
                        </div>
                      )
                    })}
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
              inactiveList.map(({ userId, name, days }) => {
                const isInactive = inactiveStatusMap.get(userId) ?? false
                return (
                  <div key={userId} style={{
                    marginBottom: 10, padding: '10px 12px', background: 'var(--bg3)',
                    borderRadius: 'var(--radius)', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <span style={{ fontWeight: 700 }}><NameWithIdBadge name={name} idPrefixMap={idPrefixMap} userId={userId} /></span>
                      <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>
                        {days}일 미참여
                        {isInactive && <span style={{ marginLeft: 8, color: 'var(--red)', fontWeight: 700 }}>비활성화</span>}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button className="btn btn-sm" onClick={() => toggleInactive(userId, isInactive)}>
                        {isInactive ? '활성화' : '비활성화'}
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteSummoner(userId, name)}>삭제</button>
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
