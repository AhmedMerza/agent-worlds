import type { Capture, CaptureItem, World } from './types'

/** Items still yours to decide on: not filed and not dropped. A cut-off filing ("check") stays until you check it. */
export const OPEN: CaptureItem['status'][] = ['pending', 'filing', 'check']

export type InboxRow = { capture: Capture; item: CaptureItem }
const RECENT_MS = 24 * 3600_000

/**
 * Every open item of every finished capture, newest recording first, in the order it was said.
 * `keep`: items to list whatever their status (the ones you acted on while looking), so a filed one shows its link and a dropped one its Undo.
 */
export function inbox(captures: Record<string, Capture>, except?: string, keep?: Set<string>, now = Date.now()): InboxRow[] {
  // Filed items of a recording from the last day stay listed with their link: what you filed this morning is still here to show.
  const recent = (c: Capture, i: CaptureItem) => i.status === 'filed' && now - c.createdAt < RECENT_MS
  return Object.values(captures)
    .filter((c) => c.status === 'ready' && c.id !== except)
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((capture) => capture.items.filter((i) => OPEN.includes(i.status) || keep?.has(i.id) || recent(capture, i)).map((item) => ({ capture, item })))
}

/** The badge on the Capture button: items waiting on you, plus recordings that failed. */
export function waitingCount(captures: Record<string, Capture>): number {
  let n = 0
  for (const c of Object.values(captures)) {
    if (c.status === 'failed') n++
    else if (c.status === 'ready') n += c.items.filter((i) => i.status === 'pending' || i.status === 'check').length
  }
  return n
}

export const canFile = (item: CaptureItem, repos: string[]): boolean => item.status === 'pending' && !!item.repo && repos.includes(item.repo)

export type RepoOption = { path: string; label: string }
/** One option per repo, labelled by folder and, when two worlds share a folder name, its world too. */
export function repoOptions(worlds: World[]): RepoOption[] {
  const seen = new Map<string, string>()
  for (const w of worlds) for (const r of w.repos) if (!seen.has(r)) seen.set(r, w.name)
  const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p
  const count = new Map<string, number>()
  for (const p of seen.keys()) count.set(base(p), (count.get(base(p)) ?? 0) + 1)
  return [...seen].map(([path, world]) => ({ path, label: count.get(base(path))! > 1 ? `${base(path)} (${world})` : base(path) }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** A file name for a browser recording, from its type: Chrome and Firefox give webm or ogg, Safari mp4. */
export function recordingName(mime: string, now = Date.now()): string {
  const t = mime.toLowerCase()
  const ext = t.includes('mp4') || t.includes('aac') ? 'm4a' : t.includes('ogg') ? 'ogg' : t.includes('wav') ? 'wav' : 'webm'
  return `capture-${now}.${ext}`
}

/** What the capture is doing, for its progress line. */
export function stageText(c: Capture): string {
  if (c.status === 'transcribing') return c.attempts > 1 ? 'Transcribing (second try)…' : 'Transcribing on this computer…'
  if (c.status === 'extracting') return 'Finding the to-dos…'
  if (c.status === 'failed') return c.error ? `Failed: ${c.error}` : 'Failed'
  const open = c.items.filter((i) => OPEN.includes(i.status)).length
  if (!c.items.length) return 'Nothing to file was found in this recording.'
  return open ? `${open} of ${c.items.length} to review` : 'All reviewed'
}

/** m:ss for the recording timer. */
export const clock = (ms: number): string => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
