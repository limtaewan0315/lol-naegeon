import React from 'react'
import { createClient } from '@supabase/supabase-js'
import { TIERS, LINES, getScore, getTierByScore, getScoreByTier, shuffle } from '@/lib/data'
import type { Line } from '@/lib/data'

export type TeamPlayer = { userId: string; name: string; tier: string; line: Line; score: number }
export interface BalanceResult { team1: TeamPlayer[]; team2: TeamPlayer[]; s1: number; s2: number }
// blue/red는 {userId, name, line} 객체 배열로 저장 (userId가 진짜 식별자, name은 그 시점 표시용 라벨)
export interface GameRecord {
  id: number
  winner: 'blue' | 'red'
  blue: { userId?: string; name: string; line: Line }[]
  red: { userId?: string; name: string; line: Line }[]
  time: string
}

export const ADMIN_PASSWORD = 'daumathematics'

export const DISCORD_WEBHOOK_URL = 'https://discordapp.com/api/webhooks/1517851751976538182/5o_PAydNLLEWPzhbl49GAIszwcMloutO-GWhv25j_KtKLtmiFT5NwuOpSPmWf8J4okBF'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

export const LINE_ORDER: Record<string, number> = { 탑: 0, 정글: 1, 미드: 2, 원딜: 3, 서포터: 4 }

// summoners 테이블: { name, line, tier } (name+line 복합키)
// SummonerMap: name -> { line -> tier } (표시용 티어명)
export type SummonerMap = Record<string, Record<Line, string>>
// SummonerScoreMap: name -> { line -> score } (실제 포인트, 티어 계산의 기준)
export type SummonerScoreMap = Record<string, Record<Line, number>>

// 팀 뽑기용 플레이어 (모스트1/2 포함)
export interface PlayerEntry {
  userId: string
  name: string
  most1: Line | 'any'
  most2: Line | 'any' | null
  // 매칭 결정 후 확정 라인/점수
  assignedLine?: Line
  assignedScore?: number
}

export function checkPassword(): boolean {
  const input = prompt('보안 코드를 입력해주세요')
  if (input === null) return false
  if (input === ADMIN_PASSWORD) return true
  alert('보안 코드가 올바르지 않아요.')
  return false
}

// 동명이인 구분용: 이름 옆에 아이디 앞 4자리를 작은 회색 글씨로 붙여서 표시
// userId가 있으면 계정ID로 정확히 조회(동명이인도 정확히 구분), 없으면 예전처럼 이름으로 조회(하위호환)
export function NameWithIdBadge({ name, idPrefixMap, userId }: { name: string; idPrefixMap: Record<string, string>; userId?: string }) {
  const prefix = userId ? idPrefixMap[userId] : idPrefixMap[name]
  return (
    <>
      {name}
      {prefix && <span style={{ fontSize: 10, color: 'var(--text3)', marginLeft: 4 }}>{prefix}</span>}
    </>
  )
}

// 티어 이름 길이에 맞춰 글자 크기를 줄여서, 좁은 칸 안에서도 한 줄로 안 잘리게 함
export function tierFontSize(tier: string): number {
  const len = tier.length
  if (len <= 3) return 11
  if (len <= 5) return 10
  if (len <= 7) return 9
  return 8
}

// 점수 기반 티어 시스템 헬퍼
export function tierUp(tier: string): string {
  // 호환용: 기존 코드에서 호출하는 곳이 있다면 다음 티어명 반환 (점수 무관)
  const idx = TIERS.indexOf(tier)
  if (idx <= 0) return TIERS[0]
  return TIERS[idx - 1]
}
export function tierDown(tier: string): string {
  const idx = TIERS.indexOf(tier)
  if (idx < 0 || idx >= TIERS.length - 1) return TIERS[TIERS.length - 1]
  return TIERS[idx + 1]
}

export function isDia1OrAbove(tier: string): boolean {
  const dia1Tiers = ['다이아1', '마스터 0층', '마스터 1층', '마스터 2층', '마스터 3층', '마스터 4층', '마스터 5층', '마스터 6층', '마스터 7층', '그랜드마스터 8층', '그랜드마스터 9층', '그랜드마스터 10층', '그랜드마스터 11층', '그랜드마스터 12층', '그랜드마스터 13층', '그랜드마스터 14층', '챌린저 15층', '챌린저 16층', '챌린저 17층', '리그오브레전드']
  return dia1Tiers.includes(tier)
}

export function isSilver3OrBelowGlobal(tier: string): boolean {
  return ['언랭'].includes(tier)
}

// ── 관리자 탭 ──────────────────────────────────────────────

export const LOGIN_ID_REGEX = /^[A-Za-z0-9_]{5,20}$/

export function isValidLoginId(raw: string): boolean {
  return LOGIN_ID_REGEX.test(raw.trim())
}

// 아이디 → 계정 시스템에 등록할 내부 인증키로 변환
// (관리자 승인 시 DB 함수(approve_signup_request)가 만드는 계정과 동일한 규칙이어야 함)
export function loginIdToAuthKey(id: string): string {
  return `${id.trim().toLowerCase()}@id.lol-naegeon.local`
}

// 예전에는 숫자로만 된 아이디 체계를 썼음(010/011/016/017/018/019로 시작하는 11자리 숫자, 하이픈 유무 무관)
// — 그 시기에 만들어진 계정들의 로그인 호환을 위해 유지
export const OLD_NUMERIC_ID_REGEX = /^01[016789]\d{7,8}$/

export function normalizeNumericId(raw: string): string {
  return raw.replace(/[^0-9]/g, '')
}

export function isOldNumericId(raw: string): boolean {
  return OLD_NUMERIC_ID_REGEX.test(normalizeNumericId(raw))
}

export function oldNumericIdToAuthKey(id: string): string {
  return `${normalizeNumericId(id)}@phone.lol-naegeon.local`
}

// 문자열 → UTF-8 hex (Postgres의 encode(convert_to(text,'UTF8'),'hex')와 동일한 결과)
// 아주 예전 레거시 계정(아이디=소환사명)을 내부 인증키로 안전하게 변환하기 위함
export function toHexUtf8(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// 소환사명(레거시 계정 아이디) → 내부 인증키
// SQL 마이그레이션(create-legacy-accounts.js)에서 생성한 계정과 동일한 규칙(hex 인코딩)을 사용해야 함
export function nameToAuthKey(name: string): string {
  return `${toHexUtf8(name.trim())}@name.lol-naegeon.local`
}

// 로그인 화면의 "아이디" 입력값 → 실제 인증에 쓸 내부 키
// 자유 아이디 형식이면 신규 계정 방식으로, 예전 숫자형 아이디 형식이면 구버전 방식(하위호환)으로,
// 그 외(소환사명 등)는 레거시 계정 방식으로 변환
export function idToAuthKey(id: string): string {
  const trimmed = id.trim()
  if (isOldNumericId(trimmed)) return oldNumericIdToAuthKey(trimmed)
  if (isValidLoginId(trimmed)) return loginIdToAuthKey(trimmed)
  return nameToAuthKey(trimmed)
}


// ── 개인정보 수집·이용 동의 상세 내용 ──────────────────────────────────
export const PRIVACY_CONSENT_DETAIL = `[개인정보 수집·이용 동의]

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
