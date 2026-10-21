import { describe, expect, it } from 'vitest'
import type { Review, Unmanaged } from '../src/types'
import { applyMessage, newState } from '../src/store'
import { queue, tiredLevel, routeKey, groupSessions, nextNeedingYou, waitMinutes, buildAnswers, type KeyInfo, drawnSessions, ghostChipText, ghostSession, inboxOrder, meaningful, needSplit, nowText, stateLabel, groupByFolder, dropTarget, reviewView, screenOrder, agentName, otherAgents, openHttp, permissionAsk, permissionDetail, permissionWho } from '../src/logic'
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
  it('T or Enter goes to the terminal; Enter on a focused button stays the button\'s', () => {
    expect(routeKey({ ...base, key: 't' })).toEqual({ kind: 'terminal' })
    expect(routeKey({ ...base, key: 'Enter' })).toEqual({ kind: 'terminal' })
    expect(routeKey({ ...base, key: 'Enter', onControl: true })).toBeNull()
    expect(routeKey({ ...base, key: 't', typing: true })).toBeNull()
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
  it('follows the server when it refuses Everywhere', () => {
    expect(scopeAvailability({ ...perm, everywhere: 'Not offered for shell commands.' })).toMatchObject({ all: false, allReason: 'Not offered for shell commands.' })
    expect(scopeAvailability({ ...perm, risky: 'pushes to a remote', everywhere: null }).all).toBe(true)
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
    expect(catchupView(mk('a', { task: 'Do X' }), T)).toEqual({ mode: 'empty', asked: 'Do X', did: null, needs: null, needsFallback: 'Nothing right now. It is working.', stale: false, written: null })
    expect(catchupView(mk('a'), T).asked).toBeNull()
  })
  it('running wins over a stale catch-up', () => {
    const s = mk('a', { catchupRunning: true, catchup: { asked: 'q', did: 'd', needs: 'n' } })
    expect(catchupView(s, T).mode).toBe('running')
  })
  it('filled: rows and age', () => {
    const s = mk('a', { catchup: { asked: 'q', did: 'd', needs: 'n' }, catchupAt: T - 3 * 60000 })
    expect(catchupView(s, T)).toEqual({ mode: 'filled', asked: 'q', did: 'd', needs: 'n', needsFallback: 'Nothing right now. It is working.', stale: false, written: 'Written 3 min ago' })
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

describe('deviceText', () => {
  it('names browser and system from a user agent', async () => {
    const { deviceText } = await import('../src/logic')
    expect(deviceText('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36')).toBe('Chrome on Android')
    expect(deviceText('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone')
    expect(deviceText('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe('Edge on Windows')
    expect(deviceText('')).toBe('Unknown device')
    expect(deviceText('curl/8.4')).toBe('curl/8.4')
  })
})

const rev = (over: Partial<Review> = {}): Review => ({ baseSha: 'abc', files: [], commits: [], uncommitted: [], diff: '', tests: null, ...over })
const f = (path: string) => ({ path, added: 1, deleted: 0 })
const asking = { kind: 'asking', summary: 'Same change for the invoices?' } as const
const doneCard = { kind: 'done', summary: null } as const
const permCard = { kind: 'permission', requestId: 'r', tool: 'Bash', command: 'ls', input: {}, risky: null, seenCount: 0 } as const

it('describes ambiguous Codex permissions without naming the wrong command', () => {
  const card = { ...permCard, ambiguous: true }
  expect(permissionAsk(card)).toBe('Review pending permissions in Codex’s terminal.')
  expect(permissionWho(card)).toBe('needs permission in its terminal')
  expect(permissionDetail(card)).toBe('More than one request may be pending.')
})

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

describe('stateLabel', () => {
  it('names the busy-but-not-you variants of working', () => {
    const now = 1_000_000
    expect(stateLabel(mk('a', { state: 'working' }), now)).toBe('Working')
    expect(stateLabel(mk('a', { state: 'working', busy: { kind: 'compact' } }), now)).toBe('Compacting')
    expect(stateLabel(mk('a', { state: 'working', busy: { kind: 'background', tasks: 2, nextAt: null } }), now)).toBe('2 in background')
    expect(stateLabel(mk('a', { state: 'working', busy: { kind: 'background', tasks: 0, nextAt: now + 4.5 * 60000 } }), now)).toBe('Back in 5 min')
    expect(stateLabel(mk('a', { state: 'working', busy: { kind: 'background', tasks: 0, nextAt: null } }), now)).toBe('Coming back')
    expect(stateLabel(mk('a', { state: 'done', busy: { kind: 'compact' } }), now)).toBe('Done')
  })
})

describe('groupByFolder', () => {
  it('groups by folder, newest folder first, labelled from the repo parent', () => {
    const h = (id: string, cwd: string | null, repo: string | null) => ({ sessionId: id, cwd, repo, worldId: null, lastPrompt: null, lastActivity: 0, running: false, managed: false })
    const g = groupByFolder([
      h('1', '/r/oreem/worktrees/aw-x', '/r/oreem'), h('2', '/r/oreem', '/r/oreem'), h('3', '/r/oreem/worktrees/aw-x', '/r/oreem'),
      h('4', '/r/oreem-worktrees/feat', '/r/oreem'), h('5', '/tmp/x', null), h('6', null, null),
    ])
    expect(g.map((x) => [x.label, x.items.map((i) => i.sessionId).join()])).toEqual([
      ['oreem/worktrees/aw-x', '1,3'], ['oreem', '2'], ['oreem-worktrees/feat', '4'], ['x', '5'], ['Unknown folder', '6'],
    ])
  })
})

describe('dropTarget', () => {
  it('lands in another world, never its own room or no room', () => {
    const worlds = [{ id: 'web', name: 'Web', color: '#000', repos: [] }, { id: 'pos', name: 'POS', color: '#111', repos: [] }]
    const s = mk('a', { worldId: 'web' })
    expect(dropTarget(s, 'pos', worlds)?.name).toBe('POS')
    expect(dropTarget(s, 'web', worlds)).toBeNull()
    expect(dropTarget(s, null, worlds)).toBeNull()
    expect(dropTarget(s, 'gone', worlds)).toBeNull()
    expect(dropTarget(undefined, 'pos', worlds)).toBeNull()
  })
})

describe('agentName', () => {
  it('names the CLI a session runs, Claude when unknown or from an older server', () => {
    expect(agentName({ agent: 'kimi' })).toBe('Kimi')
    expect(agentName({ agent: 'codex' })).toBe('Codex')
    expect(agentName({})).toBe('Claude')
  })
})

describe('otherAgents', () => {
  const list = [
    { id: 'claude', name: 'Claude Code', installed: true, modes: true },
    { id: 'codex', name: 'Codex', installed: true, modes: false },
    { id: 'qwen', name: 'Qwen Code', installed: false, modes: false },
    { id: 'kimi', name: 'Kimi Code', installed: true, modes: false },
  ]
  it('offers the installed agents except the session\'s current one, re-derived per current', () => {
    expect(otherAgents(list, 'claude').map((a) => a.id)).toEqual(['codex', 'kimi'])
    expect(otherAgents(list, 'kimi').map((a) => a.id)).toEqual(['claude', 'codex'])
    expect(otherAgents(null, 'claude')).toEqual([])
  })
})

import { stepTags } from '../src/logic'
import type { Run, Session, StepKind } from '../src/types'

describe('stepTags', () => {
  const step = (kind: StepKind, sessionId: string | null) => ({ kind, agent: 'claude', checkpoint: false, status: 'running' as const, sessionId, summary: null })
  const run = (status: Run['status'], steps: Run['steps']): Run => ({ id: 'r', task: 't', worldId: 'w', repo: '/r', dir: null, steps, current: 0, status, note: null, startedAt: 0 })
  const ses = (id: string, pane: string | null = null) => ({ id, tmux: pane ? { session: 'x', pane } : null }) as Session
  it('tags each step session of a live run with its place and kind, and nothing of a finished run', () => {
    expect(stepTags([run('waiting', [step('plan', 'a'), step('review-plan', 'b'), step('build', null), step('review-code', null)]), run('done', [step('plan', 'c')])], [ses('a'), ses('b'), ses('c'), ses('d')]))
      .toEqual({ a: 'step 1/4 · Plan', b: 'step 2/4 · Review plan' })
  })
  it('tags a step still starting (before its first hook names it) by its terminal', () => {
    expect(stepTags([run('running', [{ ...step('plan', null), pane: '%7' }, step('build', null)])], [ses('starting-1', '%7'), ses('other', '%8')]))
      .toEqual({ 'starting-1': 'step 1/2 · Plan' })
  })
})

describe('openHttp', () => {
  it('warns for plain http beyond your own network only', () => {
    expect(openHttp('http://45.138.52.110:8888/v1')).toBe(true)
    expect(openHttp('HTTP://example.com/v1')).toBe(true)
    for (const a of ['https://example.com/v1', 'http://192.168.1.20:8080/v1', 'http://10.0.0.5/v1', 'http://172.20.1.1/v1', 'http://localhost:1234/v1', 'http://box.local/v1', 'http://100.101.1.2/v1', 'http://[::1]:8080/v1', 'not a url', ''])
      expect(openHttp(a)).toBe(false)
    for (const a of ['http://172.32.0.1/v1', 'http://172.15.0.1/v1', 'http://100.63.0.1/v1', 'http://100.128.0.1/v1']) expect(openHttp(a)).toBe(true)
    for (const a of ['http://172.16.0.1/v1', 'http://172.31.0.1/v1', 'http://100.64.0.1/v1', 'http://100.127.0.1/v1']) expect(openHttp(a)).toBe(false)
  })
})
