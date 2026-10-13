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
export interface Review { baseSha: string | null; files: ReviewFile[]; commits: ReviewCommit[]; uncommitted: ReviewFile[]; diff: string; tests: { command: string; ok: boolean; line: string } | null }

export interface PermissionTarget { type: 'command' | 'file' | 'url' | 'other'; value: string }

export type Card =
  | { kind: 'permission'; requestId: string; tool: string; command: string | null; target?: PermissionTarget; input: unknown; risky: string | null; everywhere?: string | null; seenCount: number; live?: boolean }
  | { kind: 'question'; requestId: string; questions: Question[]; live?: boolean }
  | { kind: 'done'; summary: string | null; review?: Review | null }
  | { kind: 'asking'; summary: string }
  | { kind: 'error'; summary: string }

export interface Session {
  id: string
  worldId: string | null
  repo: string
  repoName: string
  cwd: string
  branch: string | null
  worktree: boolean
  tmux: { session: string; pane: string } | null
  state: SessionState
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
export interface Unmanaged { pid: number; cwd: string; repo: string | null; worldId: string | null; sessionId: string | null; inTmux: boolean; since: number }

export interface HistorySession { sessionId: string; cwd: string | null; repo: string | null; worldId: string | null; lastPrompt: string | null; lastActivity: number; running: boolean; managed: boolean }

export type ServerMessage =
  | { type: 'snapshot'; worlds: World[]; sessions: Session[]; unmanaged?: Unmanaged[] }
  | { type: 'unmanaged'; unmanaged: Unmanaged[] }
  | { type: 'session'; session: Session }
  | { type: 'session-removed'; id: string }
  | { type: 'worlds'; worlds: World[] }
  | { type: 'toast'; text: string }

export interface RoomGroup { world: World; sessions: Session[] }

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions'

export interface FsEntry { name: string; path: string; isRepo: boolean }
export interface FsListing { path: string; parent: string | null; entries: FsEntry[] }
