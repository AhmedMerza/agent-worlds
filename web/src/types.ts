// Server contract (see team ledger "Contracts"). Fields marked v2/v3 may be null/empty until later rounds.
export type SessionState = 'starting' | 'working' | 'waiting' | 'done' | 'error' | 'idle'

export interface World { id: string; name: string; color: string; repos: string[] }
export interface LogLine { t: number; text: string }
export interface Helper { id: string; task: string; state: 'working' | 'done'; startedAt: number }

export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; multiSelect: boolean; options: QuestionOption[] }

export interface ReviewFile { path: string; added: number; deleted: number }
export interface ReviewCommit { sha: string; subject: string }
/** files = changed since the session started (vs baseSha); commits = made since then; uncommitted = still in the working tree. */
export interface Review { dir?: string; branch?: string | null; elsewhere?: boolean; baseSha: string | null; files: ReviewFile[]; commits: ReviewCommit[]; uncommitted: ReviewFile[]; diff: string; tests: { command: string; ok: boolean; line: string } | null }

export interface PermissionTarget { type: 'command' | 'file' | 'url' | 'other'; value: string }

export type Card =
  | { kind: 'permission'; requestId: string; tool: string; command: string | null; target?: PermissionTarget; input: unknown; risky: string | null; everywhere?: string | null; seenCount: number; live?: boolean; ambiguous?: boolean }
  | { kind: 'question'; requestId: string; questions: Question[]; live?: boolean }
  | { kind: 'done'; summary: string | null; review?: Review | null }
  | { kind: 'asking'; summary: string }
  | { kind: 'error'; summary: string }

export interface Session {
  id: string
  worldId: string | null
  repo: string
  repoName: string
  /** The CLI the session runs; absent from servers older than agent support. */
  agent?: string
  /** Qwen's model provider and model, when one was picked in New session */
  via?: string | null
  cwd: string
  branch: string | null
  worktree: boolean
  tmux: { session: string; pane: string } | null
  /** The server runs this session itself (no tmux): the name of its terminal. */
  direct?: string | null
  /** Your name for it, shown instead of the repo name. */
  label?: string | null
  /** The session that started this one with aw_spawn (its lead). */
  parent?: string | null
  state: SessionState
  /** Busy, but not needing you (state stays 'working'): compacting, or background work runs on after the turn. */
  busy?: { kind: 'compact' } | { kind: 'background'; tasks: number; nextAt: number | null } | null
  waitingSince: number | null
  task: string | null
  now: string
  log: LogLine[]
  helpers: Helper[]
  card: Card | null
  catchup?: { asked: string; did: string | null; needs: string | null } | null
  catchupRunning?: boolean
  catchupAt?: number | null
  /** The session needed you again after the catch-up was written. */
  catchupStale?: boolean
  /** The latest thing you said to it (task is the first). */
  lastPrompt?: string | null
  context?: { used: number; limit: number; pct: number } | null
  conflicts?: { withId: string; reason: string }[]
  startedAt: number
  updatedAt: number
  /** Set only on the drawn stand-in for a Claude running in a plain terminal (never sent by the server). */
  ghost?: Unmanaged
}

/** A Claude process running outside Agent Worlds. */
export interface Unmanaged { pid: number; cwd: string; repo: string | null; worldId: string | null; sessionId: string | null; inTmux: boolean; since: number; lastPrompt?: string | null; lastActivity?: number | null }

export interface HistorySession { sessionId: string; agent?: 'kimi'; cwd: string | null; repo: string | null; worldId: string | null; lastPrompt: string | null; lastActivity: number; running: boolean; managed: boolean }

export type ServerMessage =
  | { type: 'snapshot'; worlds: World[]; sessions: Session[]; unmanaged?: Unmanaged[]; update?: boolean; tmux?: boolean; runs?: Run[] }
  | { type: 'run'; run: Run }
  | { type: 'update' }
  | { type: 'unmanaged'; unmanaged: Unmanaged[] }
  | { type: 'session'; session: Session }
  | { type: 'session-removed'; id: string }
  | { type: 'worlds'; worlds: World[] }
  | { type: 'toast'; text: string }

export type StepKind = 'plan' | 'review-plan' | 'build' | 'review-code'
export interface RunStep { kind: StepKind; agent: string; checkpoint: boolean; status: 'pending' | 'running' | 'handed'; pane?: string | null; direct?: string | null; sessionId: string | null; summary: string | null }
/** One task carried through steps, each a session on its own agent (POST /api/runs). waiting = a checkpoint, or a step that stopped without handing off. */
export interface Run { id: string; task: string; worldId: string; repo: string; dir: string | null; steps: RunStep[]; current: number; rounds?: number; earlier?: Pick<RunStep, 'pane' | 'direct' | 'sessionId'>[]; status: 'running' | 'waiting' | 'done' | 'stopped' | 'failed'; note: string | null; startedAt: number }

export interface RoomGroup { world: World; sessions: Session[] }

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export interface FsEntry { name: string; path: string; isRepo: boolean }
export interface FsListing { path: string; parent: string | null; entries: FsEntry[] }

/** GET /api/phone: addresses a phone could use, and whether phones are allowed on each. */
export type PhoneInfo = { port: number; addresses: { address: string; kind: 'tailscale' | 'lan'; iface: string; allowed: boolean }[]; passwordSet: boolean; cloudflared: boolean; canInstall?: boolean; firewall?: 'firewalld' | 'ufw' | null; lanReached?: boolean; tunnel: string | null }
/** GET /api/sessions/:id/history: the conversation from the transcript, oldest first. */
export type Turn = { who: 'you' | 'claude' | 'step'; text: string }
/** GET /api/access: devices that signed in and every sign-in or failed try, newest first. `you` is this browser's device id. */
export type AccessInfo = {
  devices: { device: string; first: number; last: number; ip: string; route: string; via: string; agent: string }[]
  entries: { at: number; device: string | null; ip: string; route: string; via: string; ok: boolean; agent: string }[]
  you: string | null
}
