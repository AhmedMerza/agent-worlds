import { reactive, computed, ref } from 'vue'
import type { ServerMessage, Session, World } from './types'
import { alertNeedsYou } from './notify'
import { errorText, groupSessions, queue, screenOrder, nextNeedingYou, startsNeedingYou } from './logic'

export interface StoreState {
  worlds: World[]
  sessions: Record<string, Session>
  /** Insertion order of session ids (stable on-screen order). */
  order: string[]
  loaded: boolean
  connected: boolean
  selectedId: string | null
  toast: { text: string; n: number } | null
  filter: string
  now: number
  /** A session we just asked the server to start; selected when its upsert arrives. */
  pending: { tmux: string; until: number } | null
}

export const newState = (): StoreState => ({
  worlds: [], sessions: {}, order: [], loaded: false, connected: false,
  selectedId: null, toast: null, filter: 'all', now: Date.now(), pending: null,
})

/** Applies one server message to the state. Pure aside from mutating `st`. */
/** True (and clears the wait) when `s` is the session we are waiting for; gives up after the deadline. */
export function claimPending(st: StoreState, s: Session, now = Date.now()): boolean {
  if (!st.pending) return false
  if (now > st.pending.until) { st.pending = null; return false }
  if (s.tmux?.session !== st.pending.tmux) return false
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
      st.loaded = true
      break
    case 'session':
      if (claimPending(st, msg.session)) st.selectedId = msg.session.id
      if (startsNeedingYou(st.sessions[msg.session.id], msg.session)) alert = msg.session
      if (!st.sessions[msg.session.id]) st.order.push(msg.session.id)
      st.sessions[msg.session.id] = msg.session
      break
    case 'session-removed':
      delete st.sessions[msg.id]
      st.order = st.order.filter((i) => i !== msg.id)
      break
    case 'toast':
      st.toast = { text: msg.text, n: (st.toast?.n ?? 0) + 1 }
      break
  }
  // Keep the selection valid: default to the oldest session needing you, else the first one.
  if (!st.selectedId || !st.sessions[st.selectedId]) {
    const list = st.order.map((i) => st.sessions[i])
    st.selectedId = (queue(list)[0] ?? list[0])?.id ?? null
  }
  return alert
}

export const state = reactive<StoreState>(newState())
export const sessionList = computed(() => state.order.map((i) => state.sessions[i]))
export const groups = computed(() => groupSessions(state.worlds, sessionList.value))
export const screenSessions = computed(() => screenOrder(groups.value))
export const needsYou = computed(() => queue(sessionList.value))
export const selected = computed(() => (state.selectedId ? state.sessions[state.selectedId] ?? null : null))

export const select = (id: string): void => {
  state.selectedId = id
  const s = state.sessions[id]
  if (state.filter !== 'all' && s) {
    const g = groups.value.find((g) => g.sessions.includes(s))
    if (g && g.world.id !== state.filter) state.filter = g.world.id
  }
}
export const selectNext = (): boolean => {
  const n = nextNeedingYou(needsYou.value, state.selectedId)
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
export type Scope = 'once' | 'repo' | 'world' | 'all'
export const decidePermission = (id: string, requestId: string, decision: 'allow' | 'deny', scope: Scope = 'once') =>
  post(`${base(id)}/permission`, { requestId, decision, scope })
export const sendInput = (id: string, text: string) => post(`${base(id)}/input`, { text })
export interface NewTask { worldId: string; repo: string; task: string; worktree: boolean; branch?: string }
/** Returns null on success, else a message to show the user. */
export async function createSession(body: NewTask): Promise<string | null> {
  try {
    const r = await fetch('/api/sessions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (r.ok) {
      try {
        const j = await r.json()
        if (typeof j.tmuxSession === 'string') {
          state.pending = { tmux: j.tmuxSession, until: Date.now() + 60000 }
          const known = Object.values(state.sessions).find((x) => x.tmux?.session === j.tmuxSession)
          if (known) { state.pending = null; select(known.id); focusTerminal() } // upsert beat the HTTP response
        }
      } catch { /* body optional */ }
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
let timer: ReturnType<typeof setTimeout> | undefined
export const backoffMs = (n: number): number => Math.min(15000, 500 * 2 ** n)

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  ws = new WebSocket(`${proto}://${location.host}/ws`)
  ws.onopen = () => { retry = 0; state.connected = true }
  ws.onmessage = (e) => {
    let m: ServerMessage
    try { m = JSON.parse(String(e.data)) as ServerMessage } catch { return /* ignore a malformed frame */ }
    const waiting = state.pending
    const a = applyMessage(state, m)
    if (waiting && !state.pending && state.selectedId) { select(state.selectedId); focusTerminal() }
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
