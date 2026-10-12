// Server contract (see team ledger "Contracts"). Fields marked v2/v3 may be null/empty until later rounds.
export type SessionState = 'working' | 'waiting' | 'done' | 'error' | 'idle'

export interface World { id: string; name: string; color: string; repos: string[] }
export interface LogLine { t: number; text: string }
export interface Helper { id: string; task: string; state: 'working' | 'done'; startedAt: number }

export interface QuestionOption { label: string; description?: string }
export interface Question { question: string; header?: string; multiSelect: boolean; options: QuestionOption[] }

export interface ReviewFile { path: string; added: number; deleted: number }
export interface Review { files: ReviewFile[]; diff: string; tests: { command: string; ok: boolean; line: string } | null }

export type Card =
  | { kind: 'permission'; requestId: string; tool: string; command: string | null; input: unknown; risky: string | null; seenCount: number }
  | { kind: 'question'; requestId: string; questions: Question[] }
  | { kind: 'done'; summary: string | null; review?: Review | null }
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
  catchup?: { asked: string; did: string; needs: string } | null
  context?: { used: number; limit: number; pct: number } | null
  conflicts?: { withId: string; reason: string }[]
  startedAt: number
  updatedAt: number
}

export type ServerMessage =
  | { type: 'snapshot'; worlds: World[]; sessions: Session[] }
  | { type: 'session'; session: Session }
  | { type: 'session-removed'; id: string }
  | { type: 'toast'; text: string }

export interface RoomGroup { world: World; sessions: Session[] }
