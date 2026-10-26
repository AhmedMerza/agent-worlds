import { afterAll, describe, expect, it, vi } from 'vitest'
import { mk } from './helpers'

vi.stubGlobal('Image', class { complete = true; naturalWidth = 1280; naturalHeight = 1280; src = '' })
const { illustratedRoom, officePage, OFFICE_PAGE_SIZE } = await import('../src/illustratedRoom')
const { hitTest } = await import('../src/canvas')
afterAll(() => vi.unstubAllGlobals())

describe('illustrated room selection', () => {
  it('keeps all 25 or 50 sessions reachable exactly once across readable pages', () => {
    for (const count of [25, 50]) {
      const sessions = Array.from({ length: count }, (_, i) => mk(`session-${i}`, { startedAt: i }))
      const pages = Array.from({ length: Math.ceil(count / OFFICE_PAGE_SIZE) }, (_, i) => officePage([...sessions].reverse(), i))
      expect(pages.flat().map(s => s.id)).toEqual(sessions.map(s => s.id))
      expect(pages.every(p => p.length > 0 && p.length <= 4)).toBe(true)
      expect(officePage(sessions, 999)).toEqual(pages.at(-1))
    }
  })
  it('opens the named session when its visible label is clicked', () => {
    const labels: { id: string; x: number; y: number }[] = []
    const ctx = new Proxy({
      measureText: () => ({ width: 55 }),
      fillText: (text: string, x: number, y: number) => { if (text.startsWith('session-')) labels.push({ id: text, x, y }) },
    }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as CanvasRenderingContext2D
    const sessions = Array.from({ length: 4 }, (_, i) => mk(`session-${i + 1}`))
    const hits = illustratedRoom(ctx, { group: { world: { id: 'web', name: 'Web', color: '#47b4a7', repos: [] }, sessions }, selectedId: null, t: 0, now: 0, reduced: true, walkers: new Map(), k: 1, h: 480 })!
    expect(labels).toHaveLength(4)
    for (const label of labels) expect(hitTest(hits, label.x, label.y)?.id, label.id).toBe(label.id)
  })
})
