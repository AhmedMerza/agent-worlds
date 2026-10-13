import type { FsEntry, World } from './types'

export interface Crumb { name: string; path: string }

/** "/home/a/b" -> [/, home, a, b] with the path each crumb goes to. */
export function breadcrumbs(path: string): Crumb[] {
  const out: Crumb[] = [{ name: '/', path: '/' }]
  let acc = ''
  for (const part of path.split('/').filter(Boolean)) { acc += '/' + part; out.push({ name: part, path: acc }) }
  return out
}

/** Typed paths: trim, and drop a trailing slash (except for the root). */
export function cleanPath(input: string): string {
  const t = input.trim()
  return t.length > 1 ? t.replace(/\/+$/, '') : t
}

/** Repos first, then alphabetical; dot-folders hidden unless asked for. */
export function visibleEntries(entries: FsEntry[], showHidden = false): FsEntry[] {
  return entries
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .sort((a, b) => Number(b.isRepo) - Number(a.isRepo) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export type RepoStatus = { kind: 'free' } | { kind: 'added' } | { kind: 'elsewhere'; worldId: string; worldName: string }
/** Where a repo stands relative to world `worldId`: already in it, free, or owned by another world. */
export function repoStatus(path: string, worldId: string, worlds: World[]): RepoStatus {
  if (worlds.find((w) => w.id === worldId)?.repos.includes(path)) return { kind: 'added' }
  const o = worlds.find((w) => w.id !== worldId && w.repos.includes(path))
  return o ? { kind: 'elsewhere', worldId: o.id, worldName: o.name } : { kind: 'free' }
}

/** The two PATCH bodies for moving a repo between worlds, in order: remove from the old one, then add to the new one. */
export function moveRepoPatches(worlds: World[], path: string, fromId: string, toId: string): { id: string; repos: string[] }[] {
  const from = worlds.find((w) => w.id === fromId), to = worlds.find((w) => w.id === toId)
  if (!from || !to) return []
  return [{ id: from.id, repos: from.repos.filter((r) => r !== path) }, { id: to.id, repos: to.repos.includes(path) ? to.repos : [...to.repos, path] }]
}

/** Entries whose name holds every word of `q` (any case). */
export function matchEntries(entries: FsEntry[], q: string): FsEntry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? entries.filter((e) => words.every((w) => e.name.toLowerCase().includes(w))) : entries
}
