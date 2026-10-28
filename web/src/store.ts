import { reactive, computed, ref, watch, markRaw } from 'vue'
import type { ServerMessage, Session, World, RoomGroup, Run, StepKind, FsListing, PhoneInfo, AccessInfo, Turn, Unmanaged, HistorySession, PermissionMode, RecoverableSession, AgentId } from './types'
import { moveRepoPatches } from './fsbrowser'
import { alertNeedsYou } from './notify'
import { errorText, ghostId, ghostSession, resumeOutcome, type ResumeResult, type TeamRole, groupSessions, queue, screenOrder, nextNeedingYou, startsNeedingYou, isStepOf, cardKey, stepTags } from './logic'

export interface StoreState {
  worlds: World[]
  sessions: Record<string, Session>
  recoverable: RecoverableSession[]
  /** Insertion order of session ids (stable on-screen order). */
  order: string[]
  loaded: boolean
  connected: boolean
  selectedId: string | null
  /** The app picked the selection itself (nobody clicked): the first Space takes the head of the queue. */
  autoSelected: boolean
  toast: { text: string; n: number } | null
  filter: string
  now: number
  /** A session we just asked the server to start; selected when its upsert arrives. */
  pending: { tmux: string; until: number } | null
  /** Claude processes running outside Agent Worlds. */
  unmanaged: Unmanaged[]
  /** Newer code is on disk: offer "Update now". */
  update: boolean
  /** tmux is installed on the server (false: sessions run inside Agent Worlds and end when it restarts). */
  tmux: boolean
  runs: Record<string, Run>
}

export const newState = (): StoreState => ({
  worlds: [], sessions: {}, recoverable: [], order: [], loaded: false, connected: false,
  selectedId: null, autoSelected: false, toast: null, filter: 'all', now: Date.now(), pending: null, unmanaged: [], update: false, tmux: true, runs: {},
})

/** Applies one server message to the state. Pure aside from mutating `st`. */
/** True (and clears the wait) when `s` is the session we are waiting for; gives up after the deadline. */
export function claimPending(st: StoreState, s: Session, now = Date.now()): boolean {
  if (!st.pending) return false
  if (now > st.pending.until) { st.pending = null; return false }
  if ((s.tmux?.session ?? s.direct) !== st.pending.tmux) return false
  st.pending = null
  return true
}

/** Returns the session that has just started needing the user (for alerts), if any. */
export function applyMessage(st: StoreState, msg: ServerMessage): Session | null {
  let alert: Session | null = null
  switch (msg.type) {
    case 'snapshot':
      st.worlds = msg.worlds
      st.sessions = {}
      st.order = []
      // Sessions are replaced whole on every upsert, so they need no deep proxies (300 of them made every change walk them all).
      for (const s of msg.sessions) { st.sessions[s.id] = markRaw(s); st.order.push(s.id) }
      st.recoverable = msg.recoverable ?? []
      st.unmanaged = msg.unmanaged ?? []
      st.update = msg.update ?? false
      st.tmux = msg.tmux ?? true
      st.runs = Object.fromEntries((msg.runs ?? []).map((r) => [r.id, r]))
      st.loaded = true
      break
    case 'run':
      st.runs[msg.run.id] = msg.run
      break
    case 'unmanaged':
      st.unmanaged = msg.unmanaged
      break
    case 'session':
      st.recoverable = st.recoverable.filter((s) => s.id !== msg.session.id)
      if (claimPending(st, msg.session)) { st.selectedId = msg.session.id; st.autoSelected = false }
      if (startsNeedingYou(st.sessions[msg.session.id], msg.session)) alert = msg.session
      if (!st.sessions[msg.session.id]) st.order.push(msg.session.id)
      st.sessions[msg.session.id] = markRaw(msg.session)
      break
    case 'recoverable':
      st.recoverable = msg.sessions
      break
    case 'session-removed': {
      // The selected session's terminal gets a new session: a 'starting:<tmux>' placeholder's first hook, or /clear
      // (and /resume) starting a new conversation in the same pane. Keep following that terminal.
      const gone = st.sessions[msg.id]
      const term = gone?.tmux?.session ?? gone?.direct
      if (st.selectedId === msg.id && term) st.pending = { tmux: term, until: Date.now() + (gone.state === 'starting' ? 10000 : 3000) }
      delete st.sessions[msg.id]
      st.order = st.order.filter((i) => i !== msg.id)
      break
    }
    case 'worlds':
      st.worlds = msg.worlds
      break
    case 'update':
      st.update = true
      break
    case 'toast':
      st.toast = { text: msg.text, n: (st.toast?.n ?? 0) + 1 }
      break
  }
  keepSelection(st)
  return alert
}

/** Keep the selection valid: default to the oldest session needing you, else the first one. */
export function keepSelection(st: StoreState, now = Date.now()): void {
  // Not while waiting for the selected terminal's next session: that would jump to another terminal and back.
  const waiting = st.pending && now <= st.pending.until && st.selectedId && !st.sessions[st.selectedId]
  if (!waiting && (!st.selectedId || !(st.sessions[st.selectedId] || st.unmanaged.some((u) => ghostId(u.pid) === st.selectedId)))) {
    const list = st.order.map((i) => st.sessions[i])
    st.selectedId = (queue(list)[0] ?? list[0])?.id ?? null
    st.autoSelected = st.selectedId !== null
  }
}

export const state = reactive<StoreState>(newState())
export const sessionList = computed(() => state.order.map((i) => state.sessions[i]))
export const ghosts = computed(() => state.unmanaged.map(ghostSession))
const sameList = <T>(a: T[], b: T[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
/** Session id -> team role. Live status/token updates keep the same object, so rooms do not repaint. */
export const teamRoles = computed<Record<string, TeamRole>>((prev) => {
  const all = Object.values(state.sessions), leaders = new Set(all.map((s) => s.parent).filter(Boolean))
  const next = Object.fromEntries(all.map((s) => [s.id, leaders.has(s.id) ? (s.parent ? 'Leader + Worker' : 'Leader') : s.parent ? 'Worker' : null])) as Record<string, TeamRole>
  const same = prev && Object.keys(prev).length === all.length && all.every((s) => prev[s.id] === next[s.id])
  return same ? prev : next
})
/** Rooms hold the real sessions plus the ghosts of unmanaged ones. A room whose sessions did not change keeps its object, so it does not redraw. */
export const groups = computed<RoomGroup[]>((prev) => {
  const next = groupSessions(state.worlds, [...sessionList.value, ...ghosts.value]).map((g) => prev?.find((o) => o.world === g.world && sameList(o.sessions, g.sessions)) ?? g)
  return prev && sameList(prev, next) ? prev : next
})
/** Session id -> its room's world. */
const worldById = computed(() => new Map(groups.value.flatMap((g) => g.sessions.map((s) => [s.id, g.world] as const))))
export const worldOf = (s: Pick<Session, 'id'>): World | undefined => worldById.value.get(s.id)
/** Run step tags by session id; the same object until a tag changes. */
export const steps = computed<Record<string, string>>((prev) => {
  const next = stepTags(Object.values(state.runs), sessionList.value)
  return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next
})
export const screenSessions = computed(() => screenOrder(groups.value))
export const needsYou = computed(() => queue(sessionList.value))
/** Runs held for you: at a checkpoint, a step that stopped without handing off, or one that failed to start. */
export const runsNeedingYou = computed(() => Object.values(state.runs).filter((r) => r.status === 'waiting' || r.status === 'failed').sort((a, b) => a.startedAt - b.startedAt))
/** The run a session is (or was) a step of, and which step. */
export function runOf(s: Session): { run: Run; step: number } | null {
  for (const run of Object.values(state.runs)) {
    const step = run.steps.findIndex((st) => isStepOf(st, s))
    if (step >= 0) return { run, step }
  }
  return null
}
const lookup = (id: string): Session | undefined => state.sessions[id] ?? ghosts.value.find((g) => g.id === id)
export const selected = computed(() => (state.selectedId ? lookup(state.selectedId) ?? null : null))
/** The terminal the panel shows: its tmux session (or server-run pty), not the conversation in it, so /clear and /resume
 *  keep it attached — including the moment between the old session's removal and the new one's arrival. */
export function terminalOf(st: StoreState, s: Session | null): string | null {
  if (s) return s.tmux?.session ?? s.direct ?? null
  return st.pending && st.selectedId && !st.sessions[st.selectedId] ? st.pending.tmux : null
}

export const select = (id: string): void => {
  state.selectedId = id
  state.autoSelected = false
  const s = lookup(id)
  const w = s && worldOf(s)
  if (state.filter !== 'all' && w && w.id !== state.filter) state.filter = w.id
}
export const selectNext = (): boolean => {
  const n = nextNeedingYou(needsYou.value, state.selectedId, state.autoSelected)
  if (!n) { showToast('Nothing needs you right now.'); return false }
  select(n.id)
  return true
}
export const showToast = (text: string): void => { applyMessage(state, { type: 'toast', text }) }

// ---- actions (REST) ----
async function post(path: string, body?: unknown): Promise<boolean> {
  try {
    const r = await fetch(path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (r.status === 401 || r.status === 403) { showToast('Not authorised. Open the link with ?token=… once.'); return false }
    if (!r.ok) {
      let body: unknown = null
      try { body = await r.json() } catch { /* not json */ }
      showToast(errorText(r.status, body)) // 409 = stale or terminal-only request; the next upsert fixes the card
      return false
    }
    return true
  } catch {
    showToast('Could not reach the server.')
    return false
  }
}
const base = (id: string) => `/api/sessions/${encodeURIComponent(id)}`
type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }
async function api<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const raw = body instanceof Blob // a file goes up as-is
    const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': raw ? body.type || 'application/octet-stream' : 'application/json' }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) })
    let data: unknown = null
    try { data = await r.json() } catch { /* empty body */ }
    return r.ok ? { ok: true, data: data as T } : { ok: false, error: errorText(r.status, data) }
  } catch { return { ok: false, error: 'Could not reach the server.' } }
}
export const createWorld = (name: string, color: string, repos: string[] = []) => api<{ world: World }>('POST', '/api/worlds', { name, color, repos })
export const updateWorld = (id: string, patch: Partial<Pick<World, 'name' | 'color' | 'repos' | 'leadSpawn' | 'maxSpawned'>>) => api<{ world: World }>('PATCH', `/api/worlds/${encodeURIComponent(id)}`, patch)
/** Moves one session to world `worldId` (its repo stays put); the server clears the move when that is its folder's world. */
export const moveSession = (id: string, worldId: string | null) => api<unknown>('POST', `/api/sessions/${encodeURIComponent(id)}/world`, { worldId })
export const deleteWorld = (id: string) => api<unknown>('DELETE', `/api/worlds/${encodeURIComponent(id)}`)
export const reorderWorlds = (ids: string[]) => api<unknown>('POST', '/api/worlds/order', { ids })
export const browseFs = (path: string) => api<FsListing>('GET', `/api/fs?path=${encodeURIComponent(path)}`)
export const phoneInfo = () => api<PhoneInfo>('GET', '/api/phone')
export const allowPhones = (address: string, allow: boolean) => api<unknown>('POST', '/api/phone/allow', { address, allow })
export const uploadFile = (id: string, f: File) => api<{ path: string }>('POST', `${base(id)}/upload?name=${encodeURIComponent(f.name)}`, f)
/** Quits its agent and closes its terminal; `force` once you said yes to cutting a turn short. */
export const endSession = (id: string, force = false) => api<unknown>('POST', `${base(id)}/end`, { force })
export const renameSession = (id: string, label: string) => api<unknown>('POST', `${base(id)}/label`, { label })
export const restartSession = (id: string, force = false) => api<unknown>('POST', `${base(id)}/restart`, { force })
/** Sessions to restart once their turn ends. Kept here, not in the panel, so closing the panel keeps them. */
export const restartQueued = reactive(new Set<string>())
watch(() => [...restartQueued].map((id) => [id, state.sessions[id]?.state] as const), async (list) => {
  for (const [id, st] of list) {
    if (st === 'working' || st === 'waiting') continue // waiting: a question for you would be lost
    if (!restartQueued.delete(id)) continue // another watcher run already claimed it while this one awaited
    const s = state.sessions[id]
    if (!s) { showToast('A queued restart was dropped: that conversation ended or was cleared before its turn did.'); continue }
    const r = await restartSession(id)
    showToast(r.ok ? `Restarting ${s.repoName} now that its turn ended.` : `Could not restart ${s.repoName}: ${r.error}`)
  }
})
/** Starts another agent in the session's folder with a handoff as its first message; follows the new session. */
export async function continueIn(id: string, agent: string): Promise<string | null> {
  const r = await api<{ tmuxSession: string; handoff: string }>('POST', `${base(id)}/continue`, { agent })
  if (!r.ok) return r.error
  followNew(r.data.tmuxSession)
  return null
}
export const startRun = (body: { worldId: string; repo: string; task: string; worktree: boolean; steps: { kind: StepKind; agent: string; checkpoint: boolean }[]; codexUnrestricted?: boolean }) => api<{ run: Run }>('POST', '/api/runs', body)
export const runNext = (id: string) => api<{ run: Run }>('POST', `/api/runs/${encodeURIComponent(id)}/next`)
export const runStop = (id: string, endSessions = false) => api<{ run: Run }>('POST', `/api/runs/${encodeURIComponent(id)}/stop`, { endSessions })
export const sessionConversation = (id: string) => api<{ turns: Turn[] }>('GET', `${base(id)}/history`)
export const accessLog = () => api<AccessInfo>('GET', '/api/access')
export const setPassword = (password: string) => api<unknown>('POST', '/api/password', { password })
export const clearPassword = () => api<unknown>('DELETE', '/api/password')
export const installCloudflared = () => api<unknown>('POST', '/api/cloudflared/install')
export const setTunnel = (on: boolean) => api<{ url: string | null }>('POST', '/api/tunnel', { on })
export const pairPhone = (address: string) => api<{ url: string; expiresAt: number }>('POST', '/api/phone/pair', { address })

export type Scope = 'once' | 'repo' | 'world' | 'all'
export const decidePermission = (id: string, requestId: string, decision: 'allow' | 'deny', scope: Scope = 'once') =>
  post(`${base(id)}/permission`, { requestId, decision, scope })
export const sendInput = (id: string, text: string) => post(`${base(id)}/input`, { text })
/** Sends a slash command to a session and says so, since nothing else on screen changes. */
export async function askClaude(id: string, repoName: string, command: string): Promise<boolean> {
  const ok = await sendInput(id, command)
  if (ok) showToast(`Asked ${repoName} to ${command}`)
  return ok
}
export interface NewTask { worldId: string; repo: string; task: string; worktree: boolean; branch?: string; permissionMode?: PermissionMode; codexUnrestricted?: boolean; agent?: string; provider?: string; model?: string }
export interface AgentInfo { id: string; name: string; installed: boolean; modes: boolean; decides?: boolean; task?: boolean; models?: boolean }
/** Agent id -> the models leads may start it on ([] for any); an agent left out is off. null: every agent, any model. */
export type SpawnAgents = Record<string, string[]> | null
/** The agent CLIs this server can start, and which one new sessions use by default. Cached (a page asks from several places); failures are not cached, so a later try can succeed. */
let agentsCache: Promise<ApiResult<{ agents: AgentInfo[]; default: string; spawn?: SpawnAgents }>> | null = null
export function fetchAgents(fresh = false): Promise<ApiResult<{ agents: AgentInfo[]; default: string; spawn?: SpawnAgents }>> {
  if (fresh) agentsCache = null
  agentsCache ??= api<{ agents: AgentInfo[]; default: string; spawn?: SpawnAgents }>('GET', '/api/agents').then((r) => { if (!r.ok) agentsCache = null; return r })
  return agentsCache
}
/** Model providers a Qwen session can use instead of the user's ~/.qwen setup. Keys are never sent back, only whether one is saved. */
export interface ProviderInfo { id: string; name: string; model: string; keyUrl?: string; hasKey: boolean; custom?: boolean; baseUrl?: string }
export const fetchProviders = () => api<{ providers: ProviderInfo[]; default: string | null }>('GET', '/api/providers')
export const saveDefaultProvider = (provider: string) => api<{ default: string | null }>('POST', '/api/providers/default', { provider })
/** A server of the user's own that speaks the OpenAI API; with no model, the server is asked for one. */
export const addServer = (s: { name: string; baseUrl: string; model?: string; key?: string }) => api<{ provider: ProviderInfo }>('POST', '/api/providers', s)
export const removeServer = (id: string) => api<object>('DELETE', `/api/providers/${id}`)
export const saveProviderKey = (id: string, key: string | null) => api<{ hasKey: boolean }>('PUT', `/api/providers/${id}/key`, { key })
export const saveDefaultAgent = (agent: string) => {
  agentsCache = null // the default (and anything else the server changed) is refetched next time
  return api<{ default: string }>('POST', '/api/agents/default', { agent })
}

/** The agents and models leads may start workers on, as Manage worlds shows them: changed at once, saved in click order. */
export const spawnRules = ref<SpawnAgents>(null)
/** Bumped when a save fails, so inputs showing the refused value are drawn again from spawnRules. */
export const spawnFailures = ref(0)
/** The rules as the server last confirmed them (its own, normalised copy): each save says it was built on these. */
let spawnSaved: SpawnAgents = null, spawnSaving: Promise<unknown> = Promise.resolve(), spawnChanges = 0, spawnPending = 0
/** The rules as the server has them, unless a save from here is still on its way. */
export function loadSpawnRules(spawn: SpawnAgents) {
  if (spawnPending) return
  spawnRules.value = spawnSaved = spawn
}
/**
 * Shows `spawn` at once and saves it after any save still in flight, so quick clicks each build on the one before
 * instead of on what the server last answered. Each save names, as it goes out, the rules the server last confirmed:
 * if another window changed them since, the server refuses (409) and sends its own, which are shown. A failed save
 * puts back the last saved rules unless a newer change came since.
 */
export function saveSpawnAgents(spawn: SpawnAgents): Promise<ApiResult<{ spawn: SpawnAgents }>> {
  const change = ++spawnChanges
  spawnRules.value = spawn
  spawnPending++
  agentsCache = null
  const saved = spawnSaving.then(async () => {
    const r = await fetch('/api/agents/spawn', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spawn, base: spawnSaved }) }).catch(() => null)
    const data = r ? await r.json().catch(() => null) as { spawn?: SpawnAgents; error?: string } | null : null
    spawnPending--
    if (r?.ok) {
      spawnSaved = data?.spawn ?? null
      if (change === spawnChanges) spawnRules.value = spawnSaved // the server's copy (models deduplicated)
      return { ok: true as const, data: { spawn: spawnSaved } }
    }
    if (r?.status === 409 && data && 'spawn' in data) spawnSaved = data.spawn ?? null
    if (change === spawnChanges || r?.status === 409) { spawnRules.value = spawnSaved; spawnFailures.value++ }
    return { ok: false as const, error: r ? errorText(r.status, data) : 'Could not reach the server.' }
  })
  spawnSaving = saved
  return saved
}

/** Moves a repo out of the world that owns it and into `toId` (two PATCHes). Puts the old world back if the second fails. */
export async function moveRepo(path: string, fromId: string, toId: string): Promise<string | null> {
  const [rm, add] = moveRepoPatches(state.worlds, path, fromId, toId)
  if (!rm || !add) return 'That world no longer exists.'
  const original = state.worlds.find((w) => w.id === fromId)!.repos
  const a = await updateWorld(rm.id, { repos: rm.repos })
  if (!a.ok) return a.error
  const b = await updateWorld(add.id, { repos: add.repos })
  if (b.ok) return null
  await updateWorld(rm.id, { repos: original })
  return b.error
}
/** Claude Code's own permission mode on this computer (null when unset or unknown). */
export async function fetchClaudeDefault(): Promise<string | null> {
  const r = await api<{ permissionMode: string | null }>('GET', '/api/claude-defaults')
  return r.ok ? r.data.permissionMode ?? null : null
}
/** Returns null on success, else a message to show the user. */
/** Selects the session running in tmux session `name` as soon as it shows up (or now, if it already has). */
function followNew(name: unknown): void {
  if (typeof name !== 'string') return
  state.pending = { tmux: name, until: Date.now() + 60000 }
  const known = Object.values(state.sessions).find((x) => (x.tmux?.session ?? x.direct) === name)
  if (known) { state.pending = null; showFollowed(known.id) } // upsert beat the HTTP response
}
/** Opens a past session in a new tmux session here. `stop` first quits the copy still open in another terminal. */
export async function resumeSession(sessionId: string, stop = false, permissionMode?: PermissionMode, agent?: AgentId, codexUnrestricted = true): Promise<ResumeResult> {
  try {
    const r = await fetch('/api/sessions/resume', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, ...(agent ? { agent } : {}), ...(stop ? { stop: true } : {}), ...(permissionMode ? { permissionMode } : {}), ...(agent === 'codex' ? { codexUnrestricted } : {}) }) })
    let body: unknown = null
    try { body = await r.json() } catch { /* empty body */ }
    const res = resumeOutcome(r.status, body)
    if (res.kind === 'ok') followNew(res.tmuxSession)
    return res
  } catch { return { kind: 'error', message: 'Could not reach the server.' } }
}
export async function resumeAll(): Promise<{ started: string[]; failed: { id: string; error: string }[] } | null> {
  const r = await api<{ started: string[]; failed: { id: string; error: string }[] }>('POST', '/api/sessions/resume-all')
  if (!r.ok) { showToast(r.error); return null }
  state.recoverable = state.recoverable.filter((s) => !r.data.started.includes(s.id))
  return r.data
}
export async function dismissRecovery(id: string): Promise<boolean> {
  const r = await api<{ ok: true }>('DELETE', `/api/recovery/${encodeURIComponent(id)}`)
  if (!r.ok) { showToast(r.error); return false }
  state.recoverable = state.recoverable.filter((s) => s.id !== id)
  return true
}
export const fetchHistory = (repo?: string) => api<{ sessions: HistorySession[] }>('GET', `/api/history?limit=200${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`)

export async function createSession(body: NewTask): Promise<string | null> {
  try {
    const r = await fetch('/api/sessions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (r.ok) {
      try { followNew((await r.json()).tmuxSession) } catch { /* body optional */ }
      return null
    }
    let err: unknown = null
    try { err = await r.json() } catch { /* not json */ }
    return errorText(r.status, err)
  } catch { return 'Could not reach the server.' }
}
export const answerQuestions = (id: string, requestId: string, answers: Record<string, string>) =>
  post(`${base(id)}/answer`, { requestId, answers })
export const requestCatchup = (id: string) => post(`${base(id)}/catchup`)
export const acknowledge = (id: string) => post(`${base(id)}/ack`)

// ---- websocket with backoff ----
let ws: WebSocket | null = null
let retry = 0
/** Set once the server accepted "Update now": the next connection is the new server, so load the new page. */
let reloadOnConnect = false
/** Restarts the server into the newer code on disk; the page reloads when it is back. Returns an error or null. */
export async function updateNow(force = false): Promise<string | null> {
  const r = await api<{ ok: true }>('POST', '/api/restart', { force })
  if (!r.ok) return r.error
  reloadOnConnect = true
  return null
}
let timer: ReturnType<typeof setTimeout> | undefined
export const backoffMs = (n: number): number => Math.min(15000, 500 * 2 ** n)

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)
  ws.onopen = () => { retry = 0; state.connected = true; if (reloadOnConnect) location.reload() }
  ws.onmessage = (e) => {
    let m: ServerMessage
    try { m = JSON.parse(String(e.data)) as ServerMessage } catch { return /* ignore a malformed frame */ }
    const waiting = state.pending
    const a = applyMessage(state, m)
    if (waiting && !state.pending && state.selectedId) showFollowed(state.selectedId)
    // the selected terminal's next session never came: select another once the wait is over
    if (m.type === 'session-removed' && state.pending) setTimeout(() => keepSelection(state), state.pending.until - Date.now() + 50)
    if (a) alertNeedsYou(a, groups.value.findIndex((g) => g.world === worldOf(a)), worldOf(a)?.name ?? '')
  }
  ws.onclose = () => {
    state.connected = false
    clearTimeout(timer)
    timer = setTimeout(connect, backoffMs(retry++))
  }
  ws.onerror = () => ws?.close()
}
/** Every time on screen is in minutes, so 15 s is close enough and keeps hundreds of rows from redrawing every 5 s. */
export function startClock(): void { setInterval(() => { state.now = Date.now() }, 15000) }

/** Bumped to ask the terminal panel to scroll into view and take focus. */
export const termFocusTick = ref(0)
/** A person clicked in a room: their terminal; in the Full height layout, wherever you work (their chat when Conversation is shown). */
export const openSession = (id: string): void => {
  const s = lookup(id)
  if (ui.layout === 'full' && ui.pane === 'chat' && s && !s.ghost) return openChat(id)
  select(id)
  if (s?.tmux || s?.direct) focusTerminal()
}
export const focusTerminal = (): void => { ui.pane = 'term'; termFocusTick.value++ }
/** Bumped to ask the page to show the selected session's chat (on a phone: open it in the Chats tab). */
export const chatTick = ref(0)
/** True while you work through requests with Next/Skip: answering one then opens the next. A chat opened from the list is for reading, so it stays. */
export const chatRun = ref(false)
export const openChat = (id: string, run = false): void => { chatRun.value = run; select(id); ui.pane = 'chat'; chatTick.value++ }
/** Cards you skipped with "Skip" in a chat: Next stops offering them (a new card from that session is offered again). */
export const skipped = reactive(new Set<string>())
watch(() => needsYou.value.map(cardKey), (keys) => {
  const live = new Set(keys)
  for (const k of skipped) if (!live.has(k)) skipped.delete(k)
})
/** A session you just started or resumed: shown where you were looking, its chat or its terminal. */
const showFollowed = (id: string): void => { if (ui.pane === 'chat') openChat(id); else { select(id); focusTerminal() } }

/** layout: 'stacked' is the original page; 'full' puts the world beside the terminal/chat at full height, with Needs you in a floating panel.
 *  split: the world's share (%) of the width when side by side. */
type Views = { left: 'world' | 'chats'; pane: 'term' | 'chat'; worldDesign: 'classic' | 'illustrated'; layout: 'stacked' | 'full'; split: number }
export const clampSplit = (n: number): number => Math.min(75, Math.max(25, Math.round(n)))
function savedViews(): Views {
  try {
    const v = JSON.parse(localStorage.getItem('aw-views') ?? '{}') as Partial<Views>
    return { left: v.left === 'chats' ? 'chats' : 'world', pane: v.pane === 'chat' ? 'chat' : 'term', worldDesign: v.worldDesign === 'illustrated' ? 'illustrated' : 'classic', layout: v.layout === 'stacked' ? 'stacked' : 'full', split: typeof v.split === 'number' && isFinite(v.split) ? clampSplit(v.split) : 45 }
  } catch { return { left: 'world', pane: 'term', worldDesign: 'classic', layout: 'full', split: 45 } }
}

/** Dialog state shared by the header, rooms and detail panel. */
/** recentRepo: Recent sessions shows only that repo's (its folder and worktrees); null shows all. */
export const ui = reactive({ ...savedViews(), worldsOpen: false,
  /** The selected session's chat, slid in from the right (opened from a person's card in a room). */
  chatDrawer: false,
  /** The one person whose card is open, in whichever room they are. */
  card: null as string | null,
  /** Full height layout: the floating Needs you and details panel. */
  needsOpen: false, putSession: null as string | null, recentOpen: false, recentRepo: null as string | null, phoneOpen: false, moveSession: null as string | null,
  /** A character being dragged to another room: where the pointer is, and the world under it. */
  drag: null as { id: string; x: number; y: number; over: string | null } | null })
watch(() => [ui.left, ui.pane, ui.worldDesign, ui.layout, ui.split], () => { try { localStorage.setItem('aw-views', JSON.stringify({ left: ui.left, pane: ui.pane, worldDesign: ui.worldDesign, layout: ui.layout, split: ui.split })) } catch { /* private window: not remembered */ } })
