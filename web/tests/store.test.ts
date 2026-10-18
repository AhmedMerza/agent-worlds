import { describe, expect, it, afterEach, vi } from 'vitest'
import { modeField, modeOptions } from '../src/logic'
import { applyMessage, keepSelection, moveSession, newState, backoffMs, createSession, resumeSession, terminalOf, continueIn, state, runsNeedingYou, runOf } from '../src/store'
import type { Run } from '../src/types'
import { mk, perm } from './helpers'

const worlds = [{ id: 'web', name: 'Web', color: '#fff', repos: [] }]

describe('applyMessage', () => {
  it('runs: the snapshot and run messages keep them; the ones held for you and a session\'s step are found', () => {
    const run = (id: string, status: Run['status'], sessionId: string | null): Run => ({ id, task: 't', worldId: 'web', repo: '/r', dir: '/r', current: 0, status, note: null, startedAt: 1,
      steps: [{ kind: 'plan', agent: 'claude', checkpoint: true, status: 'handed', sessionId, summary: 's' }, { kind: 'build', agent: 'codex', checkpoint: false, status: 'pending', sessionId: null, summary: null }] })
    applyMessage(state, { type: 'snapshot', worlds, sessions: [], runs: [run('r1', 'running', 'sa')] })
    expect(runsNeedingYou.value).toEqual([])
    applyMessage(state, { type: 'run', run: run('r1', 'waiting', 'sa') })
    applyMessage(state, { type: 'run', run: run('r2', 'done', 'sb') })
    expect(runsNeedingYou.value.map((r) => r.id)).toEqual(['r1'])
    expect(runOf({ id: 'sa', tmux: null } as never)).toMatchObject({ run: { id: 'r1' }, step: 0 })
    expect(runOf({ id: 'nobody', tmux: null } as never)).toBeNull()
    applyMessage(state, { type: 'snapshot', worlds, sessions: [] })
    expect(state.runs).toEqual({})
  })
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
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a', { tmux: null }), mk('b', { tmux: null })] })
    st.selectedId = 'a'
    applyMessage(st, { type: 'session-removed', id: 'a' })
    expect(st.order).toEqual(['b'])
    expect(st.selectedId).toBe('b')
    applyMessage(st, { type: 'session-removed', id: 'b' })
    expect(st.selectedId).toBeNull()
  })
  it('/clear in the selected terminal: follows its new session, never jumps to another terminal', () => {
    const st = newState()
    const term = { session: 'aw-oreem', pane: '%7' }
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('old', { tmux: term }), mk('other', { state: 'waiting', card: { kind: 'asking', summary: 'x?' } })] })
    st.selectedId = 'old'
    applyMessage(st, { type: 'session-removed', id: 'old' })
    expect(st.selectedId).toBe('old')
    applyMessage(st, { type: 'session', session: mk('other', { state: 'working' }) })
    expect(st.selectedId).toBe('old')
    applyMessage(st, { type: 'session', session: mk('new', { tmux: term }) })
    expect(st.selectedId).toBe('new')
    expect(st.pending).toBeNull()
  })
  it('/clear keeps the terminal panel on the same tmux session the whole way through (no teardown, no lost focus)', () => {
    const st = newState()
    const term = { session: 'aw-oreem', pane: '%7' }
    const shown = () => terminalOf(st, st.selectedId ? st.sessions[st.selectedId] ?? null : null)
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('old', { tmux: term }), mk('other', { tmux: { session: 'aw-x', pane: '%1' } })] })
    st.selectedId = 'old'
    expect(shown()).toBe('aw-oreem')
    applyMessage(st, { type: 'session-removed', id: 'old' })
    expect(shown()).toBe('aw-oreem')
    applyMessage(st, { type: 'session', session: mk('new', { tmux: term }) })
    expect(shown()).toBe('aw-oreem')
    keepSelection(st, Date.now() + 60000)
    st.selectedId = 'other'
    expect(shown()).toBe('aw-x')
  })
  it('the selected terminal gets no new session: another is selected once the wait is over', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('old', { tmux: { session: 'aw-x', pane: '%7' } }), mk('b', { tmux: null })] })
    st.selectedId = 'old'
    applyMessage(st, { type: 'session-removed', id: 'old' })
    expect(st.selectedId).toBe('old')
    keepSelection(st, st.pending!.until + 1)
    expect(st.selectedId).toBe('b')
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

describe('permission mode', () => {
  afterEach(() => vi.unstubAllGlobals())
  const stub = () => { const fn = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ tmuxSession: 'aw-x' }) })); vi.stubGlobal('fetch', fn); return fn }
  const sent = (fn: ReturnType<typeof stub>) => JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body)
  it('"Your Claude default" sends no field; the others send their mode', () => {
    expect(modeField('claude')).toEqual({})
    expect(modeField('plan')).toEqual({ permissionMode: 'plan' })
    expect(modeOptions('acceptEdits')[0].label).toBe('Your Claude default (auto-accept edits)')
    expect(modeOptions(null)[0].label).toBe('Your Claude default (not set)')
    expect(modeOptions(null).map((o) => o.value)).toEqual(['claude', 'default', 'acceptEdits', 'plan', 'auto'])
  })
  it('New session and Resume put permissionMode in the body only when chosen', async () => {
    let fn = stub()
    await createSession({ worldId: 'w', repo: '/r', task: '', worktree: true, ...modeField('claude') })
    expect(sent(fn)).not.toHaveProperty('permissionMode')
    fn = stub()
    await createSession({ worldId: 'w', repo: '/r', task: '', worktree: true, ...modeField('acceptEdits') })
    expect(sent(fn).permissionMode).toBe('acceptEdits')
    fn = stub()
    await resumeSession('s1', false, undefined)
    expect(sent(fn)).toEqual({ sessionId: 's1' })
    fn = stub()
    await resumeSession('s1', true, 'plan')
    expect(sent(fn)).toEqual({ sessionId: 's1', stop: true, permissionMode: 'plan' })
  })
})

describe('moveSession', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('posts the world for that one session', async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fn)
    expect((await moveSession('sess 1', 'pos')).ok).toBe(true)
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sessions/sess%201/world')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ worldId: 'pos' })
  })
})

describe('continueIn', () => {
  afterEach(() => { vi.unstubAllGlobals(); state.pending = null })
  it('posts the target agent and follows the new tmux session; errors come back as text', async () => {
    const fn = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ tmuxSession: 'aw-cont', handoff: '/h/handoffs/sess-1.md' }) }))
    vi.stubGlobal('fetch', fn)
    expect(await continueIn('sess 1', 'codex')).toBeNull()
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sessions/sess%201/continue')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ agent: 'codex' })
    expect(state.pending?.tmux).toBe('aw-cont')

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ error: 'this session already runs Codex' }) })))
    expect(await continueIn('sess-1', 'codex')).toBe('this session already runs Codex')
  })
})

describe('fetchAgents cache', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  const fresh = async () => (await import('../src/store')).fetchAgents
  it('asks the server once per page, but retries after a failure', async () => {
    const payload = { agents: [{ id: 'claude', name: 'Claude Code', installed: true, modes: true }], default: 'claude' }
    const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }))
    vi.stubGlobal('fetch', fn)
    let fetchAgents = await fresh()
    expect((await fetchAgents()).ok).toBe(true)
    expect((await fetchAgents()).ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(1)

    vi.resetModules()
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
      : { ok: true, status: 200, json: async () => payload })))
    fetchAgents = await fresh()
    expect((await fetchAgents()).ok).toBe(false)
    expect((await fetchAgents()).ok).toBe(true)
    expect(n).toBe(2)
  })
})
