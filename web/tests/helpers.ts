import type { Session } from '../src/types'

export function mk(id: string, over: Partial<Session> = {}): Session {
  return {
    id, worldId: 'web', repo: `/r/${id}`, repoName: id, cwd: `/r/${id}`, branch: 'main', worktree: false,
    tmux: { session: id, pane: '%1' }, state: 'working', waitingSince: null, task: null, now: '', log: [],
    helpers: [], card: null, startedAt: 0, updatedAt: 0, ...over,
  }
}
export const perm = { kind: 'permission', requestId: 'r', tool: 'Bash', command: 'ls', input: {}, risky: null, seenCount: 0 } as const
