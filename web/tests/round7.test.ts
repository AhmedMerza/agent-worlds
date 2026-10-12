import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMessage, newState, createSession, resumeSession, moveRepo, state } from '../src/store'
import {
  catchupView, drawnSessions, ghostChipText, ghostSession, groupSessions, inboxOrder, meaningful, modeField, modeOptions, needSplit, nextNeedingYou,
  nowText, queue, reviewView, screenOrder, startsNeedingYou, cardLive,
} from '../src/logic'
import { moveRepoPatches, repoStatus } from '../src/fsbrowser'
import { pauseWalker, walkPos } from '../src/zones'
import type { Review, Unmanaged } from '../src/types'
import { mk } from './helpers'

const rev = (over: Partial<Review> = {}): Review => ({ baseSha: 'abc', files: [], commits: [], uncommitted: [], diff: '', tests: null, ...over })
const f = (path: string) => ({ path, added: 1, deleted: 0 })
const asking = { kind: 'asking', summary: 'Same change for the invoices?' } as const
const doneCard = { kind: 'done', summary: null } as const
const permCard = { kind: 'permission', requestId: 'r', tool: 'Bash', command: 'ls', input: {}, risky: null, seenCount: 0 } as const

describe('review block', () => {
  it('Commit only when something is uncommitted', () => {
    expect(reviewView(rev({ files: [f('a')], uncommitted: [f('a')] })).canCommit).toBe(true)
    expect(reviewView(rev({ files: [f('a')], commits: [{ sha: '1', subject: 's' }] })).canCommit).toBe(false)
  })
  it('Open MR only when commits exist', () => {
    expect(reviewView(rev({ commits: [{ sha: '1', subject: 's' }] })).canMr).toBe(true)
    expect(reviewView(rev({ uncommitted: [f('a')] })).canMr).toBe(false)
  })
  it('tolerates a server that omits the new lists', () => {
    const v = reviewView({ files: [f('a')], diff: '', tests: null } as unknown as Review)
    expect(v).toMatchObject({ commits: [], uncommitted: [], canCommit: false, canMr: false })
  })
})

describe('ghosts', () => {
  const u = (pid: number): Unmanaged => ({ pid, cwd: `/x/${pid}`, repo: null, worldId: null, sessionId: null, inTmux: false, since: 1 })
  const worlds = [{ id: 'web', name: 'Web', color: '#fff', repos: [] }]
  it('get no 1-9 number', () => {
    const groups = groupSessions(worlds, [mk('a'), ghostSession(u(1)), mk('b'), ghostSession(u(2))])
    expect(screenOrder(groups).map((s) => s.id)).toEqual(['a', 'b'])
  })
  it('the scene draws at most 6 ghosts and reports the rest', () => {
    const list = [mk('a'), ...Array.from({ length: 10 }, (_, i) => ghostSession(u(i)))]
    const d = drawnSessions(list)
    expect(d.sessions.filter((s) => s.ghost)).toHaveLength(6)
    expect(d.sessions.filter((s) => !s.ghost)).toHaveLength(1)
    expect(d.hidden).toBe(4)
    expect(drawnSessions([mk('a')]).hidden).toBe(0)
  })
  it('chip text counts them', () => {
    expect(ghostChipText(1)).toBe('1 other Claude session on this computer')
    expect(ghostChipText(9)).toBe('9 other Claude sessions on this computer')
  })
})

describe('asking card', () => {
  it('needs you, ranks with questions after permissions, and is answerable in the GUI', () => {
    const q = queue([mk('d', { state: 'done', card: doneCard, waitingSince: 1 }), mk('k', { state: 'waiting', card: asking, waitingSince: 5 }), mk('p', { state: 'waiting', card: permCard, waitingSince: 9 })])
    expect(q.map((s) => s.id)).toEqual(['p', 'k', 'd'])
    expect(cardLive(asking)).toBe(true)
  })
  it('alerts when a session starts asking', () => {
    expect(startsNeedingYou(mk('k', { state: 'working' }), mk('k', { state: 'waiting', card: asking }))).toBe(true)
  })
})

describe('header split', () => {
  it('waiting = permission, question, asking; review = done, error', () => {
    const q = [permCard, asking, { kind: 'question', requestId: 'q', questions: [] }, doneCard, { kind: 'error', summary: 'x' }].map((card, i) =>
      mk('s' + i, { state: card.kind === 'done' ? 'done' : card.kind === 'error' ? 'error' : 'waiting', card: card as never }))
    expect(needSplit(q)).toEqual({ waiting: 3, review: 2 })
  })
})

describe('catch-up needs', () => {
  const base = { catchup: { asked: 'a', did: 'd', needs: '' }, catchupAt: 0 }
  it('treats empty and none as nothing, so the state fallback shows', () => {
    for (const n of ['', 'none', 'None.', 'Nothing', 'n/a', '  ']) {
      const v = catchupView(mk('a', { ...base, catchup: { asked: 'a', did: 'd', needs: n }, state: 'done' }), 0)
      expect(v.needs, n).toBeNull()
      expect(v.needsFallback).toBe('Your review')
    }
    expect(meaningful('Your OK to migrate')).toBe('Your OK to migrate')
    expect(meaningful('Nothing but the tests failing')).not.toBeNull()
  })
  it('stale catch-up uses the fallback and says so', () => {
    const v = catchupView(mk('a', { ...base, catchup: { asked: 'a', did: 'd', needs: 'Something old' }, catchupStale: true, state: 'waiting' }), 0)
    expect(v).toMatchObject({ stale: true, needs: null, needsFallback: 'Your answer (see the inbox)' })
    expect(catchupView(mk('a', { ...base, catchup: { asked: 'a', did: 'd', needs: 'Fresh' } }), 0)).toMatchObject({ stale: false, needs: 'Fresh' })
  })
})

describe('Space picks the head the app auto-selected', () => {
  const worlds = [{ id: 'web', name: 'Web', color: '#fff', repos: [] }]
  it('first Space selects queue[0] after an auto-selection, then moves on', () => {
    const q = [mk('a', { state: 'done', card: doneCard, waitingSince: 1 }), mk('b', { state: 'done', card: doneCard, waitingSince: 2 })]
    expect(nextNeedingYou(q, 'a', true)?.id).toBe('a')
    expect(nextNeedingYou(q, 'a', false)?.id).toBe('b')
  })
  it('the store marks auto-selection and a click clears it', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds, sessions: [mk('a', { state: 'done', card: doneCard, waitingSince: 1 })] })
    expect(st.autoSelected).toBe(true)
    expect(st.selectedId).toBe('a')
    applyMessage(st, { type: 'snapshot', worlds, sessions: [] })
    expect(st.autoSelected).toBe(false)
  })
})

describe('inbox order', () => {
  it('follows the queue when not hovered', () => expect(inboxOrder(['a', 'b'], ['b', 'a', 'c'], false)).toEqual(['b', 'a', 'c']))
  it('holds places while hovered: gone drop, new go last', () => {
    expect(inboxOrder(['a', 'b', 'c'], ['d', 'c', 'a'], true)).toEqual(['a', 'c', 'd'])
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
    expect(sent(fn)).toEqual({ sessionId: 's1', force: true, permissionMode: 'plan' })
  })
})

describe('folder picker owners', () => {
  const worlds = [{ id: 'a', name: 'Alpha', color: '#1', repos: ['/r/one', '/r/two'] }, { id: 'b', name: 'Beta', color: '#2', repos: ['/r/three'] }]
  it('reports free, added and owned elsewhere', () => {
    expect(repoStatus('/r/new', 'a', worlds)).toEqual({ kind: 'free' })
    expect(repoStatus('/r/one', 'a', worlds)).toEqual({ kind: 'added' })
    expect(repoStatus('/r/three', 'a', worlds)).toEqual({ kind: 'elsewhere', worldId: 'b', worldName: 'Beta' })
  })
  it('a move removes from the old world, then adds to the new one', () => {
    expect(moveRepoPatches(worlds, '/r/three', 'b', 'a')).toEqual([{ id: 'b', repos: [] }, { id: 'a', repos: ['/r/one', '/r/two', '/r/three'] }])
    expect(moveRepoPatches(worlds, '/r/three', 'x', 'a')).toEqual([])
  })
  it('moveRepo patches both worlds in order and restores the old one if the add fails', async () => {
    state.worlds = worlds
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      calls.push(`${url} ${init.body}`)
      const ok = calls.length !== 2
      return { ok, status: ok ? 200 : 400, json: async () => (ok ? {} : { error: 'nope' }) }
    }))
    expect(await moveRepo('/r/three', 'b', 'a')).toBe('nope')
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain('/api/worlds/b')
    expect(calls[1]).toContain('/api/worlds/a')
    expect(calls[2]).toBe('/api/worlds/b {"repos":["/r/three"]}')
    vi.unstubAllGlobals()
  })
})

describe('plain wording', () => {
  it('turns bare tool names into verbs and leaves real sentences alone', () => {
    expect(nowText('AskUserQuestion')).toBe('Asking you a question')
    expect(nowText('Bash')).toBe('Running a command')
    expect(nowText('Using Edit…')).toBe('Editing files')
    expect(nowText('Write')).toBe('Editing files')
    expect(nowText('Grep')).toBe('Reading files')
    expect(nowText('Task')).toBe('Working with helpers')
    expect(nowText('Write the migration')).toBe('Write the migration')
    expect(nowText('Editing the orders table')).toBe('Editing the orders table')
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
