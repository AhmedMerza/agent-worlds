import type { FsEntry } from './types'

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
