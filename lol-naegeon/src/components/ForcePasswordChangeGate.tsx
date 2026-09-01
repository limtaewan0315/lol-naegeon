'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/shared'

export default function ForcePasswordChangeGate({ onDone }: { onDone: () => void }) {
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
