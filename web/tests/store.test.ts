import { describe, expect, it, afterEach, vi } from 'vitest'
import { nextTick } from 'vue'
import { modeField, modeOptions, cardKey } from '../src/logic'
import { applyMessage, keepSelection, moveSession, newState, backoffMs, createSession, resumeSession, terminalOf, continueIn, state, groups, worldOf, runsNeedingYou, runOf, skipped, restartQueued } from '../src/store'
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
  it('an update to one room leaves the other rooms\' groups as they were, so they do not redraw', () => {
    const two = [...worlds, { id: 'app', name: 'App', color: '#000', repos: [] }]
    applyMessage(state, { type: 'snapshot', worlds: two, sessions: [mk('a', { worldId: 'web' }), mk('b', { worldId: 'app' })] })
    const [web, app] = groups.value
    applyMessage(state, { type: 'session', session: mk('a', { worldId: 'web', state: 'idle' }) })
    expect(groups.value[1]).toBe(app)
    expect(groups.value[0]).not.toBe(web)
    expect(groups.value[0].sessions[0].state).toBe('idle')
    expect(worldOf({ id: 'b' })?.id).toBe('app')
    applyMessage(state, { type: 'snapshot', worlds, sessions: [] })
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
  it('tracks interrupted sessions and removes one when its live session returns', () => {
    const st = newState()
    const interrupted = { id: 'session-one', agent: 'codex' as const, cwd: '/r', task: 'fix it', lastPrompt: null, updatedAt: 1 }
    applyMessage(st, { type: 'snapshot', worlds, sessions: [], recoverable: [interrupted] })
    expect(st.recoverable).toEqual([interrupted])
    applyMessage(st, { type: 'session', session: mk('session-one', { agent: 'codex' }) })
    expect(st.recoverable).toEqual([])
    applyMessage(st, { type: 'recoverable', sessions: [interrupted] })
    expect(st.recoverable).toEqual([interrupted])
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

describe('queued restarts', () => {
  afterEach(() => { restartQueued.clear(); vi.unstubAllGlobals() })
  it('restarts each ready session once when several finish together', async () => {
    const fn = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
    vi.stubGlobal('fetch', fn)
    applyMessage(state, { type: 'snapshot', worlds, sessions: [mk('a', { state: 'done' }), mk('b', { state: 'done' })] })
    restartQueued.add('a'); restartQueued.add('b')
    await nextTick(); await Promise.resolve(); await nextTick(); await Promise.resolve()
    expect(fn.mock.calls.map(([url]) => url).sort()).toEqual(['/api/sessions/a/restart', '/api/sessions/b/restart'])
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

describe('skipped', () => {
  it("lasts while that card waits; once it is answered, the session's next card of the same kind is offered again", async () => {
    const done = (id: string) => mk(id, { state: 'done', card: { kind: 'done', summary: 'x' }, waitingSince: 1 })
    applyMessage(state, { type: 'snapshot', worlds: [], sessions: [done('d1')] })
    skipped.add(cardKey(state.sessions.d1))
    await nextTick()
    expect(skipped.has('d1:done')).toBe(true) // still waiting: stays skipped
    applyMessage(state, { type: 'session', session: mk('d1', { state: 'idle' }) })
    await nextTick()
    expect(skipped.has('d1:done')).toBe(false) // answered: forgotten, so its next 'done' is offered
  })
})

describe('saveSpawnAgents', () => {
  afterEach(() => vi.unstubAllGlobals())
  /** A server that answers each POST after `ms` and records how many were in flight at once. */
  function server(answer: (body: any, n: number) => { status: number; json: unknown }, ms = 20) {
    const seen: any[] = []; let inFlight = 0, most = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body); seen.push(body)
      most = Math.max(most, ++inFlight)
      await new Promise((r) => setTimeout(r, seen.length === 1 ? ms * 3 : ms)) // the first is the slowest
      inFlight--
      const a = answer(body, seen.length)
      return { ok: a.status < 300, status: a.status, json: async () => a.json }
    }))
    return { seen, most: () => most }
  }
  it('quick changes go one at a time, in order, each built on the one before', async () => {
    const { saveSpawnAgents, spawnRules, loadSpawnRules } = await import('../src/store')
    const { spawnWith } = await import('../src/logic')
    const s = server((b) => ({ status: 200, json: { spawn: b.spawn } }))
    loadSpawnRules(null)
    const ids = ['claude', 'qwen', 'kimi']
    const a = saveSpawnAgents(spawnWith(spawnRules.value, ids, 'qwen', null))
    const b = saveSpawnAgents(spawnWith(spawnRules.value, ids, 'kimi', null))
    await Promise.all([a, b])
    expect(s.most(), 'never two saves at once').toBe(1)
    expect(s.seen.map((x) => x.spawn)).toEqual([{ claude: [], kimi: [] }, { claude: [] }])
    expect(s.seen.map((x) => x.base), 'each names the rules it was built on').toEqual([null, { claude: [], kimi: [] }])
    expect(spawnRules.value).toEqual({ claude: [] })
  })
  it('a failed save puts back the last saved rules, not a newer change still on its way', async () => {
    const { saveSpawnAgents, spawnRules, loadSpawnRules } = await import('../src/store')
    server((b, n) => (n === 1 ? { status: 500, json: { error: 'disk full' } } : { status: 200, json: { spawn: b.spawn } }))
    loadSpawnRules({ claude: [] })
    const a = saveSpawnAgents({})
    const b = saveSpawnAgents({ codex: [] })
    expect((await a).ok).toBe(false)
    expect(spawnRules.value, 'the newer change stays while it is saving').toEqual({ codex: [] })
    expect((await b).ok).toBe(true)
    expect(spawnRules.value).toEqual({ codex: [] })
  })
  it('two failures in a row end on the last saved rules, not the first unsaved one', async () => {
    const { saveSpawnAgents, spawnRules, loadSpawnRules } = await import('../src/store')
    server(() => ({ status: 500, json: { error: 'disk full' } }))
    loadSpawnRules({ claude: [] })
    await Promise.all([saveSpawnAgents({}), saveSpawnAgents({ codex: [] })])
    expect(spawnRules.value).toEqual({ claude: [] })
  })
  it('rules changed in another window: the server\'s are shown, and the refused change is not kept', async () => {
    const { saveSpawnAgents, spawnRules, spawnFailures, loadSpawnRules } = await import('../src/store')
    server(() => ({ status: 409, json: { error: 'changed in another window', spawn: { codex: [] } } }))
    loadSpawnRules(null)
    const failures = spawnFailures.value
    const res = await saveSpawnAgents({ claude: [] })
    expect(res.ok).toBe(false)
    expect(spawnRules.value).toEqual({ codex: [] })
    expect(spawnFailures.value, 'inputs showing the refused text are redrawn').toBe(failures + 1)
  })
  /** A server that keeps the rules like the real one: refuses a stale base (409), dedupes models, can fail once. */
  function realish(start: Record<string, string[]> | null, failFirst = false) {
    let saved = start, n = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body); n++
      await new Promise((r) => setTimeout(r, 10))
      const reply = (status: number, json: unknown) => ({ ok: status < 300, status, json: async () => json })
      if (JSON.stringify(b.base) !== JSON.stringify(saved)) return reply(409, { error: 'changed in another window', spawn: saved })
      if (failFirst && n === 1) return reply(500, { error: 'disk full' })
      saved = b.spawn && Object.fromEntries(Object.entries(b.spawn as Record<string, string[]>).map(([k, v]) => [k, [...new Set(v)]]))
      return reply(200, { spawn: saved })
    }))
    return () => saved
  }
  it('a save queued behind one that failed still lands, and is not blamed on another window', async () => {
    const { saveSpawnAgents, spawnRules, loadSpawnRules } = await import('../src/store')
    const onServer = realish({ claude: [] }, true)
    loadSpawnRules({ claude: [] })
    const a = saveSpawnAgents({})
    const b = saveSpawnAgents({ codex: [] })
    expect((await a).ok).toBe(false)
    expect(await b).toEqual({ ok: true, data: { spawn: { codex: [] } } })
    expect(onServer()).toEqual({ codex: [] })
    expect(spawnRules.value).toEqual({ codex: [] })
  })
  it('the server\'s own copy is what the next save is built on (a model typed twice)', async () => {
    const { saveSpawnAgents, spawnRules, loadSpawnRules } = await import('../src/store')
    const onServer = realish(null)
    loadSpawnRules(null)
    expect((await saveSpawnAgents({ claude: ['haiku', 'haiku'] })).ok).toBe(true)
    expect(spawnRules.value).toEqual({ claude: ['haiku'] })
    expect((await saveSpawnAgents({ claude: ['haiku'], codex: [] })).ok, 'not refused as changed elsewhere').toBe(true)
    expect(onServer()).toEqual({ claude: ['haiku'], codex: [] })
  })
  it('opening the panel while a save is on its way does not overwrite it with older rules', async () => {
    const { saveSpawnAgents, spawnRules, loadSpawnRules } = await import('../src/store')
    server((b) => ({ status: 200, json: { spawn: b.spawn } }))
    loadSpawnRules(null)
    const a = saveSpawnAgents({ codex: [] })
    loadSpawnRules(null) // a fetch that left before the save landed
    expect(spawnRules.value).toEqual({ codex: [] })
    await a
  })
})
