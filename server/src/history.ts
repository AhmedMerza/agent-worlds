import { readdirSync, statSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readHead, readTail, userPrompt } from './transcript.ts';

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

export type HistoryItem = { sessionId: string; cwd: string | null; lastPrompt: string | null; lastActivity: number };

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

export type ClaudeProc = { pid: number; cwd: string; sessionId: string | null; pane: string | null; managedHome: string | null; direct: string | null; since: number };

/**
 * Interactive `claude` processes of this user, from /proc (Linux only; [] elsewhere).
 * Print-mode runs (-p) and our own summary runs (AGENT_WORLDS_DISABLE=1) are skipped.
 */
export function scanClaude(procRoot: string, projectsDir: string, uid = process.getuid?.() ?? -1): ClaudeProc[] {
  const out: ClaudeProc[] = [];
  let pids: string[];
  try { pids = readdirSync(procRoot).filter((p) => /^\d+$/.test(p)); } catch { return out; }
  for (const pid of pids) {
    const d = join(procRoot, pid);
    try {
      if (uid >= 0 && statSync(d).uid !== uid) continue;
      const argv = readFileSync(join(d, 'cmdline'), 'utf8').split('\0').filter(Boolean);
      if (!argv.length || basename(argv[0]) !== 'claude') continue;
      if (argv.includes('-p') || argv.includes('--print')) continue;
      const env = Object.fromEntries(readFileSync(join(d, 'environ'), 'utf8').split('\0').filter(Boolean).map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i), kv.slice(i + 1)];
      }));
      if (env.AGENT_WORLDS_DISABLE === '1') continue;
      const cwd = readlinkSync(join(d, 'cwd'));
      const flag = argv.findIndex((a) => a === '--resume' || a === '-r' || a === '--session-id');
      const named = flag >= 0 && SESSION_ID_RE.test(argv[flag + 1] ?? '') ? argv[flag + 1] : null;
      out.push({
        pid: +pid, cwd,
        sessionId: named ?? newestTranscript(projectsDir, cwd),
        pane: /^%\d+$/.test(env.TMUX_PANE ?? '') ? env.TMUX_PANE : null,
        managedHome: env.AGENT_WORLDS_HOME ?? null,
        direct: env.AGENT_WORLDS_PTY || null,
        since: Math.round(statSync(d).ctimeMs),
      });
    } catch { /* process went away or is not ours */ }
  }
  return out.sort((a, b) => a.pid - b.pid);
}
