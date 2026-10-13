import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ageText, catchupView, defaultWorld, deleteWorldText, filterHistory, fmtWait, ghostId, ghostSession, groupSessions,
  isLeaveTerminalKey, needsFallback, permissionAsk, permissionDetail, resumeOutcome, routeKey, queue,
} from '../src/logic'
import { applyMessage, newState, resumeSession, state } from '../src/store'
import type { HistorySession, Unmanaged, World } from '../src/types'
import { mk, perm } from './helpers'

const worlds: World[] = [{ id: 'web', name: 'Web', color: '#fff', repos: [] }, { id: 'mobile', name: 'Mobile', color: '#000', repos: [] }]
const u: Unmanaged = { pid: 42, cwd: '/w/repo-a/sub', repo: '/w/repo-a', worldId: 'web', sessionId: 's1', inTmux: false, since: 5 }

describe('ghosts', () => {
  it('maps an unmanaged process to an idle lounge stand-in with a stable id', () => {
    const g = ghostSession(u)
    expect(g).toMatchObject({ id: ghostId(42), repoName: 'repo-a', worldId: 'web', state: 'idle', tmux: null, card: null })
    expect(g.ghost).toBe(u)
  })
  it('lands in its world room, or Unsorted without a world, and never needs you', () => {
    const gs = [ghostSession(u), ghostSession({ ...u, pid: 43, worldId: null, repo: null })]
    const rooms = groupSessions(worlds, gs)
    expect(rooms.map((r) => [r.world.id, r.sessions.length])).toEqual([['web', 1], ['mobile', 0], ['__unsorted', 1]])
    expect(queue(gs)).toEqual([])
  })
  it('snapshot and unmanaged messages fill the list; a vanished ghost deselects', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a')], unmanaged: [u] })
    expect(st.unmanaged).toEqual([u])
    st.selectedId = ghostId(42)
    applyMessage(st, { type: 'unmanaged', unmanaged: [u] })
    expect(st.selectedId).toBe(ghostId(42))
    applyMessage(st, { type: 'unmanaged', unmanaged: [] })
    expect(st.selectedId).toBe('a')
    applyMessage(st, { type: 'snapshot', worlds, sessions: [] })
    expect(st.unmanaged).toEqual([])
  })
})

describe('starting placeholder', () => {
  it('keeps following the session that replaces the placeholder', () => {
    const st = newState()
    const ph = mk('starting:aw-x', { state: 'starting', tmux: { session: 'aw-x', pane: '%1' } })
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a'), ph] })
    st.selectedId = ph.id
    applyMessage(st, { type: 'session-removed', id: ph.id })
    applyMessage(st, { type: 'session', session: mk('real', { tmux: { session: 'aw-x', pane: '%1' } }) })
    expect(st.selectedId).toBe('real')
  })
  it('has no inbox card and a label', () => {
    expect(queue([mk('s', { state: 'starting' })])).toEqual([])
    expect(needsFallback('starting')).toMatch(/starting/)
  })
})

describe('filterHistory', () => {
  const h = (id: string, repo: string, lastPrompt: string): HistorySession => ({ sessionId: id, cwd: repo, repo, worldId: null, lastPrompt, lastActivity: 0, running: false, managed: false })
  const list = [h('aaa', '/w/repo-a', 'Fix the checkout form'), h('bbb', '/w/repo-b', 'Add dark mode'), h('ccc', '/w/repo-c', null as unknown as string)]
  it('matches every word against repo, prompt or id, ignoring case', () => {
    expect(filterHistory(list, '').length).toBe(3)
    expect(filterHistory(list, 'CHECKOUT').map((x) => x.sessionId)).toEqual(['aaa'])
    expect(filterHistory(list, 'repo-b dark').map((x) => x.sessionId)).toEqual(['bbb'])
    expect(filterHistory(list, 'repo-a dark')).toEqual([])
    expect(filterHistory(list, 'ccc').length).toBe(1)
  })
  it('writes ages', () => {
    expect([30e3, 5 * 60e3, 3 * 3600e3, 72 * 3600e3].map((d) => ageText(0, d))).toEqual(['just now', '5 min ago', '3 h ago', '3 days ago'])
  })
})

describe('resume 409 then force', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('reads the outcomes', () => {
    expect(resumeOutcome(201, { tmuxSession: 'aw-x' })).toEqual({ kind: 'ok', tmuxSession: 'aw-x' })
    expect(resumeOutcome(409, { error: 'x', pid: 7 })).toEqual({ kind: 'running', pid: 7 })
    expect(resumeOutcome(409, { error: 'x', pid: null })).toEqual({ kind: 'running', pid: null })
    expect(resumeOutcome(422, { error: 'folder gone' })).toEqual({ kind: 'error', message: 'folder gone' })
  })
  it('asks without stop first; with stop the second call succeeds and selects the new session', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: { body: string }) => {
      const body = JSON.parse(init.body); calls.push(body)
      return body.stop ? { status: 201, ok: true, json: async () => ({ tmuxSession: 'aw-r' }) } : { status: 409, ok: false, json: async () => ({ error: 'still running', pid: 9 }) }
    }))
    expect(await resumeSession('s1')).toEqual({ kind: 'running', pid: 9 })
    expect(state.pending).toBeNull()
    expect(await resumeSession('s1', true)).toEqual({ kind: 'ok', tmuxSession: 'aw-r' })
    expect(calls).toEqual([{ sessionId: 's1' }, { sessionId: 's1', stop: true }])
    expect(state.pending?.tmux).toBe('aw-r')
  })
})

describe('permission wording', () => {
  const p = (target: unknown, over = {}) => ({ ...perm, target, ...over }) as never
  it('follows the target type', () => {
    expect(permissionAsk(p({ type: 'command', value: 'ls' }))).toBe('Run this command?')
    expect(permissionAsk(p({ type: 'file', value: '/a/b.ts' }))).toBe('Edit this file?')
    expect(permissionAsk(p({ type: 'url', value: 'https://x' }))).toBe('Open this address?')
    expect(permissionAsk(p({ type: 'other', value: 'TODO' }, { tool: 'Grep' }))).toBe('Allow Grep?')
  })
  it('falls back to the old rule without a target, and shows the path for files', () => {
    expect(permissionAsk(p(undefined))).toBe('Run this command?')
    expect(permissionAsk(p(undefined, { command: null, tool: 'Edit' }))).toBe('Allow Edit?')
    expect(permissionDetail(p({ type: 'file', value: '/a/b.ts' }))).toBe('/a/b.ts')
    expect(permissionDetail(p(undefined))).toBe('ls')
  })
})

describe('defaultWorld (N key)', () => {
  const one = [worlds[0]]
  it('prefers explicit, filter, selected, then the only world, else asks', () => {
    expect(defaultWorld(worlds, { explicit: 'mobile', selectedWorldId: 'web', filter: 'all' })).toEqual({ kind: 'world', id: 'mobile' })
    expect(defaultWorld(worlds, { selectedWorldId: 'web', filter: 'mobile' })).toEqual({ kind: 'world', id: 'mobile' })
    expect(defaultWorld(worlds, { selectedWorldId: 'web', filter: 'all' })).toEqual({ kind: 'world', id: 'web' })
    expect(defaultWorld(worlds, { selectedWorldId: '__unsorted', filter: 'mobile' })).toEqual({ kind: 'world', id: 'mobile' })
    expect(defaultWorld(one, { selectedWorldId: null, filter: 'all' })).toEqual({ kind: 'world', id: 'web' })
    expect(defaultWorld(worlds, { filter: 'all' })).toEqual({ kind: 'pick' })
    expect(defaultWorld([], { filter: 'all' })).toEqual({ kind: 'none' })
  })
})

describe('catch-up fallback and wait wording', () => {
  it('names what each state needs', () => {
    expect(needsFallback('done')).toBe('Your review')
    expect(needsFallback('idle')).toBe('A new task')
    expect(needsFallback('working')).toBe('Nothing right now. It is working.')
    expect(catchupView(mk('a', { state: 'done', catchup: { asked: 'q', did: 'd', needs: '' }, catchupAt: 0 }), 0).needsFallback).toBe('Your review')
  })
  it('done and error cards say finished', () => {
    expect(fmtWait(0, 'waiting')).toBe('waiting <1 min')
    expect(fmtWait(4, 'waiting')).toBe('waiting 4 min')
    expect(fmtWait(4, 'done')).toBe('finished 4 min ago')
    expect(fmtWait(0, 'error')).toBe('finished just now')
  })
})

describe('worlds panel text', () => {
  it('agrees in number', () => {
    expect(deleteWorldText('Web', 1)).toContain('Its 1 session moves to Unsorted and keeps running')
    expect(deleteWorldText('Web', 3)).toContain('Its 3 sessions move to Unsorted and keep running')
    expect(deleteWorldText('Web', 0)).toContain('no sessions')
  })
})

describe('keys', () => {
  const k = { ctrl: false, meta: false, alt: false, typing: false, overlayOpen: false }
  it('Ctrl+] leaves the terminal even while typing in it; Esc does not', () => {
    expect(routeKey({ ...k, key: ']', ctrl: true, typing: true })).toEqual({ kind: 'leave-terminal' })
    expect(routeKey({ ...k, key: ']', typing: true })).toBeNull()
    expect(routeKey({ ...k, key: 'Escape', typing: true })).toBeNull()
    expect(isLeaveTerminalKey({ key: ']', ctrlKey: true, metaKey: false, altKey: false })).toBe(true)
    expect(isLeaveTerminalKey({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false })).toBe(false)
  })
  it('R opens recent sessions, but not while typing', () => {
    expect(routeKey({ ...k, key: 'r' })).toEqual({ kind: 'recent' })
    expect(routeKey({ ...k, key: 'R', typing: true })).toBeNull()
  })
})
