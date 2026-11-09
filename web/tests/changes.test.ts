import { describe, expect, it } from 'vitest'
import { changeSummary, diffLines, sharedFiles, splitRows } from '../src/logic'
import type { ChangedFile } from '../src/types'
import { mk } from './helpers'

const f = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({ path, status: 'M', added: 1, deleted: 1, uncommitted: true, sig: `sig-${path}`, ...over })
const changes = (...files: ChangedFile[]) => ({ dir: '/d', base: 'b', files, more: 0 })

describe('changes', () => {
  it('summarises a session and counts a stale viewed tick as not viewed', () => {
    const s = mk('a', { changes: changes(f('x.ts', { added: 10, deleted: 2 }), f('y.ts'), f('z.ts')), viewed: { 'x.ts': 'sig-x.ts', 'y.ts': 'old-sig' } })
    expect(changeSummary(s)).toEqual({ files: 3, added: 12, deleted: 4, unseen: 2 })
    expect(changeSummary(mk('b', { changes: changes() }))).toBeNull()
    expect(changeSummary(mk('c'))).toBeNull()
  })

  it('shares files only with sessions of the same repo in another folder', () => {
    const a = mk('a', { repo: '/r', cwd: '/r-wt/a', changes: changes(f('x.ts'), f('y.ts')) })
    const all = {
      a,
      b: mk('b', { repo: '/r', cwd: '/r-wt/b', label: 'fix-login', changes: changes(f('x.ts')) }),
      c: mk('c', { repo: '/r', cwd: '/r-wt/a', changes: changes(f('y.ts')) }), // same folder: not an overlap of files
      d: mk('d', { repo: '/other', cwd: '/other', changes: changes(f('y.ts')) }),
    }
    expect([...sharedFiles(a, all)]).toEqual([['x.ts', ['fix-login']]])
  })

  it('numbers lines and pairs removed with added lines side by side', () => {
    const diff = ['diff --git a/x b/x', 'index 1..2 100644', '--- a/x', '+++ b/x', '@@ -3,3 +3,4 @@ function f', ' keep', '-old', '+new', '+extra', ' end', '\\ No newline at end of file'].join('\n')
    const lines = diffLines(diff)
    expect(lines.map((l) => [l.kind, l.old, l.new, l.text])).toEqual([
      ['hunk', null, null, 'function f'], ['ctx', 3, 3, 'keep'], ['del', 4, null, 'old'], ['add', null, 4, 'new'], ['add', null, 5, 'extra'], ['ctx', 5, 6, 'end'],
    ])
    const rows = splitRows(lines)
    expect(rows.map((r) => ('hunk' in r ? 'h' : 'note' in r ? 'n' : `${r.left?.text ?? '·'}|${r.right?.text ?? '·'}`))).toEqual(['h', 'keep|keep', 'old|new', '·|extra', 'end|end'])
  })

  it('side by side leaves the right empty when more lines went than came, and keeps notes', () => {
    const lines = diffLines(['@@ -1,3 +1,1 @@', '-a', '-b', '-c', '+x', '… diff truncated at 1 MB'].join('\n'))
    const rows = splitRows(lines)
    expect(rows.map((r) => ('hunk' in r ? 'h' : 'note' in r ? `n:${r.note}` : `${r.left?.text ?? '·'}|${r.right?.text ?? '·'}`))).toEqual(['h', 'a|x', 'b|·', 'c|·', 'n:… diff truncated at 1 MB'])
  })

  it('shows a binary file as a note, not as nothing', () => {
    expect(diffLines('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n')).toEqual([{ kind: 'note', text: 'Binary files a/i.png and b/i.png differ', old: null, new: null }])
  })
})
