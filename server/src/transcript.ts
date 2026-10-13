import { open } from 'node:fs/promises';

type Entry = Record<string, any>;

/** Parse the last `bytes` of a JSONL file (the first, possibly cut, line is dropped). */
export async function readTail(path: string, bytes: number): Promise<Entry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return parseLines(lines);
  } finally { await fh.close(); }
}

/** Parse the first `bytes` of a JSONL file (the last, possibly cut, line is dropped). */
export async function readHead(path: string, bytes: number): Promise<Entry[]> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesRead === bytes) lines.pop();
    return parseLines(lines);
  } finally { await fh.close(); }
}

function parseLines(lines: string[]): Entry[] {
  const out: Entry[] = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try { const v = JSON.parse(l); if (v && typeof v === 'object' && !v.isSidechain) out.push(v); } catch { /* partial line */ }
  }
  return out;
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
};

/** A prompt the person typed (not a tool result, slash-command echo or injected meta message). */
export function userPrompt(e: Entry): string | null {
  if (e.type !== 'user' || e.isMeta || e.message?.role !== 'user') return null;
  const t = textOf(e.message.content).trim();
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) return null;
  return t;
}

export const firstPrompt = (entries: Entry[]): string | null => {
  for (const e of entries) { const p = userPrompt(e); if (p) return p; }
  return null;
};

export const DEFAULT_CONTEXT_LIMIT = 1_000_000;

/** Context use from the last assistant message's usage. `limit` is the configured window; usage past it (or a "[1m]" model id) proves a bigger one. */
export function contextOf(entries: Entry[], model: string | null, limit = DEFAULT_CONTEXT_LIMIT): { used: number; limit: number; pct: number } | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const u = e.type === 'assistant' ? e.message?.usage : null;
    if (!u) continue;
    const used = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (!used) continue;
    const id = String(model ?? e.message?.model ?? '');
    let lim = id.includes('[1m]') ? Math.max(limit, 1_000_000) : limit;
    if (used > lim) lim = Math.max(1_000_000, used);
    return { used, limit: lim, pct: Math.min(100, Math.round((used / lim) * 100)) };
  }
  return null;
}

export type Turn = { who: 'you' | 'claude' | 'step'; text: string };

/** The conversation as turns, oldest first: what you typed, what Claude wrote, and one line per tool step. */
export function conversation(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of entries) {
    const p = userPrompt(e);
    if (p) { turns.push({ who: 'you', text: p }); continue; }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c?.type === 'text' && c.text?.trim()) turns.push({ who: 'claude', text: c.text.trim() });
      else if (c?.type === 'tool_use') {
        const i = c.input ?? {};
        const arg = i.command ?? i.file_path ?? i.description ?? i.pattern ?? i.url ?? '';
        turns.push({ who: 'step', text: `${c.name}: ${String(arg).split('\n')[0].slice(0, 200)}` });
      }
    }
  }
  return turns;
}

/** A compact plain-text account of the conversation, newest last, at most `max` characters. */
export function excerpt(entries: Entry[], max = 12_000): string {
  const LABEL = { you: 'USER', claude: 'ASSISTANT', step: 'TOOL' } as const;
  const parts = conversation(entries).map((t) => `${LABEL[t.who]}${t.who === 'step' ? ' ' : ': '}${t.who === 'step' ? t.text : t.text.slice(0, 1500)}`);
  let out = '';
  for (let i = parts.length - 1; i >= 0; i--) {
    if (out.length + parts[i].length + 1 > max) break;
    out = parts[i] + '\n' + out;
  }
  return out;
}
