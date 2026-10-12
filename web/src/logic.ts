import type { Session, SessionState, World, RoomGroup, Card } from './types'

export const NEEDS_YOU: SessionState[] = ['waiting', 'done', 'error']
export const UNSORTED: World = { id: '__unsorted', name: 'Unsorted', color: '#8a92a0', repos: [] }
const CARD_RANK: Record<string, number> = { permission: 0, question: 1, error: 2, done: 3 }

export const LABEL: Record<SessionState, string> = {
  working: 'Working', waiting: 'Needs you', done: 'Done', error: 'Error', idle: 'Idle',
}

/** When did this session start needing the user? Falls back to updatedAt for cards without a waiting time. */
export const since = (s: Session): number => s.waitingSince ?? s.updatedAt

export const waitMinutes = (s: Session, now: number): number =>
  Math.max(0, Math.floor((now - since(s)) / 60000))

export const fmtWait = (min: number): string => (min < 1 ? 'waiting <1 min' : `waiting ${min} min`)

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

/** On-screen order used for the 1-9 keys. */
export const screenOrder = (groups: RoomGroup[]): Session[] => groups.flatMap((g) => g.sessions)

/** Next session in the queue after `currentId`, wrapping; null when the queue is empty. */
export function nextNeedingYou(q: Session[], currentId: string | null): Session | null {
  if (!q.length) return null
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
  | { kind: 'new-task' } | { kind: 'mute' } | null

/** Decides what a keypress means. Never claims a key while the user is typing (or in the terminal). */
export function routeKey(k: KeyInfo): KeyAction {
  if (k.ctrl || k.meta || k.alt) return null
  if (k.key === 'Escape') return k.overlayOpen ? { kind: 'escape' } : null
  if (k.typing) return null
  if (k.key === ' ') return k.onControl ? null : { kind: 'next' }
  if (k.key === '?') return { kind: 'help' }
  if (k.key === 'n' || k.key === 'N') return { kind: 'new-task' }
  if (k.key === 'm' || k.key === 'M') return { kind: 'mute' }
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

/** Which "Always allow" scopes are usable for a permission card. `Everywhere` is refused for risky commands. */
export function scopeAvailability(c: Extract<Card, { kind: 'permission' }>): { repo: boolean; world: boolean; all: boolean; allReason: string | null } {
  return { repo: true, world: true, all: !c.risky, allReason: c.risky ? `Not offered: this command ${c.risky}.` : null }
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

/** Caps rendered diff lines; `hidden` is how many were left out. */
export function capDiff(diff: string, max = 400, all = false): { lines: string[]; hidden: number } {
  const lines = diff.split('\n')
  if (all || lines.length <= max) return { lines, hidden: 0 }
  return { lines: lines.slice(0, max), hidden: lines.length - max }
}
export const diffClass = (l: string): string => (l.startsWith('@@') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '')

/** 0 none, 1 getting heavy (>=50), 2 nearly full (>=80). */
export const ctxLevel = (pct: number): 0 | 1 | 2 => (pct >= 80 ? 2 : pct >= 50 ? 1 : 0)

export const baseName = (p: string): string => p.replace(/\/+$/, '').split('/').pop() || p

/** Permission/question cards the GUI can answer. `live:false` means only the terminal can (no GUI was connected, or the hold timed out). */
export const cardLive = (c: Card): boolean => !((c.kind === 'permission' || c.kind === 'question') && c.live === false)

/** Server errors are `{error}`; some routes use `{message}`. */
export function errorText(status: number, body: unknown): string {
  const b = (body ?? {}) as { error?: unknown; message?: unknown }
  const t = typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : ''
  return t || `Request failed (${status}).`
}
