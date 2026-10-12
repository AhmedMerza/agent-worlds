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

import { scopeAvailability, showLearnNudge, roomConflicts, startsNeedingYou, capDiff, ctxLevel, ctxColor } from '../src/logic'

describe('permission scopes', () => {
  it('disables Everywhere with a reason when risky', () => {
    const risky = { ...perm, risky: 'changes a database' }
    expect(scopeAvailability(risky)).toMatchObject({ repo: true, world: true, all: false })
    expect(scopeAvailability(risky).allReason).toContain('changes a database')
    expect(scopeAvailability(perm)).toEqual({ repo: true, world: true, all: true, allReason: null })
  })
  it('nudges from the third approval', () => {
    expect([0, 2, 3, 9].map((n) => showLearnNudge({ ...perm, seenCount: n }))).toEqual([false, false, true, true])
  })
})

describe('roomConflicts', () => {
  const a = mk('a', { conflicts: [{ withId: 'b', reason: 'same file' }] })
  const b = mk('b', { conflicts: [{ withId: 'a', reason: 'same file' }] })
  const c = mk('c', { conflicts: [{ withId: 'elsewhere', reason: 'x' }] })
  it('links same-room pairs once and badges cross-room ones', () => {
    const r = roomConflicts([a, b, c])
    expect(r.links).toEqual([{ a: 'a', b: 'b', reason: 'same file' }])
    expect(r.badges).toEqual(['c'])
  })
  it('a lone session with a partner outside the room is badged, not linked', () => {
    expect(roomConflicts([a])).toEqual({ links: [], badges: ['a'] })
  })
  it('no conflicts, nothing drawn', () => {
    expect(roomConflicts([mk('z')])).toEqual({ links: [], badges: [] })
  })
})

describe('startsNeedingYou', () => {
  const w = mk('a', { state: 'waiting', card: perm })
  it('fires on the transition into needing you, not while it continues', () => {
    expect(startsNeedingYou(mk('a'), w)).toBe(true)
    expect(startsNeedingYou(undefined, w)).toBe(true)
    expect(startsNeedingYou(w, { ...w, now: 'tick' })).toBe(false)
  })
  it('fires again for a new request in the same state', () => {
    expect(startsNeedingYou(w, { ...w, card: { ...perm, requestId: 'r2' } })).toBe(true)
  })
  it('fires for done and error, not for working, idle or cardless', () => {
    expect(startsNeedingYou(mk('a'), mk('a', { state: 'done', card: { kind: 'done', summary: null } }))).toBe(true)
    expect(startsNeedingYou(mk('a'), mk('a', { state: 'error', card: { kind: 'error', summary: 'x' } }))).toBe(true)
    expect(startsNeedingYou(w, mk('a', { state: 'working' }))).toBe(false)
    expect(startsNeedingYou(w, mk('a', { state: 'idle' }))).toBe(false)
    expect(startsNeedingYou(mk('a'), mk('a', { state: 'waiting', card: null }))).toBe(false)
  })
})

describe('capDiff', () => {
  const diff = Array.from({ length: 450 }, (_, i) => `+l${i}`).join('\n')
  it('caps at 400 lines and reports the rest', () => {
    const r = capDiff(diff)
    expect(r.lines.length).toBe(400)
    expect(r.hidden).toBe(50)
  })
  it('show-all and short diffs are untouched', () => {
    expect(capDiff(diff, 400, true)).toMatchObject({ hidden: 0 })
    expect(capDiff(diff, 400, true).lines.length).toBe(450)
    expect(capDiff('a\nb').hidden).toBe(0)
  })
})

describe('context thresholds', () => {
  it('levels and colours switch at 50 and 80', () => {
    expect([0, 49, 50, 79, 80, 100].map(ctxLevel)).toEqual([0, 0, 1, 1, 2, 2])
    expect(ctxColor(49)).not.toBe(ctxColor(50))
    expect(ctxColor(79)).toBe(ctxColor(50))
    expect(ctxColor(80)).not.toBe(ctxColor(79))
  })
})

describe('new shortcuts', () => {
  const k = { ctrl: false, meta: false, alt: false, typing: false, overlayOpen: false }
  it('N and M route, but not while typing', () => {
    expect(routeKey({ ...k, key: 'n' })).toEqual({ kind: 'new-task' })
    expect(routeKey({ ...k, key: 'M' })).toEqual({ kind: 'mute' })
    expect(routeKey({ ...k, key: 'n', typing: true })).toBeNull()
  })
})

import { cardLive, errorText } from '../src/logic'
describe('live cards and server errors', () => {
  it('only live:false permission/question cards are terminal-only', () => {
    expect(cardLive({ ...perm, live: false })).toBe(false)
    expect(cardLive({ ...perm, live: true })).toBe(true)
    expect(cardLive(perm)).toBe(true)
    expect(cardLive({ kind: 'question', requestId: 'q', questions: [], live: false })).toBe(false)
    expect(cardLive({ kind: 'error', summary: 'x' })).toBe(true)
  })
  it('reads {error}, then {message}, then falls back to the status', () => {
    expect(errorText(409, { error: 'stale' })).toBe('stale')
    expect(errorText(500, { message: 'boom' })).toBe('boom')
    expect(errorText(502, null)).toBe('Request failed (502).')
    expect(errorText(400, { error: 5 })).toBe('Request failed (400).')
  })
})

import { catchupView } from '../src/logic'
describe('catchupView', () => {
  const T = 10 * 60000
  it('empty: only the task, plus the button', () => {
    expect(catchupView(mk('a', { task: 'Do X' }), T)).toEqual({ mode: 'empty', asked: 'Do X', did: null, needs: null, needsFallback: 'Nothing right now. It is working.', written: null })
    expect(catchupView(mk('a'), T).asked).toBeNull()
  })
  it('running wins over a stale catch-up', () => {
    const s = mk('a', { catchupRunning: true, catchup: { asked: 'q', did: 'd', needs: 'n' } })
    expect(catchupView(s, T).mode).toBe('running')
  })
  it('filled: rows and age', () => {
    const s = mk('a', { catchup: { asked: 'q', did: 'd', needs: 'n' }, catchupAt: T - 3 * 60000 })
    expect(catchupView(s, T)).toEqual({ mode: 'filled', asked: 'q', did: 'd', needs: 'n', needsFallback: 'Nothing right now. It is working.', written: 'Written 3 min ago' })
    expect(catchupView({ ...s, catchupAt: T - 1000 }, T).written).toBe('Written just now')
    expect(catchupView({ ...s, catchupAt: null }, T).written).toBeNull()
  })
  it('C routes like the other shortcuts', () => {
    const k = { ctrl: false, meta: false, alt: false, typing: false, overlayOpen: false }
    expect(routeKey({ ...k, key: 'c' })).toEqual({ kind: 'catchup' })
    expect(routeKey({ ...k, key: 'c', typing: true })).toBeNull()
    expect(routeKey({ ...k, key: 'c', ctrl: true })).toBeNull()
  })
})
