import { describe, expect, it } from 'vitest'
import { cameraOn, hqPlaces, tokenText, HQ_PAGE_SIZE } from '../src/hq'
import type { Session } from '../src/types'

const s = (id: string, startedAt: number) => ({ id, startedAt }) as Session

describe('hq', () => {
  it('puts a small team in the middle of the floor and pages a big one, oldest first', () => {
    expect(hqPlaces([s('a', 1)], 0)).toMatchObject([{ x: 50, y: 67 }])
    const many = Array.from({ length: HQ_PAGE_SIZE + 2 }, (_, i) => s(`s${i}`, i))
    expect(hqPlaces(many, 0)).toHaveLength(HQ_PAGE_SIZE)
    expect(new Set(hqPlaces(many, 1).map(p => p.s.id))).toEqual(new Set([`s${HQ_PAGE_SIZE}`, `s${HQ_PAGE_SIZE + 1}`]))
    expect(hqPlaces(many, 9).map(p => p.s.id)).toEqual(hqPlaces(many, 1).map(p => p.s.id))
    const ys = hqPlaces(many, 0).map(p => p.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b)) // back to front
  })
  it('centres the camera on a point but never past the stage edge', () => {
    expect(cameraOn(800, 500, 400, 250, 2)).toEqual({ z: 2, x: -400, y: -250 })
    expect(cameraOn(800, 500, 0, 0, 2)).toEqual({ z: 2, x: 0, y: 0 })
    expect(cameraOn(800, 500, 800, 500, 2)).toEqual({ z: 2, x: -800, y: -500 })
    expect(cameraOn(800, 500, 100, 100, 0.2)).toEqual({ z: 1, x: 0, y: 0 })
    expect(cameraOn(800, 500, 400, 250, 2, 600, 250)).toEqual({ z: 2, x: -200, y: -250 }) // to the right of a card
  })
  it('shortens token counts', () => {
    expect([999, 1234, 3_400_000, 2e9].map(tokenText)).toEqual(['999', '1.2k', '3.4M', '2B'])
  })
})
