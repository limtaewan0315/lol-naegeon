import { Line } from './data'

export interface Player {
  name: string
  tier: string
  line: Line
  score: number
}

export interface GameRecord {
  id: number
  winner: 'blue' | 'red'
  blue: string[]
  red: string[]
  time: string
}

export interface BalanceResult {
  team1: Player[]
  team2: Player[]
  s1: number
  s2: number
}
