import { describe, expect, it } from 'vitest'
import { queue, tiredLevel, routeKey, groupSessions, nextNeedingYou, waitMinutes, buildAnswers, type KeyInfo } from '../src/logic'
import { mk, perm } from './helpers'

describe('queue', () => {
  it('orders permission, question, error, done, then oldest first', () => {
    const s = [
      mk('done-old', { state: 'done', card: { kind: 'done', summary: null }, waitingSince: 1 }),
      mk('err', { state: 'error', card: { kind: 'error', summary: 'x' }, waitingSince: 5 }),
      mk('q', { state: 'waiting', card: { kind: 'question', requestId: 'q', questions: [] }, waitingSince: 9 }),
      mk('p-new', { state: 'waiting', card: perm, waitingSince: 100 }),
      mk('p-old', { state: 'waiting', card: perm, waitingSince: 50 }),
      mk('busy', { state: 'working' }),
      mk('idle-with-stale-card', { state: 'idle', card: perm }),
    ]
    expect(queue(s).map((x) => x.id)).toEqual(['p-old', 'p-new', 'q', 'err', 'done-old'])
  })
  it('falls back to updatedAt when waitingSince is null', () => {
    const a = mk('a', { state: 'done', card: { kind: 'done', summary: null }, updatedAt: 20 })
    const b = mk('b', { state: 'done', card: { kind: 'done', summary: null }, updatedAt: 10 })
    expect(queue([a, b]).map((x) => x.id)).toEqual(['b', 'a'])
  })
  it('nextNeedingYou wraps and handles empty', () => {
    const q = [mk('a'), mk('b')]
    expect(nextNeedingYou(q, 'a')?.id).toBe('b')
    expect(nextNeedingYou(q, 'b')?.id).toBe('a')
    expect(nextNeedingYou(q, 'zzz')?.id).toBe('a')
    expect(nextNeedingYou([], 'a')).toBeNull()
  })
})

describe('tiredLevel / waitMinutes', () => {
  it('flips at 10 and 20 minutes', () => {
    expect([0, 9, 10, 19, 20, 45].map(tiredLevel)).toEqual([0, 0, 1, 1, 2, 2])
  })
  it('counts whole minutes', () => {
    expect(waitMinutes(mk('a', { waitingSince: 0 }), 119999)).toBe(1)
    expect(waitMinutes(mk('a', { waitingSince: 500 }), 0)).toBe(0)
  })
})

describe('routeKey', () => {
  const base: KeyInfo = { key: ' ', ctrl: false, meta: false, alt: false, typing: false, overlayOpen: false }
  it('maps the shortcuts', () => {
    expect(routeKey(base)).toEqual({ kind: 'next' })
    expect(routeKey({ ...base, key: '3' })).toEqual({ kind: 'jump', index: 2 })
    expect(routeKey({ ...base, key: '?' })).toEqual({ kind: 'help' })
    expect(routeKey({ ...base, key: '0' })).toBeNull()
  })
  it('never fires while typing or in the terminal', () => {
    for (const key of [' ', '1', '?']) expect(routeKey({ ...base, key, typing: true })).toBeNull()
  })
  it('leaves Space to a focused button but still allows digits', () => {
    expect(routeKey({ ...base, onControl: true })).toBeNull()
    expect(routeKey({ ...base, key: '2', onControl: true })).toEqual({ kind: 'jump', index: 1 })
  })
  it('ignores modifier combos', () => {
    expect(routeKey({ ...base, key: '1', ctrl: true })).toBeNull()
  })
  it('Escape only counts when an overlay is open', () => {
    expect(routeKey({ ...base, key: 'Escape' })).toBeNull()
    expect(routeKey({ ...base, key: 'Escape', overlayOpen: true, typing: true })).toEqual({ kind: 'escape' })
  })
})

describe('groupSessions', () => {
  const worlds = [{ id: 'web', name: 'Web', color: '#fff', repos: [] }, { id: 'tools', name: 'Tools', color: '#000', repos: [] }]
  it('adds Unsorted for null or unknown worlds, only when needed', () => {
    const g = groupSessions(worlds, [mk('a'), mk('b', { worldId: null }), mk('c', { worldId: 'gone' })])
    expect(g.map((x) => [x.world.id, x.sessions.map((s) => s.id)])).toEqual([['web', ['a']], ['tools', []], ['__unsorted', ['b', 'c']]])
    expect(groupSessions(worlds, [mk('a')]).length).toBe(2)
  })
})

describe('buildAnswers', () => {
  const qs = [{ question: 'A?', multiSelect: false }, { question: 'B?', multiSelect: true }]
  it('requires every question and joins multi-select', () => {
    expect(buildAnswers(qs, { 'A?': ['x'] })).toBeNull()
    expect(buildAnswers(qs, { 'A?': ['x'], 'B?': ['p', 'q'] })).toEqual({ 'A?': 'x', 'B?': 'p, q' })
  })
})
