'use client'

import { useState, useEffect } from 'react'
import type { Line } from '@/lib/data'
import { LINES, getScoreByTier, TIERS } from '@/lib/data'
import {
  supabase, SummonerMap, SummonerScoreMap, GameRecord, LINE_ORDER,
  checkPassword, isValidLoginId, idToAuthKey, tierFontSize
} from '@/lib/shared'

export default function MyInfoTab({ summoners, summonerScores, records, idPrefixMap, onRefresh }: { summoners: SummonerMap; summonerScores: SummonerScoreMap; records: GameRecord[]; idPrefixMap: Record<string, string>; onRefresh: () => void }) {
  const [loading, setLoading] = useState(true)
  const [displayId, setDisplayId] = useState('')
  const [summonerName, setSummonerName] = useState<string | null>(null)
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const [riotId, setRiotId] = useState('')

  // 인라인 편집 상태: 지금 어떤 필드를 수정 중인지 (한 번에 하나만)
  const [editingField, setEditingField] = useState<'id' | 'password' | 'riot' | 'name' | null>(null)
  const [saving, setSaving] = useState(false)
  const [fieldError, setFieldError] = useState('')

  const [idInput, setIdInput] = useState('')
  const [riotInput, setRiotInput] = useState('')
  const [nameInput, setNameInput] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPassword2, setNewPassword2] = useState('')
  const [myRecordsPage, setMyRecordsPage] = useState(1)
  const [needsCorrection, setNeedsCorrection] = useState(false)
  const [correctionNote, setCorrectionNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      const { data: { session } } = await supabase.auth.getSession()
      const user = session?.user ?? null
      if (cancelled) return

      let name: string | null = null
      if (user) {
        setMyUserId(user.id)
        // 본인 계정에 연결된 소환사명/롤계정만 조회 (RLS로 보호되어 다른 사람 데이터는 조회 불가)
        const { data } = await supabase
          .from('member_accounts')
          .select('summoner_name, riot_id, needs_correction, correction_note')
          .eq('user_id', user.id)
          .maybeSingle()
        name = data?.summoner_name ?? null
        if (!cancelled) {
          setSummonerName(name)
          setRiotId(data?.riot_id ?? '')
          setNeedsCorrection(!!data?.needs_correction)
          setCorrectionNote(data?.correction_note ?? null)
        }
      }

      // 로그인 아이디로 실제 사용하는 값만 표시 (내부 인증키는 노출하지 않음)
      // 신규 가입자는 본인이 정한 아이디, 예전 방식(전화번호) 계정은 전화번호, 레거시 계정은 소환사명이 곧 아이디
      const loginIdMeta = (user?.user_metadata?.login_id ?? user?.user_metadata?.phone) as string | undefined
      if (!cancelled) setDisplayId(loginIdMeta || name || '')

      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
  }, [])

  const startEdit = (field: 'id' | 'password' | 'riot' | 'name') => {
    setEditingField(field)
    setFieldError('')
    setIdInput(displayId)
    setRiotInput(riotId)
    setNameInput(summonerName ?? '')
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

  const saveName = async () => {
    const trimmed = nameInput.trim()
    if (!trimmed) {
      setFieldError('이름을 입력해주세요')
      return
    }
    setSaving(true)
    setFieldError('')
    const { error: err } = await supabase.rpc('self_update_name_if_flagged', { p_new_name: trimmed })
    if (err) {
      setFieldError('저장 실패: ' + err.message)
    } else {
      setSummonerName(trimmed)
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

  // 계정ID로 조회 (동명이인이어도 정확하게 본인 것만 나옴)
  const myLines: Partial<Record<Line, string>> = myUserId ? (summoners[myUserId] ?? {}) : {}

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

          {/* 소환사명: 평소엔 수정 불가, 관리자가 "정보 수정 요청"을 걸어둔 경우에만 수정 가능 */}
          {needsCorrection && (
            <div style={{
              fontSize: 11, color: 'var(--red)', marginBottom: 6,
              background: 'var(--red-bg)', border: '0.5px solid var(--red-border)',
              borderRadius: 'var(--radius)', padding: '6px 10px',
            }}>
              ⚠ 관리자가 정보 수정을 요청했어요: {correctionNote || '내용 없음'}
            </div>
          )}
          {editingField === 'name' ? (
            <div style={rowStyle}>
              <span style={labelStyle}>소환사명:</span>
              <input
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                disabled={saving}
                style={{ flex: 1 }}
              />
              <button className="btn btn-gold btn-sm" onClick={saveName} disabled={saving} style={editBtnStyle}>{saving ? '저장 중...' : '저장'}</button>
              <button className="btn btn-sm" onClick={cancelEdit} disabled={saving} style={editBtnStyle}>취소</button>
            </div>
          ) : (
            <div style={rowStyle}>
              <span style={labelStyle}>소환사명:</span>
              <strong style={{ flex: 1 }}>{summonerName}</strong>
              {needsCorrection && (
                <button className="btn btn-gold btn-sm" onClick={() => startEdit('name')} style={editBtnStyle}>수정</button>
              )}
            </div>
          )}

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
        <div className="card-title">내 라인</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6 }}>
          {LINES.map(l => {
            const lineRecs = myUserId ? records.filter(r =>
              r.blue.some(p => p.userId === myUserId && p.line === l) ||
              r.red.some(p => p.userId === myUserId && p.line === l)
            ) : []
            const lineWin = lineRecs.filter(r => {
              const inBlue = r.blue.some(p => p.userId === myUserId && p.line === l)
              return (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
            }).length
            const lineTotal = lineRecs.length
            const lineLose = lineTotal - lineWin
            const lineWr = lineTotal > 0 ? Math.round(lineWin / lineTotal * 100) : null

            return (
              <div key={l} style={{
                background: 'var(--bg3)', padding: '10px 4px 8px',
                borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-inset)',
                textAlign: 'center', transition: 'box-shadow 0.15s',
              }}>
                <div style={{ fontSize: 13, color: 'var(--gold)', marginBottom: 3, fontWeight: 700 }}>{l}</div>
                {myLines[l] ? (
                  <span className="badge b-tier" style={{ fontSize: tierFontSize(myLines[l]!), padding: '2px 6px', whiteSpace: 'nowrap' }}>{myLines[l]}</span>
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>없음</span>
                )}
                <div style={{ marginTop: 6, fontSize: 9, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
                  {lineTotal > 0 ? `${lineWin}승 ${lineLose}패` : '전적없음'}
                </div>
                {lineWr !== null && (
                  <div style={{ fontSize: 11, fontWeight: 700, color: lineWr >= 50 ? 'var(--green)' : 'var(--red)' }}>
                    {lineWr}%
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      {myUserId && (() => {
        const myRecords = records.filter(r => r.blue.some(p => p.userId === myUserId) || r.red.some(p => p.userId === myUserId))
        const win = myRecords.filter(r => {
          const inBlue = r.blue.some(p => p.userId === myUserId)
          return (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
        }).length
        const lose = myRecords.length - win
        const PAGE_SIZE = 10
        const totalPages = Math.ceil(myRecords.length / PAGE_SIZE)
        const paged = myRecords.slice((myRecordsPage - 1) * PAGE_SIZE, myRecordsPage * PAGE_SIZE)

        const sortTeam = (team: GameRecord['blue']) => [...team].sort((a, b) => (LINE_ORDER[a.line] ?? 9) - (LINE_ORDER[b.line] ?? 9))
        const renderPlayer = (p: GameRecord['blue'][number], bg: string, border: string) => {
          const isMe = p.userId === myUserId
          return (
            <div key={p.userId ?? p.name} style={{
              display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px',
              background: bg, borderRadius: 999, fontSize: 11,
              border: isMe ? '1px solid var(--gold, #d4af37)' : `0.5px solid ${border}`,
              boxShadow: isMe ? '0 0 0 1px rgba(200,170,110,0.4)' : undefined,
            }}>
              <span style={{ color: 'var(--text2)', fontSize: 10 }}>{p.line}</span>
              <span style={{ color: isMe ? 'var(--gold, #d4af37)' : 'var(--text)', fontWeight: isMe ? 700 : 500 }}>
                {p.name}{isMe ? ' (나)' : ''}
              </span>
            </div>
          )
        }

        return (
          <div className="card">
            <div className="card-title">
              내 경기 기록 {myRecords.length > 0 ? `(${myRecords.length}전 ${win}승 ${lose}패)` : ''}
            </div>
            {myRecords.length === 0 ? (
              <div className="empty">아직 참여한 경기가 없어요.</div>
            ) : (
              paged.map((r, i) => {
                const inBlue = r.blue.some(p => p.userId === myUserId)
                const isWin = (inBlue && r.winner === 'blue') || (!inBlue && r.winner === 'red')
                return (
                  <div key={r.id} style={{ background: 'var(--bg3)', borderRadius: 'var(--radius)', marginBottom: 8, border: '0.5px solid var(--border)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', borderBottom: '0.5px solid var(--border)' }}>
                      <span style={{ fontSize: 12, color: 'var(--text3)', width: 20, flexShrink: 0 }}>
                        {myRecords.length - ((myRecordsPage - 1) * PAGE_SIZE + i)}
                      </span>
                      <span className={`badge ${r.winner === 'blue' ? 'b-win' : 'b-lose'}`} style={{ fontSize: 11 }}>
                        {r.winner === 'blue' ? '🔵 블루승' : '🔴 레드승'} ({isWin ? '승리' : '패배'})
                      </span>
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)' }}>{r.time}</span>
                    </div>
                    <div style={{ padding: '6px 12px', borderBottom: '0.5px solid var(--border)' }}>
                      <div style={{ fontSize: 10, color: 'var(--blue)', fontWeight: 600, marginBottom: 4 }}>🔵 블루팀</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {sortTeam(r.blue).map(p => renderPlayer(p, 'var(--blue-bg)', 'var(--blue-border)'))}
                      </div>
                    </div>
                    <div style={{ padding: '6px 12px' }}>
                      <div style={{ fontSize: 10, color: 'var(--red)', fontWeight: 600, marginBottom: 4 }}>🔴 레드팀</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {sortTeam(r.red).map(p => renderPlayer(p, 'var(--red-bg)', 'var(--red-border)'))}
                      </div>
                    </div>
                  </div>
                )
              })
            )}

            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => setMyRecordsPage(1)} disabled={myRecordsPage === 1}>{'<<'}</button>
                <button className="btn btn-sm" onClick={() => setMyRecordsPage(p => Math.max(1, p - 1))} disabled={myRecordsPage === 1}>{'<'}</button>
                {Array.from({ length: totalPages }, (_, idx) => idx + 1)
                  .filter(p => p === 1 || p === totalPages || Math.abs(p - myRecordsPage) <= 1)
                  .reduce((acc: (number | string)[], p, idx, arr) => {
                    if (idx > 0 && (p as number) - (arr[idx - 1] as number) > 1) acc.push('...')
                    acc.push(p)
                    return acc
                  }, [])
                  .map((p, idx) => typeof p === 'string'
                    ? <span key={idx} style={{ fontSize: 12, color: 'var(--text3)' }}>...</span>
                    : <button key={idx} className="btn btn-sm" onClick={() => setMyRecordsPage(p as number)}
                        style={{ background: myRecordsPage === p ? 'var(--blue2)' : undefined, color: myRecordsPage === p ? '#fff' : undefined }}>
                        {p}
                      </button>
                  )
                }
                <button className="btn btn-sm" onClick={() => setMyRecordsPage(p => Math.min(totalPages, p + 1))} disabled={myRecordsPage === totalPages}>{'>'}</button>
                <button className="btn btn-sm" onClick={() => setMyRecordsPage(totalPages)} disabled={myRecordsPage === totalPages}>{'>>'}</button>
                <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 4 }}>{myRecordsPage}/{totalPages}페이지</span>
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}


// ── 투표 섹션 ──────────────────────────────────────────────
// ── 전적 기록 탭 ──────────────────────────────────────────────
