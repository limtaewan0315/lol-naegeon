export const LINES = ['탑', '정글', '미드', '원딜', '서포터'] as const
export type Line = typeof LINES[number]

const FLAT_SCORES: Record<string, number> = {
  "리그오브레전드":   62,
  "챌린저 17층": 62,
  "챌린저 16층": 61,
  "챌린저 15층": 61,
  "그랜드마스터 14층": 60,
  "그랜드마스터 13층": 60,
  "그랜드마스터 12층": 59,
  "그랜드마스터 11층": 58,
  "그랜드마스터 10층": 57,
  "그랜드마스터 9층":   56,
  "그랜드마스터 8층":   54,
  "마스터 7층":   51,
  "마스터 6층":   48,
  "마스터 5층":   46,
  "마스터 4층":   44,
  "마스터 3층":   42,
  "마스터 2층":   40,
  "마스터 1층":   39,
  "마스터 0층":      38,
  "다이아1":            36,
  "다이아2":            35,
  "다이아3":            33,
  "다이아4":            31,
  "에메랄드1":          29,
  "에메랄드2":          27,
  "에메랄드3":          26,
  "에메랄드4":          24,
  "플래티넘1":          23,
  "플래티넘2":          21,
  "플래티넘3":          20,
  "플래티넘4":          19,
  "골드1":              18,
  "골드2":              16,
  "골드3":              15,
  "골드4":              14,
  "실버1":              14,
  "실버2":              13,
  "실버3 이하":         12,
}

export const TIERS = Object.keys(FLAT_SCORES)

export function getScore(tier: string, line: Line): number {
  return FLAT_SCORES[tier] ?? 12
}

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
