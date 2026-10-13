import { describe, expect, it } from 'vitest'
import { assignZones, zoneOf, slotPos, walkPos, retarget, capacity, ZONE_X, WALK_MS, pauseWalker } from '../src/zones'
import { mk, perm } from './helpers'

describe('zones', () => {
  it('maps states to zones', () => {
    expect(['working', 'idle', 'waiting', 'done', 'error'].map((s) => zoneOf(s as never))).toEqual(['desks', 'lounge', 'help', 'help', 'help'])
  })
  it('keeps slot order stable by start time, whatever the state changes', () => {
    const a = mk('a', { startedAt: 3 }), b = mk('b', { startedAt: 1 }), c = mk('c', { startedAt: 2 })
    expect(assignZones([a, b, c]).desks.map((s) => s.id)).toEqual(['b', 'c', 'a'])
    // c starts waiting: the others keep their relative order, nobody shuffles
    const c2 = mk('c', { startedAt: 2, state: 'waiting', card: perm })
    const z = assignZones([a, b, c2])
    expect(z.desks.map((s) => s.id)).toEqual(['b', 'a'])
    expect(z.help.map((s) => s.id)).toEqual(['c'])
    // a joins help later: ordered by start time, not by who arrived last
    expect(assignZones([mk('a', { startedAt: 3, state: 'done' }), c2]).help.map((s) => s.id)).toEqual(['c', 'a'])
  })
  it('ties break by id', () => {
    expect(assignZones([mk('z'), mk('m')]).desks.map((s) => s.id)).toEqual(['m', 'z'])
  })
  it('slots stay inside their zone for 0-8 sessions and spacing shrinks', () => {
    for (const zone of ['lounge', 'desks', 'help'] as const) {
      for (let n = 1; n <= 8; n++) {
        const xs = Array.from({ length: Math.min(n, capacity(zone)) }, (_, i) => slotPos(zone, i, n).x)
        for (const x of xs) { expect(x).toBeGreaterThan(ZONE_X[zone][0]); expect(x).toBeLessThan(ZONE_X[zone][1]) }
        expect(new Set(Array.from({ length: Math.min(n, capacity(zone)) }, (_, i) => slotPos(zone, i, n).x + ',' + slotPos(zone, i, n).top)).size).toBe(Math.min(n, capacity(zone)))
      }
    }
    expect(slotPos('desks', 0, 4).x - 0).toBeLessThan(slotPos('desks', 0, 1).x)
  })
  it('eight sessions fit a zone without a +N marker', () => {
    expect(capacity('lounge')).toBeGreaterThanOrEqual(8)
    expect(capacity('desks')).toBeGreaterThanOrEqual(8)
    expect(capacity('help')).toBeGreaterThanOrEqual(8)
  })
})

describe('walking', () => {
  const A = { x: 0, top: 0 }, B = { x: 100, top: 40 }
  it('interpolates from start to end over ~1s', () => {
    expect(walkPos(A, B, 0, false)).toMatchObject({ x: 0, top: 0, moving: true })
    const mid = walkPos(A, B, WALK_MS / 2, false)
    expect(mid.x).toBeCloseTo(50); expect(mid.top).toBeCloseTo(20)
    expect(walkPos(A, B, WALK_MS, false)).toEqual({ x: 100, top: 40, moving: false })
  })
  it('is instant with reduced motion', () => {
    expect(walkPos(A, B, 0, true)).toEqual({ x: 100, top: 40, moving: false })
  })
  it('retarget: first sight places without walking; a new target walks from where it is now', () => {
    const w0 = retarget(undefined, A, 0, false)
    expect(walkPos(w0.from, w0.to, 0, false).moving).toBe(false)
    const w1 = retarget(w0, B, 100, false)
    expect(w1.from).toEqual(A)
    const w2 = retarget(w1, { x: 0, top: 0 }, 100 + WALK_MS / 2, false) // changes its mind halfway
    expect(w2.from.x).toBeCloseTo(50)
    expect(retarget(w2, w2.to, 5000, false)).toBe(w2) // same target keeps the walker
  })
})

import { roomHeight, ROOM_H } from '../src/zones'
describe('roomHeight', () => {
  it('grows with the busiest zone and is bounded', () => {
    const one = roomHeight([mk('a')])
    const eight = roomHeight(Array.from({ length: 8 }, (_, i) => mk('s' + i)))
    expect(eight).toBeGreaterThan(one)
    expect(roomHeight([])).toBeGreaterThanOrEqual(150)
    expect(roomHeight(Array.from({ length: 30 }, (_, i) => mk('s' + i)))).toBeLessThanOrEqual(ROOM_H)
  })
})

describe('walking sprites', () => {
  it('a held walk resumes where it stopped', () => {
    const w = { from: { x: 0, top: 0 }, to: { x: 100, top: 0 }, start: 0 }
    const at = (t: number) => walkPos(w.from, w.to, t - w.start, false).x
    const before = at(400)
    pauseWalker(w, 300)
    expect(at(700)).toBeCloseTo(before)
  })
})

import { look } from '../src/canvas'
describe('look', () => {
  it('gives every session a hair and skin colour, whatever its id hashes to', () => {
    for (let i = 0; i < 500; i++) { const l = look('session-' + i); expect(l.hair).toMatch(/^#/); expect(l.skin).toMatch(/^#/); expect(l.shirt).toMatch(/^#/) }
  })
})
