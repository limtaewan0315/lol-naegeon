'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/shared'
import { TIERS } from '@/lib/data'

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

export function SignupRequestsTab({ onRefresh }: { onRefresh: () => void }) {
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

// ── 허가요청 탭 (관리자 전용) — 가입신청 승인 ────────────────────────
export function ApprovalRequestsTab({ onRefresh }: { onRefresh: () => void }) {
  return <SignupRequestsTab onRefresh={onRefresh} />
}

// ── 내전방 (로비: 방 생성/목록/입장/퇴장) — 1단계 ──────────────────────
