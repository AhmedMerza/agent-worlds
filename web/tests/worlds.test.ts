import { describe, expect, it } from 'vitest'
import { applyMessage, newState } from '../src/store'
import { breadcrumbs, cleanPath, visibleEntries } from '../src/fsbrowser'
import { groupSessions, moveId, nextColor, withRepo, PALETTE, routeKey } from '../src/logic'
import { mk } from './helpers'

const w = (id: string, color = '#000') => ({ id, name: id.toUpperCase(), color, repos: [] as string[] })

describe("applyMessage {type:'worlds'}", () => {
  it('replaces the list and regroups sessions without touching them', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds: [w('a')], sessions: [mk('s1', { worldId: 'a' }), mk('s2', { worldId: 'b' })] })
    expect(groupSessions(st.worlds, Object.values(st.sessions)).map((g) => g.world.id)).toEqual(['a', '__unsorted'])
    applyMessage(st, { type: 'worlds', worlds: [w('b'), w('a')] })
    expect(st.worlds.map((x) => x.id)).toEqual(['b', 'a'])
    expect(groupSessions(st.worlds, Object.values(st.sessions)).map((g) => g.world.id)).toEqual(['b', 'a'])
    expect(Object.keys(st.sessions)).toEqual(['s1', 's2'])
  })
  it('deleting every world sends all sessions to Unsorted', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds: [w('a')], sessions: [mk('s1', { worldId: 'a' })] })
    applyMessage(st, { type: 'worlds', worlds: [] })
    expect(st.worlds).toEqual([])
    expect(groupSessions(st.worlds, Object.values(st.sessions)).map((g) => g.world.id)).toEqual(['__unsorted'])
  })
})

describe('folder browser state', () => {
  it('breadcrumbs from the root down', () => {
    expect(breadcrumbs('/home/a/repo')).toEqual([{ name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'a', path: '/home/a' }, { name: 'repo', path: '/home/a/repo' }])
    expect(breadcrumbs('/')).toEqual([{ name: '/', path: '/' }])
  })
  it('cleans typed paths', () => {
    expect(cleanPath('  /a/b/// ')).toBe('/a/b')
    expect(cleanPath('/')).toBe('/')
  })
  it('lists repos first, alphabetical, dot-folders hidden', () => {
    const e = [{ name: 'zeta', path: '/zeta', isRepo: false }, { name: '.cache', path: '/.cache', isRepo: false }, { name: 'beta', path: '/beta', isRepo: true }, { name: 'Alpha', path: '/Alpha', isRepo: false }, { name: 'alpha-repo', path: '/alpha-repo', isRepo: true }]
    expect(visibleEntries(e).map((x) => x.name)).toEqual(['alpha-repo', 'beta', 'Alpha', 'zeta'])
    expect(visibleEntries(e, true).map((x) => x.name)).toContain('.cache')
  })
})

describe('world helpers', () => {
  it('moveId swaps neighbours and stops at the ends', () => {
    expect(moveId(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveId(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moveId(['a', 'b'], 'a', -1)).toEqual(['a', 'b'])
    expect(moveId(['a', 'b'], 'zz', 1)).toEqual(['a', 'b'])
  })
  it('nextColor picks an unused swatch and cycles when full', () => {
    expect(nextColor([])).toBe(PALETTE[0])
    expect(nextColor([w('a', PALETTE[0].toUpperCase())])).toBe(PALETTE[1])
    expect(PALETTE).toContain(nextColor(PALETTE.map((c, i) => w(String(i), c))))
  })
  it('withRepo adds once', () => {
    expect(withRepo(['/a'], '/b')).toEqual(['/a', '/b'])
    expect(withRepo(['/a'], '/a')).toEqual(['/a'])
  })
  it('W routes to the worlds panel but not while typing', () => {
    const k = { ctrl: false, meta: false, alt: false, typing: false, overlayOpen: false }
    expect(routeKey({ ...k, key: 'w' })).toEqual({ kind: 'worlds' })
    expect(routeKey({ ...k, key: 'W', typing: true })).toBeNull()
  })
})
