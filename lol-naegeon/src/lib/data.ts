export const LINES = ['탑', '정글', '미드', '원딜', '서포터'] as const
export type Line = typeof LINES[number]

// 티어명 : 해당 티어 진입에 필요한 최소 점수
const TIER_THRESHOLDS: { tier: string; minScore: number }[] = [
  { tier: "언랭",             minScore: -Infinity },
  { tier: "실버2",            minScore: 13 },
  { tier: "실버1",            minScore: 14 },
  { tier: "골드4",            minScore: 14 },
  { tier: "골드3",            minScore: 15 },
  { tier: "골드2",            minScore: 16 },
  { tier: "골드1",            minScore: 18 },
  { tier: "플래티넘4",        minScore: 19 },
  { tier: "플래티넘3",        minScore: 20 },
  { tier: "플래티넘2",        minScore: 21 },
  { tier: "플래티넘1",        minScore: 23 },
  { tier: "에메랄드4",        minScore: 24 },
  { tier: "에메랄드3",        minScore: 26 },
  { tier: "에메랄드2",        minScore: 27 },
  { tier: "에메랄드1",        minScore: 29 },
  { tier: "다이아4",          minScore: 31 },
  { tier: "다이아3",          minScore: 33 },
  { tier: "다이아2",          minScore: 35 },
  { tier: "다이아1",          minScore: 36 },
  { tier: "마스터 0층",       minScore: 38 },
  { tier: "마스터 1층",       minScore: 39 },
  { tier: "마스터 2층",       minScore: 40 },
  { tier: "마스터 3층",       minScore: 42 },
  { tier: "마스터 4층",       minScore: 44 },
  { tier: "마스터 5층",       minScore: 46 },
  { tier: "마스터 6층",       minScore: 48 },
  { tier: "마스터 7층",       minScore: 51 },
  { tier: "그랜드마스터 8층", minScore: 54 },
  { tier: "그랜드마스터 9층", minScore: 56 },
  { tier: "그랜드마스터 10층", minScore: 57 },
  { tier: "그랜드마스터 11층", minScore: 58 },
  { tier: "그랜드마스터 12층", minScore: 59 },
  { tier: "그랜드마스터 13층", minScore: 60 },
  { tier: "그랜드마스터 14층", minScore: 60 },
  { tier: "챌린저 15층",      minScore: 61 },
  { tier: "챌린저 16층",      minScore: 61 },
  { tier: "챌린저 17층",      minScore: 62 },
  { tier: "리그오브레전드",    minScore: 62 },
]

// 티어명 → 시작 점수 (기존 소환사 등록/소환사 관리에서 티어명 선택 시 사용)
const TIER_START_SCORE: Record<string, number> = {}
TIER_THRESHOLDS.forEach(t => { TIER_START_SCORE[t.tier] = t.minScore === -Infinity ? 12 : t.minScore })

export const TIERS = TIER_THRESHOLDS.map(t => t.tier)

// 점수로 티어명 찾기 (점수가 해당 구간에 들어가는 가장 높은 티어)
export function getTierByScore(score: number): string {
  let result = TIER_THRESHOLDS[0].tier
  for (const t of TIER_THRESHOLDS) {
    if (score >= t.minScore) result = t.tier
    else break
  }
  return result
}

// 티어명으로 점수 가져오기 (소환사 최초 등록 시 시작 점수)
export function getScoreByTier(tier: string): number {
  return TIER_START_SCORE[tier] ?? 12
}

// 기존 호환용: 티어명 + 라인 → 점수 (라인은 더 이상 점수에 영향 없음, 시작점수 반환)
export function getScore(tier: string, line: Line): number {
  return getScoreByTier(tier)
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
