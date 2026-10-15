import { reactive, computed, ref } from 'vue'
import type { ServerMessage, Session, World, FsListing, PhoneInfo, AccessInfo, Turn, Unmanaged, HistorySession, PermissionMode } from './types'
import { moveRepoPatches } from './fsbrowser'
import { alertNeedsYou } from './notify'
import { errorText, ghostId, ghostSession, resumeOutcome, type ResumeResult, groupSessions, queue, screenOrder, nextNeedingYou, startsNeedingYou } from './logic'

export interface StoreState {
  worlds: World[]
  sessions: Record<string, Session>
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
}

export const newState = (): StoreState => ({
  worlds: [], sessions: {}, order: [], loaded: false, connected: false,
  selectedId: null, autoSelected: false, toast: null, filter: 'all', now: Date.now(), pending: null, unmanaged: [], update: false, tmux: true,
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
      for (const s of msg.sessions) { st.sessions[s.id] = s; st.order.push(s.id) }
      st.unmanaged = msg.unmanaged ?? []
      st.update = msg.update ?? false
      st.tmux = msg.tmux ?? true
      st.loaded = true
      break
    case 'unmanaged':
      st.unmanaged = msg.unmanaged
      break
    case 'session':
      if (claimPending(st, msg.session)) { st.selectedId = msg.session.id; st.autoSelected = false }
      if (startsNeedingYou(st.sessions[msg.session.id], msg.session)) alert = msg.session
      if (!st.sessions[msg.session.id]) st.order.push(msg.session.id)
      st.sessions[msg.session.id] = msg.session
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
/** Rooms hold the real sessions plus the ghosts of unmanaged ones. */
export const groups = computed(() => groupSessions(state.worlds, [...sessionList.value, ...ghosts.value]))
export const screenSessions = computed(() => screenOrder(groups.value))
export const needsYou = computed(() => queue(sessionList.value))
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
  if (state.filter !== 'all' && s) {
    const g = groups.value.find((g) => g.sessions.includes(s))
    if (g && g.world.id !== state.filter) state.filter = g.world.id
  }
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
export const updateWorld = (id: string, patch: Partial<Pick<World, 'name' | 'color' | 'repos'>>) => api<{ world: World }>('PATCH', `/api/worlds/${encodeURIComponent(id)}`, patch)
/** Moves one session to world `worldId` (its repo stays put); the server clears the move when that is its folder's world. */
export const moveSession = (id: string, worldId: string | null) => api<unknown>('POST', `/api/sessions/${encodeURIComponent(id)}/world`, { worldId })
export const deleteWorld = (id: string) => api<unknown>('DELETE', `/api/worlds/${encodeURIComponent(id)}`)
export const reorderWorlds = (ids: string[]) => api<unknown>('POST', '/api/worlds/order', { ids })
export const browseFs = (path: string) => api<FsListing>('GET', `/api/fs?path=${encodeURIComponent(path)}`)
export const phoneInfo = () => api<PhoneInfo>('GET', '/api/phone')
export const allowPhones = (address: string, allow: boolean) => api<unknown>('POST', '/api/phone/allow', { address, allow })
export const uploadFile = (id: string, f: File) => api<{ path: string }>('POST', `${base(id)}/upload?name=${encodeURIComponent(f.name)}`, f)
export const restartSession = (id: string, force = false) => api<unknown>('POST', `${base(id)}/restart`, { force })
/** Starts another agent in the session's folder with a handoff as its first message; follows the new session. */
export async function continueIn(id: string, agent: string): Promise<string | null> {
  const r = await api<{ tmuxSession: string; handoff: string }>('POST', `${base(id)}/continue`, { agent })
  if (!r.ok) return r.error
  followNew(r.data.tmuxSession)
  return null
}
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
export interface NewTask { worldId: string; repo: string; task: string; worktree: boolean; branch?: string; permissionMode?: PermissionMode; agent?: string }
export interface AgentInfo { id: string; name: string; installed: boolean; modes: boolean; decides?: boolean; task?: boolean }
/** The agent CLIs this server can start, and which one new sessions use by default. Cached (a page asks from several places); failures are not cached, so a later try can succeed. */
let agentsCache: Promise<ApiResult<{ agents: AgentInfo[]; default: string }>> | null = null
export function fetchAgents(): Promise<ApiResult<{ agents: AgentInfo[]; default: string }>> {
  agentsCache ??= api<{ agents: AgentInfo[]; default: string }>('GET', '/api/agents').then((r) => { if (!r.ok) agentsCache = null; return r })
  return agentsCache
}
export const saveDefaultAgent = (agent: string) => {
  agentsCache = null // the default (and anything else the server changed) is refetched next time
  return api<{ default: string }>('POST', '/api/agents/default', { agent })
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
  if (known) { state.pending = null; select(known.id); focusTerminal() } // upsert beat the HTTP response
}
/** Opens a past session in a new tmux session here. `stop` first quits the copy still open in another terminal. */
export async function resumeSession(sessionId: string, stop = false, permissionMode?: PermissionMode): Promise<ResumeResult> {
  try {
    const r = await fetch('/api/sessions/resume', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, ...(stop ? { stop: true } : {}), ...(permissionMode ? { permissionMode } : {}) }) })
    let body: unknown = null
    try { body = await r.json() } catch { /* empty body */ }
    const res = resumeOutcome(r.status, body)
    if (res.kind === 'ok') followNew(res.tmuxSession)
    return res
  } catch { return { kind: 'error', message: 'Could not reach the server.' } }
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
    if (waiting && !state.pending && state.selectedId) { select(state.selectedId); focusTerminal() }
    // the selected terminal's next session never came: select another once the wait is over
    if (m.type === 'session-removed' && state.pending) setTimeout(() => keepSelection(state), state.pending.until - Date.now() + 50)
    if (a) alertNeedsYou(a, groups.value.findIndex((g) => g.sessions.some((x) => x.id === a.id)), groups.value.find((g) => g.sessions.some((x) => x.id === a.id))?.world.name ?? '')
  }
  ws.onclose = () => {
    state.connected = false
    clearTimeout(timer)
    timer = setTimeout(connect, backoffMs(retry++))
  }
  ws.onerror = () => ws?.close()
}
export function startClock(): void { setInterval(() => { state.now = Date.now() }, 5000) }

/** Bumped to ask the terminal panel to scroll into view and take focus. */
export const termFocusTick = ref(0)
export const focusTerminal = (): void => { termFocusTick.value++ }

/** Dialog state shared by the header, rooms and detail panel. */
/** recentRepo: Recent sessions shows only that repo's (its folder and worktrees); null shows all. */
export const ui = reactive({ worldsOpen: false, putSession: null as string | null, recentOpen: false, recentRepo: null as string | null, phoneOpen: false, moveSession: null as string | null,
  /** A character being dragged to another room: where the pointer is, and the world under it. */
  drag: null as { id: string; x: number; y: number; over: string | null } | null })
