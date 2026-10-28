import type { Session } from './types'

/** 1234 → "1.2k", 3_400_000 → "3.4M". */
export const tokenText = (n: number): string =>
  n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n)
export const usageTotal = (u: NonNullable<Session['usage']>): number => u.input + u.output + u.cacheRead + u.cacheWrite
/** "2.6M tok (2.4M cached)": most of a long conversation's total is cache reads, which cost far less than new tokens. */
export const usageText = (u: NonNullable<Session['usage']>): string =>
  `${tokenText(usageTotal(u))} tok${u.cacheRead ? ` (${tokenText(u.cacheRead)} cached)` : ''}`
