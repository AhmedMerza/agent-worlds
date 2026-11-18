import { describe, expect, it } from 'vitest'
import { canFile, clock, inbox, recordingName, repoOptions, stageText, waitingCount } from '../src/captures'
import { applyMessage, newState } from '../src/store'
import type { Capture, CaptureItem } from '../src/types'

const item = (id: string, status: CaptureItem['status'], repo: string | null = '/r/a'): CaptureItem => ({ id, title: id, body: '', repo, status })
const cap = (id: string, createdAt: number, status: Capture['status'], items: CaptureItem[] = []): Capture => ({ id, createdAt, status, attempts: 1, hasTranscript: true, items })

describe('captures', () => {
  const all = {
    old: cap('old', 1, 'ready', [item('o1', 'pending'), item('o2', 'filed')]),
    new: cap('new', 2, 'ready', [item('n1', 'check'), item('n2', 'dropped'), item('n3', 'filing')]),
    busy: cap('busy', 3, 'transcribing'),
    bad: cap('bad', 4, 'failed'),
  }

  it('inbox: open items of finished captures, newest first, one capture left out on request', () => {
    expect(inbox(all).map((r) => r.item.id)).toEqual(['n1', 'n3', 'o1'])
    expect(inbox(all, 'new').map((r) => r.item.id)).toEqual(['o1'])
  })

  it('waitingCount: pending and check items plus failed recordings; filing is not waiting on you', () => {
    expect(waitingCount(all)).toBe(3)
    expect(waitingCount({})).toBe(0)
  })

  it('canFile: only a pending item with a repo of a world', () => {
    expect(canFile(item('a', 'pending'), ['/r/a'])).toBe(true)
    expect(canFile(item('a', 'pending', null), ['/r/a'])).toBe(false)
    expect(canFile(item('a', 'pending', '/gone'), ['/r/a'])).toBe(false)
    expect(canFile(item('a', 'check'), ['/r/a'])).toBe(false)
  })

  it('repoOptions: one per repo, world added only when folder names clash', () => {
    const w = (id: string, repos: string[]) => ({ id, name: id.toUpperCase(), color: '#000000', repos })
    expect(repoOptions([w('x', ['/a/api', '/a/web']), w('y', ['/b/api', '/a/web'])])).toEqual([
      { path: '/a/api', label: 'api (X)' }, { path: '/b/api', label: 'api (Y)' }, { path: '/a/web', label: 'web' },
    ])
  })

  it('recordingName follows the recorder type (Safari gives mp4)', () => {
    expect(recordingName('audio/webm;codecs=opus', 5)).toBe('capture-5.webm')
    expect(recordingName('audio/mp4', 5)).toBe('capture-5.m4a')
    expect(recordingName('audio/ogg', 5)).toBe('capture-5.ogg')
    expect(recordingName('', 5)).toBe('capture-5.webm')
  })

  it('stageText and clock', () => {
    expect(stageText(cap('a', 1, 'ready'))).toMatch(/Nothing to file/)
    expect(stageText(all.old)).toBe('1 of 2 to review')
    expect(stageText({ ...all.bad, error: 'no python' })).toBe('Failed: no python')
    expect(clock(65_400)).toBe('1:05')
  })

  it('store: snapshot, capture and capture-removed messages', () => {
    const st = newState()
    applyMessage(st, { type: 'snapshot', worlds: [], sessions: [], captures: [all.old] })
    expect(Object.keys(st.captures)).toEqual(['old'])
    applyMessage(st, { type: 'capture', capture: all.new })
    applyMessage(st, { type: 'capture-removed', id: 'old' })
    expect(Object.keys(st.captures)).toEqual(['new'])
  })
})

describe('inbox keep', () => {
  it('keeps items you acted on while looking, whatever their status', () => {
    const c = { x: { id: 'x', createdAt: 1, status: 'ready' as const, attempts: 0, hasTranscript: true, items: [{ id: 'f', title: 'f', body: '', repo: '/r', status: 'filed' as const }, { id: 'p', title: 'p', body: '', repo: '/r', status: 'pending' as const }] } }
    expect(inbox(c).map((r) => r.item.id)).toEqual(['p'])
    expect(inbox(c, undefined, new Set(['f'])).map((r) => r.item.id)).toEqual(['f', 'p'])
  })
})
