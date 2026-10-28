import type { AgentId, Session, SessionState, World, RoomGroup, Card, Unmanaged, HistorySession, Review, PermissionMode, StepKind, Run, RunStep, Turn } from './types'

export const NEEDS_YOU: SessionState[] = ['waiting', 'done', 'error']
export const UNSORTED: World = { id: '__unsorted', name: 'Unsorted', color: '#8a92a0', repos: [] }
const CARD_RANK: Record<string, number> = { permission: 0, question: 1, asking: 1, error: 2, done: 3 }

export const LABEL: Record<SessionState, string> = {
  starting: 'Starting', working: 'Working', waiting: 'Needs you', done: 'Done', error: 'Error', idle: 'Idle',
}

/** A first Restart click waits through active work and questions; a second click acts now. */
export const queueRestart = (state: SessionState, queued: boolean): boolean => !queued && (state === 'working' || state === 'waiting')
export const maxSpawnedOf = (raw: string): number | null => {
  const n = raw.trim() ? Number(raw) : NaN
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** What each kind of run step does, in the order a run usually has them. */
export const STEP_LABEL: Record<StepKind, string> = { plan: 'Plan', 'review-plan': 'Review plan', build: 'Build', 'review-code': 'Review code' }
/** Whether a session is (or was) a step's: by id, or by its terminal before its first hook names it (Claude asks to trust a new worktree first). */
export const isStepOf = (st: Pick<RunStep, 'pane' | 'direct' | 'sessionId'>, s: Pick<Session, 'id' | 'tmux' | 'direct'>) =>
  st.sessionId === s.id || (!!st.pane && s.tmux?.pane === st.pane) || (!!st.direct && s.direct === st.direct)
/** "step 2/4 · Review plan" for each session that is a step of a live run, by session id. */
export function stepTags(runs: Run[], sessions: Session[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of runs) {
    if (r.status !== 'running' && r.status !== 'waiting') continue
    for (const s of sessions) {
      const i = r.steps.findIndex((st) => isStepOf(st, s))
      if (i >= 0) out[s.id] = `step ${i + 1}/${r.steps.length} · ${STEP_LABEL[r.steps[i].kind]}`
    }
  }
  return out
}
/** A useful name before the user gives a session its own name. The first task stays stable as work progresses. */
export const nameOf = (s: { label?: string | null; repoName: string; task?: string | null }): string =>
  s.label || (s.task ? (s.task.length > 48 ? `${s.task.slice(0, 47).trimEnd()}…` : s.task) : s.repoName)
/** "team of <lead>" for a session a lead started with aw_spawn, else null. */
export const teamOf = (s: { parent?: string | null }, sessions: Record<string, { label?: string | null; repoName: string; task?: string | null }>): string | null =>
  s.parent ? `team of ${sessions[s.parent] ? nameOf(sessions[s.parent]) : 'a lead that ended'}` : null
export const roleOf = (s: { id: string; parent?: string | null }, sessions: Record<string, { parent?: string | null }>): 'Leader' | 'Worker' | null =>
  s.parent ? 'Worker' : Object.values(sessions).some(c => c.parent === s.id) ? 'Leader' : null
/** The short name of the CLI a session runs, for labels ("Typing into Kimi"). */
export const agentName = (s: Pick<Session, 'agent'>): string => ({ codex: 'Codex', qwen: 'Qwen', kimi: 'Kimi', gemini: 'Gemini', agy: 'Antigravity' } as Record<string, string>)[s.agent ?? ''] ?? 'Claude'
/** The chooser badge for non-default sessions; Claude stays visually quiet. */
export const agentLabel = (s: Pick<Session, 'agent'>): string | null => s.agent && s.agent !== 'claude' ? agentName(s) : null

/** The state label, with the busy-but-not-you variants of 'working'. */
export function stateLabel(s: Session, now: number): string {
  const b = s.busy
  if (s.state !== 'working' || !b) return LABEL[s.state]
  if (b.kind === 'compact') return 'Compacting'
  if (b.tasks) return `${b.tasks} in background`
  return b.nextAt ? `Back in ${Math.max(1, Math.ceil((b.nextAt - now) / 60000))} min` : 'Coming back'
}

/** When did this session start needing the user? Falls back to updatedAt for cards without a waiting time. */
export const since = (s: Session): number => s.waitingSince ?? s.updatedAt

export const waitMinutes = (s: Session, now: number): number =>
  Math.max(0, Math.floor((now - since(s)) / 60000))

/** Done and error cards are finished work, not a wait; only the others say "waiting". */
export function fmtWait(min: number, state: SessionState = 'waiting'): string {
  const done = state === 'done' || state === 'error'
  if (done) return min < 1 ? 'finished just now' : `finished ${min} min ago`
  return min < 1 ? 'waiting <1 min' : `waiting ${min} min`
}

/** 0 = fresh, 1 = slumped at 10 min, 2 = sitting on the floor at 20 min. */
export const tiredLevel = (minutes: number): 0 | 1 | 2 => (minutes >= 20 ? 2 : minutes >= 10 ? 1 : 0)

/** Sessions needing the user: permission, question, error, done; then oldest first. */
export function queue(sessions: Session[]): Session[] {
  return sessions
    .filter((s) => s.card && NEEDS_YOU.includes(s.state))
    .sort((a, b) => (CARD_RANK[a.card!.kind] - CARD_RANK[b.card!.kind]) || (since(a) - since(b)))
}

/** Rooms in world order, then Unsorted (only if used). Sessions with an unknown worldId land in Unsorted. */
export function groupSessions(worlds: World[], sessions: Session[]): RoomGroup[] {
  const known = new Set(worlds.map((w) => w.id))
  const groups: RoomGroup[] = worlds.map((world) => ({ world, sessions: sessions.filter((s) => s.worldId === world.id) }))
  const loose = sessions.filter((s) => !s.worldId || !known.has(s.worldId))
  if (loose.length) groups.push({ world: UNSORTED, sessions: loose })
  return groups
}

/** On-screen order used for the 1-9 keys. Ghosts (other Claude sessions) never get a number. */
export const screenOrder = (groups: RoomGroup[]): Session[] => groups.flatMap((g) => g.sessions.filter((s) => !s.ghost))

/** Next session in the queue after `currentId`, wrapping; null when the queue is empty.
 *  When the app picked the current selection by itself, the first Space takes the head of the queue instead of skipping it. */
export function nextNeedingYou(q: Session[], currentId: string | null, autoSelected = false): Session | null {
  if (!q.length) return null
  if (autoSelected) return q[0]
  const i = q.findIndex((s) => s.id === currentId)
  return q[(i + 1) % q.length]
}

export interface KeyInfo {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  /** The event target is an input, textarea, select, contenteditable, a dialog, or inside the terminal. */
  typing: boolean
  /** Focus is on a button/link/summary: Space activates it, so Space is not ours there. */
  onControl?: boolean
  overlayOpen: boolean
}
export type KeyAction =
  | { kind: 'next' } | { kind: 'jump'; index: number } | { kind: 'help' } | { kind: 'escape' }
  | { kind: 'new-task' } | { kind: 'recent' } | { kind: 'leave-terminal' } | { kind: 'mute' } | { kind: 'catchup' } | { kind: 'worlds' } | { kind: 'terminal' } | null

/** Decides what a keypress means. Never claims a key while the user is typing (or in the terminal). */
export function routeKey(k: KeyInfo): KeyAction {
  if (k.ctrl && !k.meta && !k.alt && k.key === ']') return { kind: 'leave-terminal' }
  if (k.ctrl || k.meta || k.alt) return null
  if (k.key === 'Escape') return k.overlayOpen ? { kind: 'escape' } : null
  if (k.typing) return null
  if (k.key === ' ') return k.onControl ? null : { kind: 'next' }
  if (k.key === '?') return { kind: 'help' }
  if (k.key === 'n' || k.key === 'N') return { kind: 'new-task' }
  if (k.key === 'r' || k.key === 'R') return { kind: 'recent' }
  if (k.key === 'm' || k.key === 'M') return { kind: 'mute' }
  if (k.key === 'c' || k.key === 'C') return { kind: 'catchup' }
  if (k.key === 'w' || k.key === 'W') return { kind: 'worlds' }
  if (k.key === 't' || k.key === 'T' || (k.key === 'Enter' && !k.onControl)) return { kind: 'terminal' }
  if (/^[1-9]$/.test(k.key)) return { kind: 'jump', index: Number(k.key) - 1 }
  return null
}

/** DOM helper for routeKey's `typing` flag. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.closest) return false
  return !!el.closest('input,textarea,select,[contenteditable="true"],.xterm,[role="dialog"]')
}
export function isControlTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && !!el.closest && !!el.closest('button,summary,a')
}

/** Ctrl+] is how a keyboard user leaves the terminal (Esc must keep going to Claude). */
export const isLeaveTerminalKey = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean =>
  e.ctrlKey && !e.metaKey && !e.altKey && e.key === ']'

export const ctxColor = (pct: number): string => (pct >= 80 ? '#ee705f' : pct >= 50 ? '#f2b84b' : '#72cf98')

/** Question answers: one label per question; multi-select labels are joined with ", ". */
export function buildAnswers(
  questions: { question: string; multiSelect: boolean }[],
  picked: Record<string, string[]>,
): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const q of questions) {
    const p = picked[q.question] ?? []
    if (!p.length) return null
    out[q.question] = p.join(', ')
  }
  return out
}

/** Which "Always allow" scopes are usable for a permission card. The server says when `Everywhere` is refused. */
export function scopeAvailability(c: Extract<Card, { kind: 'permission' }>): { repo: boolean; world: boolean; all: boolean; allReason: string | null } {
  const why = c.everywhere !== undefined ? c.everywhere : c.risky ? `Not offered: this command ${c.risky}.` : null
  return { repo: true, world: true, all: !why, allReason: why }
}
export const showLearnNudge = (c: Extract<Card, { kind: 'permission' }>): boolean => c.seenCount >= 3

/** Conflicts of one room: dashed links between sessions in the room, and badges for ones whose partner is elsewhere. */
export function roomConflicts(sessions: Session[]): { links: { a: string; b: string; reason: string }[]; badges: string[] } {
  const ids = new Set(sessions.map((s) => s.id))
  const seen = new Set<string>()
  const links: { a: string; b: string; reason: string }[] = []
  const badges = new Set<string>()
  for (const s of sessions) {
    for (const c of s.conflicts ?? []) {
      if (ids.has(c.withId) && c.withId !== s.id) {
        const key = [s.id, c.withId].sort().join('|')
        if (!seen.has(key)) { seen.add(key); links.push({ a: s.id, b: c.withId, reason: c.reason }) }
      } else badges.add(s.id)
    }
  }
  return { links, badges: [...badges] }
}

/** Should a change from `prev` to `next` alert the user? Only the moment a session starts needing them. */
export function startsNeedingYou(prev: Session | undefined, next: Session): boolean {
  if (!NEEDS_YOU.includes(next.state) || !next.card) return false
  if (!prev) return true
  return prev.state !== next.state || !prev.card || cardId(prev.card) !== cardId(next.card)
}
const cardId = (c: Card): string => (c.kind === 'permission' || c.kind === 'question' ? c.requestId : c.kind)

/** Header split: waiting = it cannot go on without an answer; review = finished work (done or error). */
export function needSplit(q: Session[]): { waiting: number; review: number } {
  let waiting = 0, review = 0
  for (const s of q) { if (s.card?.kind === 'done' || s.card?.kind === 'error') review++; else waiting++ }
  return { waiting, review }
}

/** Order of the inbox. Unfrozen: the queue order. Frozen (pointer over it): cards keep their place, gone ones drop out, new ones go last. */
export function inboxOrder(prev: string[], next: string[], frozen: boolean): string[] {
  if (!frozen) return next
  const now = new Set(next), had = new Set(prev)
  return [...prev.filter((k) => now.has(k)), ...next.filter((k) => !had.has(k))]
}

// ---- review block ----
export interface ReviewView { changed: Review['files']; commits: Review['commits']; uncommitted: Review['files']; canCommit: boolean; canMr: boolean }
/** What the review offers. Commit only when something is uncommitted; Open MR only when commits exist. */
export function reviewView(r: Review): ReviewView {
  const commits = r.commits ?? [], uncommitted = r.uncommitted ?? []
  return { changed: r.files ?? [], commits, uncommitted, canCommit: uncommitted.length > 0, canMr: commits.length > 0 }
}

// ---- ghosts (other Claude sessions on this computer) ----
export const MAX_GHOSTS_DRAWN = 6
export function splitGhosts(sessions: Session[]): { real: Session[]; ghosts: Session[] } {
  return { real: sessions.filter((s) => !s.ghost), ghosts: sessions.filter((s) => s.ghost) }
}
/** The sessions the room scene draws: all real ones, at most `cap` ghosts; `hidden` is how many ghosts were left out. */
export function drawnSessions(sessions: Session[], cap = MAX_GHOSTS_DRAWN): { sessions: Session[]; hidden: number } {
  const { real, ghosts } = splitGhosts(sessions)
  return { sessions: [...real, ...ghosts.slice(0, cap)], hidden: Math.max(0, ghosts.length - cap) }
}
export const ghostChipText = (n: number): string => `${n} other Claude ${n === 1 ? 'session' : 'sessions'} on this computer`

// ---- "Now" without tool names ----
const TOOL_VERBS: [string, string][] = [
  ['AskUserQuestion', 'Asking you a question'], ['Bash', 'Running a command'],
  ['Edit|Write|MultiEdit|NotebookEdit', 'Editing files'], ['Read|Grep|Glob', 'Reading files'], ['Agent|Task', 'Working with helpers'],
]
/** A "Now" line that is just a tool name (optionally "Using Bash…") becomes what the tool does. Other text is left alone. */
export function nowText(text: string): string {
  for (const [tools, verb] of TOOL_VERBS) if (new RegExp(`^(?:(?:Using|Running|Calling)\\s+)?(?:${tools})(?:\\.\\.\\.|…)?$`).test(text.trim())) return verb
  return text
}

// ---- permission mode ----
export type ModeChoice = 'claude' | PermissionMode
export const MODE_NAMES: Record<string, string> = {
  default: 'ask before every action', acceptEdits: 'auto-accept edits', plan: 'plan only', auto: 'auto', bypassPermissions: 'no permission checks',
}
export const MODE_HELP: Record<ModeChoice, string> = {
  claude: 'Uses whatever your own Claude Code is set to.',
  default: 'Claude asks you in the inbox before each edit or command.',
  acceptEdits: 'File edits go through without asking; commands still ask.',
  plan: 'Claude only plans and shows you the plan; it changes nothing.',
  auto: 'Claude decides what is safe and asks only when it is unsure.',
  bypassPermissions: 'Nothing is checked. Only for throwaway folders.',
}
export function modeOptions(claudeDefault: string | null): { value: ModeChoice; label: string }[] {
  return [
    { value: 'claude', label: `Your Claude default (${claudeDefault ? MODE_NAMES[claudeDefault] ?? claudeDefault : 'not set'})` },
    { value: 'default', label: 'Ask before every action' },
    { value: 'acceptEdits', label: 'Auto-accept edits' },
    { value: 'plan', label: 'Plan only' },
    { value: 'auto', label: 'Auto' },
  ]
}
/** The request field: nothing at all for "Your Claude default". */
export const modeField = (c: ModeChoice): { permissionMode?: PermissionMode } => (c === 'claude' ? {} : { permissionMode: c })
/** Permission modes belong to Claude, including recovery rows that explicitly name it. */
export const resumePermissionMode = (agent: AgentId | undefined, c: ModeChoice): PermissionMode | undefined =>
  agent && agent !== 'claude' ? undefined : modeField(c).permissionMode

// ---- touch ----
export const isTouch = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

/** Caps rendered diff lines; `hidden` is how many were left out. */
export function capDiff(diff: string, max = 400, all = false): { lines: string[]; hidden: number } {
  const lines = diff.split('\n')
  if (all || lines.length <= max) return { lines, hidden: 0 }
  return { lines: lines.slice(0, max), hidden: lines.length - max }
}
export const diffClass = (l: string): string => (l.startsWith('@@') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '')

/** 0 none, 1 getting heavy (>=50), 2 nearly full (>=80). */
export const ctxLevel = (pct: number): 0 | 1 | 2 => (pct >= 80 ? 2 : pct >= 50 ? 1 : 0)

/** "Chrome on Android" from a user-agent string; good enough to tell your own devices apart. */
export function deviceText(agent: string): string {
  const os = /iPhone|iPad/.test(agent) ? (agent.includes('iPad') ? 'iPad' : 'iPhone') : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : null
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : null
  if (!os && !browser) return agent ? agent.slice(0, 40) : 'Unknown device'
  return [browser, os].filter(Boolean).join(' on ')
}
export const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

/** Permission/question cards the GUI can answer. `live:false` means only the terminal can (no GUI was connected, or the hold timed out). */
export const cardLive = (c: Card): boolean => !((c.kind === 'permission' || c.kind === 'question') && c.live === false)

/** Server errors are `{error}`; some routes use `{message}`. */
export function errorText(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; message?: unknown }
  const t = typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : ''
  return t || `Request failed (${status}).`
}

/** What a session needs when catch-up has no answer, by state. */
export function needsFallback(state: SessionState): string {
  switch (state) {
    case 'done': return 'Your review'
    case 'idle': return 'A new task'
    case 'working': return 'Nothing right now. It is working.'
    case 'waiting': return 'Your answer (see the inbox)'
    case 'error': return 'A look at the error'
    default: return 'Nothing yet. It is starting.'
  }
}

export interface CatchupView {
  mode: 'running' | 'filled' | 'empty'
  asked: string | null
  did: string | null
  needs: string | null
  /** Shown when `needs` is empty. */
  needsFallback: string
  /** The session needed you again after this was written. */
  stale: boolean
  /** "Written 3 min ago" when filled. */
  written: string | null
}
/** What the catch-up area shows. Catch-up is manual: without it only the task ("You asked") is known. */
const NOTHING = /^\W*(?:none|nothing|n\/a|nil|no)?\W*$/i
/** "", "none", "Nothing." and the like mean catch-up has no answer. */
export const meaningful = (t: string | null | undefined): string | null => (t && !NOTHING.test(t.trim()) ? t.trim() : null)
export function catchupView(s: Session, now: number): CatchupView {
  const c = s.catchup ?? null
  const asked = c?.asked ?? s.task ?? null
  const fb = needsFallback(s.state)
  if (s.catchupRunning) return { mode: 'running', asked, did: null, needs: null, needsFallback: fb, stale: false, written: null }
  if (!c) return { mode: 'empty', asked, did: null, needs: null, needsFallback: fb, stale: false, written: null }
  const min = s.catchupAt ? Math.max(0, Math.floor((now - s.catchupAt) / 60000)) : null
  const written = min === null ? null : min < 1 ? 'Written just now' : `Written ${min} min ago`
  const stale = !!s.catchupStale
  return { mode: 'filled', asked, did: c.did, needs: stale ? null : meaningful(c.needs), needsFallback: fb, stale, written }
}

/** Swatches offered when colouring a world. */
export const PALETTE = ['#47b4a7', '#e07aa8', '#9c88df', '#f2b84b', '#6aaef0', '#72cf98', '#ee705f', '#f08a5d']

/** First palette colour no world uses yet (cycling when all are taken). */
export function nextColor(worlds: World[]): string {
  const used = new Set(worlds.map((w) => w.color.toLowerCase()))
  return PALETTE.find((c) => !used.has(c)) ?? PALETTE[worlds.length % PALETTE.length]
}

/** New id order after moving `id` one step up (-1) or down (+1); unchanged at the ends. */
export function moveId(ids: string[], id: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(id), j = i + dir
  if (i < 0 || j < 0 || j >= ids.length) return ids
  const out = [...ids]; [out[i], out[j]] = [out[j], out[i]]
  return out
}

/** Repos list with `repo` added once. */
export const withRepo = (repos: string[], repo: string): string[] => (repos.includes(repo) ? repos : [...repos, repo])

// ---- permission wording ----
export function permissionAsk(c: Extract<Card, { kind: 'permission' }>): string {
  if (c.ambiguous) return 'Review pending permissions in Codex’s terminal.'
  switch (c.target?.type) {
    case 'command': return 'Run this command?'
    case 'file': return 'Edit this file?'
    case 'url': return 'Open this address?'
    case 'other': return `Allow ${c.tool}?`
    default: return c.command ? 'Run this command?' : `Allow ${c.tool}?`
  }
}
export function permissionWho(c: Extract<Card, { kind: 'permission' }>): string {
  if (c.ambiguous) return 'needs permission in its terminal'
  switch (c.target?.type) {
    case 'file': return 'wants to edit a file'
    case 'url': return 'wants to open an address'
    case 'other': return `wants to use ${c.tool}`
    default: return 'wants to run a command'
  }
}
/** The line shown under the question: the target's value, else the command, else the raw input. */
export function permissionDetail(c: Extract<Card, { kind: 'permission' }>): string {
  if (c.ambiguous) return 'More than one request may be pending.'
  if (c.target?.value) return c.target.value
  if (c.command) return c.command
  try { return JSON.stringify(c.input, null, 2) ?? '' } catch { return String(c.input) }
}

// ---- New session: which world to start in ----
export type WorldChoice = { kind: 'world'; id: string } | { kind: 'pick' } | { kind: 'none' }
/** Explicit world, else the filtered world (what the user is looking at), else the selected session's, else the only world, else ask. */
export function defaultWorld(worlds: World[], opts: { explicit?: string; selectedWorldId?: string | null; filter: string }): WorldChoice {
  const has = (id?: string | null) => (id && worlds.some((w) => w.id === id) ? id : null)
  const id = has(opts.explicit) ?? has(opts.filter) ?? has(opts.selectedWorldId)
  if (id) return { kind: 'world', id }
  if (worlds.length === 1) return { kind: 'world', id: worlds[0].id }
  return worlds.length ? { kind: 'pick' } : { kind: 'none' }
}

// ---- worlds panel ----
export function deleteWorldText(name: string, n: number): string {
  if (!n) return `Delete ${name}? It has no sessions. Nothing is stopped.`
  return `Delete ${name}? Its ${n} ${n === 1 ? 'session moves' : 'sessions move'} to Unsorted and ${n === 1 ? 'keeps' : 'keep'} running. Nothing is stopped.`
}

// ---- unmanaged sessions (drawn as ghosts) ----
export const ghostId = (pid: number): string => `ghost:${pid}`
export function ghostSession(u: Unmanaged): Session {
  const repo = u.repo ?? u.cwd
  return {
    id: ghostId(u.pid), worldId: u.worldId, repo, repoName: baseName(repo), cwd: u.cwd, branch: null, worktree: false,
    tmux: null, state: 'idle', waitingSince: null, task: u.lastPrompt ?? null, now: 'Running in a plain terminal', log: [], helpers: [], card: null,
    startedAt: u.since, updatedAt: u.since, ghost: u,
  }
}

// ---- recent sessions ----
export function filterHistory(list: HistorySession[], q: string): HistorySession[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return list
  return list.filter((h) => {
    const hay = [h.repo ?? '', h.cwd ?? '', h.lastPrompt ?? '', h.sessionId].join(' ').toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
/** The world a dragged session lands in, or null when the drop changes nothing (no room, or its own room). */
export function dropTarget(s: Session | undefined, over: string | null, worlds: World[]): World | null {
  const w = over ? worlds.find((x) => x.id === over) : undefined
  return s && w && w.id !== s.worldId ? w : null
}

export interface FolderGroup { cwd: string; label: string; items: HistorySession[] }
/**
 * Sessions by the folder they ran in, newest folder first (the list comes newest first). The label is the path from
 * the repo's parent, so a worktree reads "oreem/worktrees/aw-x" or "oreem-worktrees/feat".
 */
export function groupByFolder(list: HistorySession[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>()
  for (const h of list) {
    const cwd = h.cwd ?? ''
    let g = groups.get(cwd)
    if (!g) {
      const parent = h.repo ? h.repo.replace(/\/[^/]+$/, '') : ''
      const label = !cwd ? 'Unknown folder' : parent && cwd.startsWith(parent + '/') ? cwd.slice(parent.length + 1) : baseName(cwd)
      groups.set(cwd, (g = { cwd, label, items: [] }))
    }
    g.items.push(h)
  }
  return [...groups.values()]
}
export function ageText(ms: number, now: number): string {
  const min = Math.max(0, Math.floor((now - ms) / 60000))
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} days ago`
}

export type ResumeResult = { kind: 'ok'; tmuxSession: string | null } | { kind: 'running'; pid: number | null } | { kind: 'error'; message: string }
/** Reads the answer of POST /api/sessions/resume. 409 means the session is still open somewhere else. */
export function resumeOutcome(status: number, body: unknown): ResumeResult {
  const b = (body ?? {}) as { tmuxSession?: unknown; pid?: unknown; stopFailed?: unknown }
  if (status >= 200 && status < 300) return { kind: 'ok', tmuxSession: typeof b.tmuxSession === 'string' ? b.tmuxSession : null }
  if (status === 409 && b.stopFailed !== true) return { kind: 'running', pid: typeof b.pid === 'number' ? b.pid : null }
  return { kind: 'error', message: errorText(status, body) }
}

/** The agents "Continue in" can hand a session to: installed, and not the one the session already runs. */
export const otherAgents = <T extends { id: string; installed: boolean }>(agents: T[] | null, current: string): T[] =>
  (agents ?? []).filter((a) => a.installed && a.id !== current)

/** Whether a server address is plain http to a host outside your own network (where anyone on the way can read it). */
export function openHttp(address: string): boolean {
  let u: URL
  try { u = new URL(address.trim()) } catch { return false }
  if (u.protocol !== 'http:') return false
  const h = u.hostname.replace(/^\[|\]$/g, '')
  return !(h === 'localhost' || h.endsWith('.local') || h === '::1' || /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h))
}

/** The one line a card asks of you: what it wants to run, its question, or what it said when it stopped. */
export function cardAsk(c: Card): string {
  if (c.kind === 'permission') return permissionAsk(c)
  if (c.kind === 'question') return c.questions.length === 1 ? c.questions[0].question : `${c.questions.length} questions`
  if (c.kind === 'done') return c.summary ?? 'Finished'
  return c.summary
}

/** A row's preview of its card: what a permission would actually run or touch, so `npm test` and `rm -rf` differ at a glance. */
export function chatPreview(c: Card): string {
  if (c.kind !== 'permission') return cardAsk(c)
  const verb = ({ command: 'Run', file: 'Edit', url: 'Open' } as Record<string, string>)[c.target?.type ?? (c.command ? 'command' : '')] ?? `Allow ${c.tool}`
  return `${verb}: ${permissionDetail(c).split('\n')[0]}`
}
/** One card's identity: a new request from the same session is a new card. */
export const cardKey = (s: Session): string => s.id + ':' + (s.card?.kind === 'permission' || s.card?.kind === 'question' ? s.card.requestId : s.card?.kind ?? '')

export interface ChatRow { s: Session; preview: string; at: number; needs: boolean }
/** The chats list: sessions needing you first (inbox order), then the rest, latest activity first. */
export function chatRows(sessions: Session[]): ChatRow[] {
  const needs = queue(sessions), need = new Set(needs)
  const rest = sessions.filter((s) => !need.has(s)).sort((a, b) => b.updatedAt - a.updatedAt)
  return [...needs, ...rest].map((s) => ({
    s, needs: need.has(s), at: s.waitingSince ?? s.updatedAt,
    preview: (s.card ? chatPreview(s.card) : '') || s.now || s.lastPrompt || s.task || '',
  }))
}
/** The agents whose native transcript format the chat view understands. */
export const hasChat = (s: Pick<Session, 'agent' | 'ghost'>): boolean => ['claude', 'codex'].includes(s.agent ?? 'claude') && !s.ghost

export type ChatItem = { who: 'you' | 'claude'; text: string } | { who: 'steps'; lines: string[] }
/** Folds each run of tool steps into one item, so a chat reads as messages with "6 steps" between them. */
export function chatItems(turns: Turn[]): ChatItem[] {
  const out: ChatItem[] = []
  for (const t of turns) {
    const last = out[out.length - 1]
    if (t.who !== 'step') out.push({ who: t.who, text: t.text })
    else if (last?.who === 'steps') last.lines.push(t.text)
    else out.push({ who: 'steps', lines: [t.text] })
  }
  return out
}
/** "14:05" today, "Mon" this week, else "12 Oct". */
// Made once: toLocale*String with options builds a new formatter per call, the slowest thing in a long chat list.
const HM = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' }), WD = new Intl.DateTimeFormat([], { weekday: 'short' }), DM = new Intl.DateTimeFormat([], { day: 'numeric', month: 'short' })
export function chatTime(at: number, now: number): string {
  const d = new Date(at), n = new Date(now)
  if (d.toDateString() === n.toDateString()) return HM.format(d)
  return (now - at < 6 * 86400000 ? WD : DM).format(d)
}
/** The pill on a chat row: blocked on you, failed, or finished and waiting for a look. */
export function chatBadge(c: Card): { label: string; tone: 'wait' | 'err' | 'ok' } {
  if (c.kind === 'error') return { label: 'Problem', tone: 'err' }
  if (c.kind === 'done') return { label: 'To review', tone: 'ok' }
  return { label: 'Needs you', tone: 'wait' }
}
/** What you just did on a card, as a line for the chat ("You allowed: npm test"). */
export function actedLine(c: Card, did: 'allow' | 'deny' | 'ack' | { scope: string } | { answers: Record<string, string> }): string {
  if (did === 'ack') return c.kind === 'error' ? 'You dismissed the problem' : 'You marked it reviewed'
  const what = c.kind === 'permission' ? permissionDetail(c) : ''
  if (did === 'deny') return `You denied: ${what}`
  if (did === 'allow') return `You allowed once: ${what}`
  if ('answers' in did) return `You answered: ${Object.values(did.answers).join(', ')}`
  return `You always allow (${did.scope}): ${what}`
}
/** While a permission or question is on the agent's screen, text typed to it lands in that dialog (and its Enter picks
 *  the highlighted option), so the message box waits. */
export const typingWaits = (c: Card | null): boolean => c?.kind === 'permission' || c?.kind === 'question'
/** The chat to go to next: the first one needing you that is not this one and not a card you skipped. */
export function nextChat(queue: Session[], currentId: string | null, skipped: Set<string>): Session | null {
  return queue.find((s) => s.id !== currentId && !skipped.has(cardKey(s))) ?? null
}

/**
 * Lead spawn rules (agent id -> allowed models, [] for any; key order is the preference order) with agent `id` set to
 * `models`, or turned off with null. Unset rules (everything allowed) are spelled out as every agent in `ids` first.
 * An agent turned on goes last.
 */
export function spawnWith(rules: Record<string, string[]> | null, ids: string[], id: string, models: string[] | null): Record<string, string[]> {
  const next = { ...(rules ?? Object.fromEntries(ids.map((a) => [a, []]))) }
  if (models === null) delete next[id]
  else next[id] = models
  return next
}

/**
 * The same rules with agent `id` swapped with its neighbour earlier (-1) or later (1) among the `shown` agents
 * (rules can name an agent that is not installed here, which no list shows).
 */
export function spawnMoved(rules: Record<string, string[]>, id: string, dir: -1 | 1, shown: string[]): Record<string, string[]> {
  const keys = Object.keys(rules), seen = keys.filter((k) => shown.includes(k))
  const other = seen[seen.indexOf(id) + dir]
  if (!seen.includes(id) || !other) return rules
  return Object.fromEntries(keys.map((k) => (k === id ? other : k === other ? id : k)).map((k) => [k, rules[k]]))
}
