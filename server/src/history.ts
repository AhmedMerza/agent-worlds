import { readdirSync, statSync, readFileSync, readlinkSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { glob, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readHead, readTail, userPrompt } from './transcript.ts';
import type { AgentId } from './agents.ts';

export const SESSION_ID_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,63}$/;

/** Claude's project folder name for a cwd: every non-alphanumeric character becomes "-". */
export const projectDirName = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');

type File = { sessionId: string; path: string; mtime: number };

/** Top-level session transcripts (subagent files live in sub-folders or are named agent-*); `only` picks project folders by name. */
function transcripts(dir: string, only?: (project: string) => boolean): File[] {
  const out: File[] = [];
  let projects: string[];
  try { projects = readdirSync(dir); } catch { return out; }
  for (const p of projects) {
    if (only && !only(p)) continue;
    let names: string[];
    try { names = readdirSync(join(dir, p)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl') || n.startsWith('agent-')) continue;
      const sessionId = n.slice(0, -'.jsonl'.length);
      if (!SESSION_ID_RE.test(sessionId)) continue;
      try { out.push({ sessionId, path: join(dir, p, n), mtime: statSync(join(dir, p, n)).mtimeMs }); } catch { /* vanished */ }
    }
  }
  return out;
}

export function findTranscript(dir: string, sessionId: string): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  let projects: string[];
  try { projects = readdirSync(dir); } catch { return null; }
  for (const p of projects) {
    const f = join(dir, p, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** The newest transcript in a cwd's project folder (to guess which session a running claude is). */
export function newestTranscript(dir: string, cwd: string): string | null {
  const p = join(dir, projectDirName(cwd));
  let best: File | null = null;
  let names: string[];
  try { names = readdirSync(p); } catch { return null; }
  for (const n of names) {
    if (!n.endsWith('.jsonl') || n.startsWith('agent-')) continue;
    try {
      const m = statSync(join(p, n)).mtimeMs;
      if (!best || m > best.mtime) best = { sessionId: n.slice(0, -6), path: join(p, n), mtime: m };
    } catch { /* vanished */ }
  }
  return best?.sessionId ?? null;
}

const oneLine = (s: string, max = 200) => {
  const l = s.split('\n').map((x) => x.trim()).find(Boolean) ?? '';
  return l.length > max ? l.slice(0, max - 1) + '…' : l;
};

export type HistoryItem = { sessionId: string; cwd: string | null; lastPrompt: string | null; lastActivity: number; agent?: 'kimi' | 'codex' };

/** A folder that belongs to `repo`: the repo itself, a folder inside it, or one of its `<repo>-worktrees`. */
export const inRepo = (cwd: string, repo: string) => cwd === repo || cwd.startsWith(repo + '/') || cwd.startsWith(repo + '-worktrees/');

/**
 * Most recent sessions, newest first, reading only the tail (and the head when the tail has no cwd).
 * With `repo`, only that repo's: project folders are picked by name first, then each transcript's cwd decides
 * (a look-alike such as `<repo>-admin` shares the folder-name prefix but not the cwd).
 */
export async function history(dir: string, limit: number, repo?: string): Promise<HistoryItem[]> {
  const name = repo ? projectDirName(repo) : '';
  const files = transcripts(dir, repo ? (p) => p === name || p.startsWith(name + '-') : undefined).sort((a, b) => b.mtime - a.mtime);
  const read = (f: File) => transcriptSummary(f.path).then((s) => ({ sessionId: f.sessionId, ...s, lastActivity: Math.round(f.mtime) }));
  if (!repo) return Promise.all(files.slice(0, limit).map(read));
  const out: HistoryItem[] = [];
  for (let i = 0; i < files.length && out.length < limit; i += 50) {
    for (const h of await Promise.all(files.slice(i, i + 50).map(read))) if (h.cwd && inRepo(h.cwd, repo) && out.length < limit) out.push(h);
  }
  return out;
}

/** Kimi Code's homes: yours, and the one Agent Worlds starts it with (whose sessions folder links to yours). */
const kimiHomes = (home: string) => [process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'), join(home, 'kimi-home')];

/** A Kimi session's folder, <kimi home>/sessions/wd_*\/session_<uuid>. Its hooks name it `session_<uuid>`. */
export async function kimiSessionDir(id: string, home: string): Promise<string | null> {
  const dir = (id.startsWith('session_') ? id : `session_${id}`).replace(/[*?[\]\\{}]/g, (c) => `\\${c}`); // the id is data, not a pattern
  for (const base of kimiHomes(home)) {
    if (!existsSync(base)) continue;
    try { for await (const f of glob(`sessions/wd_*/${dir}`, { cwd: base })) return join(base, f); } catch { /* unreadable home */ }
  }
  return null;
}

/** A Kimi session's folder and last change, from its state.json; null when unreadable or archived. */
export async function kimiState(dir: string): Promise<{ cwd: string; updatedAt: number } | null> {
  try {
    const s = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    return typeof s.cwd === 'string' && !s.archived ? { cwd: s.cwd, updatedAt: Number(s.updatedAt) || 0 } : null;
  } catch { return null; }
}

/** The last thing you typed to a Kimi session: its last `turn.prompt` from you in the wire log. */
export async function kimiLastPrompt(dir: string): Promise<string | null> {
  try {
    const e = (await readTail(join(dir, 'agents', 'main', 'wire.jsonl'), 64 * 1024)).findLast((x) => x.type === 'turn.prompt' && x.origin?.kind === 'user');
    const text = Array.isArray(e?.input) ? e.input.map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim() : '';
    return text ? oneLine(text) : null;
  } catch { return null; }
}

/** Most recent Kimi sessions, newest first, like history(); `repo` keeps that repo's. */
export async function kimiHistory(home: string, limit: number, repo?: string): Promise<HistoryItem[]> {
  const found = new Map<string, { dir: string; cwd: string; updatedAt: number }>();
  for (const base of kimiHomes(home)) {
    if (!existsSync(base)) continue;
    try {
      for await (const f of glob('sessions/wd_*/session_*', { cwd: base })) {
        const id = basename(f);
        if (found.has(id) || !SESSION_ID_RE.test(id)) continue;
        const st = await kimiState(join(base, f));
        if (st && (!repo || inRepo(st.cwd, repo))) found.set(id, { dir: join(base, f), ...st });
      }
    } catch { /* unreadable home */ }
  }
  const newest = [...found].sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, limit);
  return Promise.all(newest.map(async ([sessionId, s]) => ({ sessionId, cwd: s.cwd, lastPrompt: await kimiLastPrompt(s.dir), lastActivity: s.updatedAt, agent: 'kimi' as const })));
}

/** A transcript's folder and the last thing the user asked, from its tail (and its head when the tail has neither). */
export async function transcriptSummary(path: string): Promise<{ cwd: string | null; lastPrompt: string | null }> {
  let cwd: string | null = null;
  let lastPrompt: string | null = null;
  try {
    const tail = await readTail(path, 64 * 1024);
    for (let i = tail.length - 1; i >= 0 && (!cwd || !lastPrompt); i--) {
      const e = tail[i];
      // "last-prompt" lines are written lazily, so a newer typed prompt can come after the last one.
      if (!lastPrompt) {
        const p = e.type === 'last-prompt' && typeof e.lastPrompt === 'string' ? e.lastPrompt : userPrompt(e);
        if (p) lastPrompt = oneLine(p);
      }
      if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    }
    if (!cwd || !lastPrompt) {
      // The tail was all one long reply: fall back to the start of the file.
      const head = await readHead(path, 64 * 1024);
      cwd ??= head.find((e) => typeof e.cwd === 'string')?.cwd ?? null;
      if (!lastPrompt) {
        const e = head.findLast((x) => (x.type === 'last-prompt' && typeof x.lastPrompt === 'string') || userPrompt(x));
        lastPrompt = e ? (e.type === 'last-prompt' ? e.lastPrompt : userPrompt(e)) : null;
      }
      if (lastPrompt) lastPrompt = oneLine(lastPrompt);
    }
  } catch { /* unreadable: keep the nulls */ }
  return { cwd, lastPrompt };
}

export type ClaudeProc = { pid: number; argv?: string[]; cwd: string; sessionId: string | null; pane: string | null; managedHome: string | null; direct: string | null; since: number };

/** A running agent process: `agent` which CLI it is, `log` its session file/folder on disk (a Kimi session dir, a Codex rollout, a Gemini chat), `prompt` its last prompt where the scan read it (agy). */
export type AgentProc = ClaudeProc & { agent: AgentId; log: string | null; prompt: string | null };

/** Process name → agent. Kimi renames its process to `kimi-co…`; the Node-script CLIs (qwen, codex, gemini) show as `node <path>/bin/<name>`. */
function agentOf(argv: string[]): AgentId | null {
  const b = basename(argv[0]);
  if (b === 'claude' || b === 'codex' || b === 'qwen' || b === 'kimi' || b === 'gemini' || b === 'agy') return b;
  if (b.startsWith('kimi-')) return 'kimi';
  if ((b === 'node' || b === 'nodejs' || b === 'bun') && argv[1]) {
    const s = basename(argv[1]).replace(/\.m?[jt]s$/, '');
    if (s === 'codex' || s === 'qwen' || s === 'kimi' || s === 'gemini' || s === 'agy') return s;
  }
  return null;
}

/** The first line of a file, parsed (for a Codex rollout's session_meta), reading only `bytes`. */
function firstEntry(path: string, bytes = 256 * 1024): Record<string, any> | null {
  try {
    const fh = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fh, buf, 0, bytes, 0);
      return JSON.parse(buf.subarray(0, n).toString('utf8').split('\n')[0]);
    } finally { closeSync(fh); }
  } catch { return null; }
}

/** The last `bytes` of a file as text (for agy's history.jsonl). */
function tailText(path: string, bytes: number): string {
  try {
    const fh = openSync(path, 'r');
    try {
      const size = statSync(path).size, start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      readSync(fh, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { closeSync(fh); }
  } catch { return ''; }
}

/** The files of one folder, newest first (missing folder: []). */
function byMtimeDesc(dir: string, keep: (name: string) => boolean): { name: string; path: string; mtime: number }[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: { name: string; path: string; mtime: number }[] = [];
  for (const name of names) {
    if (!keep(name)) continue;
    try { out.push({ name, path: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }); } catch { /* vanished */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Kimi homes the scan looks in: yours, and the one Agent Worlds starts it with (`home` left out when unknown). */
const kimiBases = (home?: string) => [process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code'), ...(home ? [join(home, 'kimi-home')] : [])];

/** A Kimi session's folder, synchronously (the process scan cannot await kimiSessionDir). */
function kimiSessionDirSync(id: string, home?: string): string | null {
  const name = id.startsWith('session_') ? id : `session_${id}`;
  for (const base of kimiBases(home)) {
    for (const wd of byMtimeDesc(join(base, 'sessions'), (n) => n.startsWith('wd_'))) {
      try { if (readdirSync(wd.path).includes(name)) return join(wd.path, name); } catch { /* unreadable */ }
    }
  }
  return null;
}

/** A running Kimi's session: its --session flag, else the newest session folder for its cwd. */
function kimiSessionFor(argv: string[], cwd: string, home?: string): { id: string; dir: string | null } | null {
  const i = argv.indexOf('--session');
  if (i >= 0 && SESSION_ID_RE.test(argv[i + 1] ?? '')) return { id: argv[i + 1], dir: kimiSessionDirSync(argv[i + 1], home) };
  let best: { id: string; dir: string; updatedAt: number } | null = null;
  for (const base of kimiBases(home)) {
    for (const wd of byMtimeDesc(join(base, 'sessions'), (n) => n.startsWith('wd_'))) {
      for (const s of byMtimeDesc(wd.path, (n) => SESSION_ID_RE.test(n))) {
        try {
          const st = JSON.parse(readFileSync(join(s.path, 'state.json'), 'utf8'));
          if (st.cwd === cwd && !st.archived && (!best || Number(st.updatedAt) > best.updatedAt)) best = { id: s.name, dir: s.path, updatedAt: Number(st.updatedAt) || 0 };
        } catch { /* no state.json */ }
      }
    }
  }
  return best ? { id: best.id, dir: best.dir } : null;
}

/** A running Qwen's session id: its per-pid session file, else the newest chat in its cwd's project folder. */
function qwenSessionFor(pid: number, cwd: string, qwenHome: string): string | null {
  try {
    const f = JSON.parse(readFileSync(join(qwenHome, 'sessions', `${pid}.json`), 'utf8'));
    if (typeof f.sessionId === 'string' && SESSION_ID_RE.test(f.sessionId)) return f.sessionId;
  } catch { /* no pid file */ }
  const chat = byMtimeDesc(join(qwenHome, 'projects', projectDirName(cwd), 'chats'), (n) => n.endsWith('.jsonl'))[0];
  const id = chat?.name.slice(0, -'.jsonl'.length);
  return id && SESSION_ID_RE.test(id) ? id : null;
}

/** Codex rollout logs, newest first. */
function codexRollouts(codexHome: string): { name: string; path: string; mtime: number }[] {
  const root = join(codexHome, 'sessions');
  return byMtimeDesc(root, (n) => /^\d{4}$/.test(n))
    .flatMap((y) => byMtimeDesc(y.path, (n) => /^\d{2}$/.test(n)))
    .flatMap((m) => byMtimeDesc(m.path, (n) => /^\d{2}$/.test(n)))
    .flatMap((d) => byMtimeDesc(d.path, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')))
    .sort((a, b) => b.mtime - a.mtime);
}

function codexMeta(path: string): { id: string; cwd: string } | null {
  const meta = firstEntry(path);
  if (meta?.type !== 'session_meta') return null;
  const p = meta.payload ?? {};
  const id = typeof p.id === 'string' ? p.id : p.session_id;
  return typeof id === 'string' && SESSION_ID_RE.test(id) && typeof p.cwd === 'string' ? { id, cwd: p.cwd } : null;
}

/** A Codex session's newest rollout, by its resumable id. */
export function codexSession(codexHome: string, sessionId: string): { path: string; cwd: string } | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  for (const f of codexRollouts(codexHome)) {
    const meta = codexMeta(f.path);
    if (meta?.id === sessionId) return { path: f.path, cwd: meta.cwd };
  }
  return null;
}

/** Most recent Codex sessions, newest first; `repo` keeps that repo's. */
export async function codexHistory(codexHome: string, limit: number, repo?: string): Promise<HistoryItem[]> {
  const found = new Map<string, { path: string; cwd: string; mtime: number }>();
  for (const f of codexRollouts(codexHome)) {
    const meta = codexMeta(f.path);
    if (!meta || found.has(meta.id) || (repo && !inRepo(meta.cwd, repo))) continue;
    found.set(meta.id, { path: f.path, cwd: meta.cwd, mtime: f.mtime });
    if (found.size >= limit) break;
  }
  return Promise.all([...found].map(async ([sessionId, f]) => ({
    sessionId, cwd: f.cwd, lastPrompt: (await codexTurn(f.path)).lastPrompt,
    lastActivity: Math.round(f.mtime), agent: 'codex' as const,
  })));
}

/** A running Codex's session: the newest rollout log whose session_meta names its cwd. */
function codexSessionFor(cwd: string, codexHome: string): { id: string; path: string } | null {
  const files = codexRollouts(codexHome);
  // A live process's log is appended to, but an idle one can sit for weeks: look a year back, newest first.
  for (const f of files.filter((f) => f.mtime > Date.now() - 366 * 86400_000).slice(0, 200)) {
    const meta = codexMeta(f.path);
    if (meta?.cwd === cwd) return { id: meta.id, path: f.path };
  }
  return null;
}

/** A running Gemini's chat: the newest one under the tmp project folder whose .project_root is its cwd. */
function geminiSessionFor(cwd: string, geminiDir: string): { id: string; path: string } | null {
  for (const proj of byMtimeDesc(join(geminiDir, 'tmp'), () => true)) {
    let root: string;
    try { root = readFileSync(join(proj.path, '.project_root'), 'utf8').trim(); } catch { continue; }
    if (root !== cwd) continue;
    for (const chat of byMtimeDesc(join(proj.path, 'chats'), (n) => n.endsWith('.json'))) {
      try {
        const id = JSON.parse(readFileSync(chat.path, 'utf8')).sessionId;
        if (typeof id === 'string' && SESSION_ID_RE.test(id)) return { id, path: chat.path };
      } catch { /* unreadable chat */ }
    }
  }
  return null;
}

/** A running agy's conversation and last prompt: the newest history.jsonl entries for its cwd. */
function agySessionFor(cwd: string, agyRoot: string): { id: string; prompt: string | null } | null {
  const lines = tailText(join(agyRoot, 'history.jsonl'), 256 * 1024).split('\n');
  let id: string | null = null, prompt: string | null = null;
  for (let i = lines.length - 1; i >= 0 && (!id || !prompt); i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e?.workspace !== cwd) continue;
      if (!id && typeof e.conversationId === 'string' && SESSION_ID_RE.test(e.conversationId)) id = e.conversationId;
      if (!prompt && typeof e.display === 'string' && !e.display.startsWith('/')) prompt = oneLine(e.display);
    } catch { /* blank or partly written line */ }
  }
  return id ? { id, prompt } : null;
}

/** Where each agent keeps its sessions; overridable for tests. */
export type AgentHomes = { codex?: string; qwen?: string; gemini?: string; agy?: string };

/**
 * Interactive agent processes (Claude, Codex, Qwen, Kimi, Gemini, agy) of this user, from /proc (Linux only;
 * [] elsewhere). Print-mode runs (-p, codex exec) and our own runs (AGENT_WORLDS_DISABLE=1) are skipped.
 * `home` is Agent Worlds' home (its kimi-home link is searched too).
 */
export function scanAgents(procRoot: string, projectsDir: string, opts: { uid?: number; home?: string; homes?: AgentHomes } = {}): AgentProc[] {
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const homes: Required<AgentHomes> = {
    codex: opts.homes?.codex ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
    qwen: opts.homes?.qwen ?? join(homedir(), '.qwen'),
    gemini: opts.homes?.gemini ?? join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini'),
    agy: opts.homes?.agy ?? join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini', 'antigravity-cli'),
  };
  const out: AgentProc[] = [];
  let pids: string[];
  try { pids = readdirSync(procRoot).filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    const d = join(procRoot, pid);
    try {
      if (uid >= 0 && statSync(d).uid !== uid) continue;
      const argv = readFileSync(join(d, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      if (!argv.length) continue;
      const agent = agentOf(argv);
      if (!agent) continue;
      if (argv.includes('-p') || argv.includes('--print')) continue;
      if (agent === 'codex' && argv.includes('exec')) continue; // codex exec: a one-shot run
      const env = Object.fromEntries(readFileSync(join(d, 'environ'), 'utf8').split('\0').filter(Boolean).map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i), kv.slice(i + 1)];
      }));
      if (env.AGENT_WORLDS_DISABLE === '1') continue;
      const cwd = readlinkSync(join(d, 'cwd'));
      let sessionId: string | null = null, log: string | null = null, prompt: string | null = null;
      if (agent === 'claude') {
        const flag = argv.findIndex((a) => a === '--resume' || a === '-r' || a === '--session-id');
        const named = flag >= 0 && SESSION_ID_RE.test(argv[flag + 1] ?? '') ? argv[flag + 1] : null;
        sessionId = named ?? newestTranscript(projectsDir, cwd);
      } else if (agent === 'kimi') {
        const s = kimiSessionFor(argv, cwd, opts.home);
        sessionId = s?.id ?? null; log = s?.dir ?? null;
      } else if (agent === 'qwen') {
        sessionId = qwenSessionFor(+pid, cwd, homes.qwen);
      } else if (agent === 'codex') {
        const s = codexSessionFor(cwd, homes.codex);
        sessionId = s?.id ?? null; log = s?.path ?? null;
      } else if (agent === 'gemini') {
        const s = geminiSessionFor(cwd, homes.gemini);
        sessionId = s?.id ?? null; log = s?.path ?? null;
      } else if (agent === 'agy') {
        const s = agySessionFor(cwd, homes.agy);
        sessionId = s?.id ?? null; prompt = s?.prompt ?? null;
      }
      out.push({
        pid: +pid, argv, cwd, agent, sessionId, log, prompt,
        pane: /^%\d+$/.test(env.TMUX_PANE ?? '') ? env.TMUX_PANE : null,
        managedHome: env.AGENT_WORLDS_HOME ?? null,
        direct: env.AGENT_WORLDS_PTY || null,
        since: Math.round(statSync(d).ctimeMs),
      });
    } catch { /* process went away or is not ours */ }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/** Interactive `claude` processes only (scanAgents narrowed; kept for Claude-only callers). */
export function scanClaude(procRoot: string, projectsDir: string, uid = process.getuid?.() ?? -1): AgentProc[] {
  return scanAgents(procRoot, projectsDir, { uid }).filter((p) => p.agent === 'claude');
}

/** Whether Codex is mid-turn, and its last prompt, from its rollout log's tail (no hook tells us either). */
export async function codexTurn(path: string): Promise<{ working: boolean; lastPrompt: string | null }> {
  try {
    const tail = await readTail(path, 64 * 1024);
    const turn = tail.findLast((e) => e.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(e.payload?.type));
    const typed = tail.findLast((e) => e.type === 'event_msg' && e.payload?.type === 'user_message' && typeof e.payload.message === 'string');
    return { working: turn?.payload?.type === 'task_started', lastPrompt: typed ? oneLine(typed.payload.message) : null };
  } catch { return { working: false, lastPrompt: null }; }
}

/** The last thing you typed to a Gemini session, from its chat file. */
export async function geminiLastPrompt(path: string): Promise<string | null> {
  try {
    const chat = JSON.parse(await readFile(path, 'utf8'));
    const m = (Array.isArray(chat.messages) ? chat.messages : []).findLast((x: { type?: unknown }) => x?.type === 'user');
    const text = typeof m?.content === 'string' ? m.content
      : Array.isArray(m?.content) ? m.content.map((p: { text?: unknown }) => (typeof p?.text === 'string' ? p.text : '')).join(' ') : '';
    return text.trim() ? oneLine(text) : null;
  } catch { return null; }
}
