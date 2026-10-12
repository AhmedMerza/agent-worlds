import { describe, expect, it } from 'vitest'
import { applyMessage, newState, backoffMs } from '../src/store'
import { mk, perm } from './helpers'

const worlds = [{ id: 'web', name: 'Web', color: '#fff', repos: [] }]

describe('applyMessage', () => {
  it('snapshot replaces everything and selects the oldest needing you', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a'), mk('b', { state: 'waiting', card: perm, waitingSince: 1 })] })
    expect(st.loaded).toBe(true)
    expect(st.order).toEqual(['a', 'b'])
    expect(st.selectedId).toBe('b')
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('c')] })
    expect(Object.keys(st.sessions)).toEqual(['c'])
    expect(st.selectedId).toBe('c')
  })
  it('session upserts keep position; new ones append', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a'), mk('b')] })
    applyMessage(st, { type: 'session', session: mk('a', { state: 'idle' }) })
    applyMessage(st, { type: 'session', session: mk('c') })
    expect(st.order).toEqual(['a', 'b', 'c'])
    expect(st.sessions.a.state).toBe('idle')
  })
  it('removal reselects when the selected session goes away', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a'), mk('b')] })
    st.selectedId = 'a'
    applyMessage(st, { type: 'session-removed', id: 'a' })
    expect(st.order).toEqual(['b'])
    expect(st.selectedId).toBe('b')
    applyMessage(st, { type: 'session-removed', id: 'b' })
    expect(st.selectedId).toBeNull()
  })
  it('toast bumps a counter so repeated text still shows', () => {
    const st = newState()
    applyMessage(st, { type: 'toast', text: 'hi' })
    applyMessage(st, { type: 'toast', text: 'hi' })
    expect(st.toast).toEqual({ text: 'hi', n: 2 })
  })
})

describe('backoffMs', () => {
  it('grows and caps', () => {
    expect([0, 1, 2, 10].map(backoffMs)).toEqual([500, 1000, 2000, 15000])
  })
})

describe('applyMessage alerts', () => {
  it('returns the session that just started needing you, only for upserts', () => {
    const st = newState()
    expect(applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a')] })).toBeNull()
    const w = mk('a', { state: 'waiting', card: perm, waitingSince: 1 })
    expect(applyMessage(st, { type: 'session', session: w })?.id).toBe('a')
    expect(applyMessage(st, { type: 'session', session: { ...w, now: 'x' } })).toBeNull()
  })
})

import { claimPending } from '../src/store'
describe('claimPending', () => {
  const s = mk('n', { tmux: { session: 'aw-n', pane: '%1' } })
  it('claims the matching tmux session once, within 60s', () => {
    const st = newState()
    st.pending = { tmux: 'aw-n', until: 1000 }
    expect(claimPending(st, mk('other'), 10)).toBe(false)
    expect(st.pending).not.toBeNull()
    expect(claimPending(st, s, 10)).toBe(true)
    expect(st.pending).toBeNull()
    expect(claimPending(st, s, 10)).toBe(false)
  })
  it('gives up after the deadline', () => {
    const st = newState()
    st.pending = { tmux: 'aw-n', until: 1000 }
    expect(claimPending(st, s, 2000)).toBe(false)
    expect(st.pending).toBeNull()
  })
  it('selects it through the reducer', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a')] })
    st.pending = { tmux: 'aw-n', until: Date.now() + 60000 }
    applyMessage(st, { type: 'session', session: s })
    expect(st.selectedId).toBe('n')
  })
})
