'use client'

import { useState } from 'react'
import type { Line } from '@/lib/data'
import { LINES, TIERS } from '@/lib/data'
import {
  supabase, isValidLoginId, loginIdToAuthKey, isOldNumericId, oldNumericIdToAuthKey,
  normalizeNumericId, idToAuthKey, PRIVACY_CONSENT_DETAIL
} from '@/lib/shared'

export default function LoginPage({ onAuthSuccess }: { onAuthSuccess: () => void }) {
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
        background: 'var(--bg2)', borderRadius: 'var(--radius-lg)',
        padding: 30, width: 340, boxShadow: 'var(--shadow-pop)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: 'var(--gold2)', marginBottom: 8 }}>
            내전 매니저
          </div>
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
