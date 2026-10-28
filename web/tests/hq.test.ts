import { describe, expect, it } from 'vitest'
import { tokenText, usageText } from '../src/hq'

describe('hq', () => {
  it('shortens token counts', () => {
    expect([999, 1234, 3_400_000, 2e9].map(tokenText)).toEqual(['999', '1.2k', '3.4M', '2B'])
    expect(usageText({ input: 1200, output: 38000, cacheRead: 2_400_000, cacheWrite: 180000 })).toBe('2.6M tok (2.4M cached)')
    expect(usageText({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })).toBe('15 tok')
  })
})
