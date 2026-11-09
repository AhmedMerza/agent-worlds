import { execFile } from './child.ts';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Review = { dir: string; branch: string | null; elsewhere: boolean; baseSha: string | null; files: { path: string; added: number; deleted: number }[]; commits: { sha: string; subject: string }[]; uncommitted: { path: string; added: number; deleted: number }[]; diff: string; tests: { command: string; ok: boolean; line: string } | null };

const DIFF_MAX = 200 * 1024;
const UNTRACKED_MAX = 50;

function git(cwd: string, args: string[], okCodes = [0]): Promise<string | null> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      done(okCodes.includes(code) ? stdout.toString() : null);
    });
  });
}

/**
 * The commit this branch forked from the default branch, or HEAD when there is no default branch to compare with.
 * Of the candidate refs it takes the nearest fork point: a stale origin/dev must not turn 200 commits into 15,000.
 */
async function baseOf(cwd: string): Promise<string | null> {
  const remote = (await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  let best: { mb: string; ahead: number } | null = null;
  for (const ref of new Set([remote, remote?.replace(/^origin\//, ''), 'main', 'master'].filter(Boolean) as string[])) {
    if (!(await git(cwd, ['rev-parse', '-q', '--verify', ref + '^{commit}']))) continue;
    const mb = (await git(cwd, ['merge-base', 'HEAD', ref]))?.trim();
    const ahead = mb ? Number((await git(cwd, ['rev-list', '--count', `${mb}..HEAD`]))?.trim()) : NaN;
    if (mb && !Number.isNaN(ahead) && (!best || ahead < best.ahead)) best = { mb, ahead };
  }
  return best?.mb ?? ((await git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']))?.trim() || null);
}

type FileStat = { path: string; added: number; deleted: number };

/** Parse `git diff --numstat -z` output. -z format: "added\tdeleted\tpath\0" (renames: "a\td\t\0old\0new\0"). */
function parseNumstat(numstat: string): FileStat[] {
  const files: FileStat[] = [];
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let path = m[3];
    if (!path) { path = parts[i + 2] ?? parts[i + 1] ?? ''; i += 2; }
    files.push({ path, added: m[1] === '-' ? 0 : +m[1], deleted: m[2] === '-' ? 0 : +m[2] });
  }
  return files;
}

/** `baseSha` when it still names a commit here, else the fork point from the default branch (`known` false). */
async function resolveBase(cwd: string, baseSha: string | null): Promise<{ base: string; known: boolean } | null> {
  let base: string | null = null;
  if (baseSha && /^[0-9a-f]{7,64}$/i.test(baseSha)) base = (await git(cwd, ['rev-parse', '-q', '--verify', baseSha + '^{commit}']))?.trim() || null;
  const known = base !== null;
  base ??= await baseOf(cwd);
  return base ? { base, known } : null;
}

/**
 * What a session changed: everything since `baseSha` (the HEAD when the session was first seen),
 * committed or not, plus the still-uncommitted part on its own. Without a usable baseSha (a
 * session that predates the server) it falls back to "ahead of the default branch" and baseSha is null.
 */
export async function reviewOf(cwd: string, tests: Review['tests'], baseSha: string | null = null): Promise<Review | null> {
  const b = await resolveBase(cwd, baseSha);
  if (!b) return null;
  const { base, known } = b;
  const numstat = await git(cwd, ['diff', '--numstat', '-z', base]);
  if (numstat === null) return null;
  const files = parseNumstat(numstat);
  const sinceHead = parseNumstat((await git(cwd, ['diff', '--numstat', '-z', 'HEAD'])) ?? '');
  const uncommitted = [...sinceHead];
  let diff = (await git(cwd, ['diff', '--no-color', '--no-ext-diff', base])) ?? '';
  const untracked = ((await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])) ?? '').split('\0').filter(Boolean);
  for (const f of untracked.slice(0, UNTRACKED_MAX)) {
    const d = (await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', f], [0, 1])) ?? '';
    const added = d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    files.push({ path: f, added, deleted: 0 });
    uncommitted.push({ path: f, added, deleted: 0 });
    if (diff.length < DIFF_MAX) diff += d;
  }
  if (diff.length > DIFF_MAX) diff = diff.slice(0, DIFF_MAX) + '\n… diff truncated at 200 KB\n';
  const commits = ((await git(cwd, ['log', '--no-color', '--format=%H%x1f%s%x1e', `${base}..HEAD`])) ?? '').split('\x1e').map((r) => r.trim()).filter(Boolean)
    .map((r) => { const [sha, subject] = r.split('\x1f'); return { sha, subject: subject ?? '' }; });
  const branch = (await git(cwd, ['branch', '--show-current']))?.trim() || null;
  return { dir: cwd, branch, elsewhere: false, baseSha: known ? base : null, files, commits, uncommitted, diff, tests };
}

export const TEST_RE = /\b(phpunit|artisan\s+test|pest|vitest|jest|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|pytest|go\s+test|flutter\s+test|cargo\s+test|node\s+--test)\b/;

/** One line that best summarises a test run's output. */
export function testLine(output: string): string {
  const lines = output.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).slice(-40);
  const rev = [...lines].reverse();
  // Prefer node's "ℹ pass N" / "ℹ fail N" summary (its "ℹ tests N" counts subtests, so "tests 2" misleads),
  // then another runner's totals ("Tests: 3 passed", "12 passed, 1 failed"), else any pass/fail line.
  const nodePass = rev.find((l) => /^ℹ\s*pass\s+\d+$/.test(l));
  const nodeFail = rev.find((l) => /^ℹ\s*fail\s+\d+$/.test(l));
  if (nodePass && nodeFail) {
    const n = (l: string) => l.replace(/\D+/g, '');
    return `pass ${n(nodePass)}, fail ${n(nodeFail)}`;
  }
  const hit = rev.find((l) => /\b\d+\s+(passed|failed)\b|\b(passed|failed)\b:?\s+\d+/i.test(l))
    ?? rev.find((l) => /\b(tests?)\b:?\s+\d+/i.test(l))
    ?? rev.find((l) => /\b(pass(ed|es)?|fail(ed|ures?)?|tests?|errors?|ok)\b/i.test(l));
  const line = hit ?? lines.at(-1) ?? '';
  return line.length > 200 ? line.slice(0, 199) + '…' : line;
}

/** One changed file. `sig` changes whenever the file's content does, so a "viewed" tick can tell it is stale. */
export type ChangedFile = { path: string; from?: string; status: 'A' | 'M' | 'D' | 'R'; added: number; deleted: number; uncommitted: boolean; untracked?: true; sig: string };
/** The Changes view's file list: everything since `base`, committed or not, without the diff text (that is fetched per file). */
export type Changes = { dir: string; base: string; files: ChangedFile[]; more: number };

const FILES_MAX = 300;

/**
 * Lines in a new file as git counts them (a last line without a newline counts); 0 for binary, unreadable or over 8 MB.
 * Regular files only: an untracked symlink to /dev/zero or a FIFO would read forever or block.
 */
async function linesIn(path: string): Promise<number> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return 0;
    const b = await readFile(path);
    if (b.subarray(0, 8000).includes(0)) return 0;
    let n = 0;
    for (const c of b) if (c === 10) n++;
    return b.length && b[b.length - 1] !== 10 ? n + 1 : n;
  } catch { return 0; }
}
const FILE_DIFF_MAX = 1024 * 1024;

/** Parse `git diff --name-status -z`: "M\0path\0", renames "R100\0old\0new\0". */
function parseNameStatus(out: string): Map<string, { status: ChangedFile['status']; from?: string }> {
  const m = new Map<string, { status: ChangedFile['status']; from?: string }>();
  const p = out.split('\0');
  for (let i = 0; i < p.length - 1; i++) {
    const code = p[i][0];
    if (code === 'R' || code === 'C') { m.set(p[i + 2], { status: code === 'R' ? 'R' : 'A', from: code === 'R' ? p[i + 1] : undefined }); i += 2; }
    else if (code) { m.set(p[i + 1], { status: code === 'A' || code === 'D' ? code : 'M' }); i += 1; }
  }
  return m;
}

export async function changesOf(cwd: string, baseSha: string | null): Promise<Changes | null> {
  const b = await resolveBase(cwd, baseSha);
  if (!b) return null;
  const [numstat, names, sinceHead, others] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '-M', b.base]),
    git(cwd, ['diff', '--name-status', '-z', '-M', b.base]),
    git(cwd, ['diff', '--name-only', '-z', 'HEAD']),
    git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (numstat === null) return null;
  const status = parseNameStatus(names ?? '');
  const dirty = new Set((sinceHead ?? '').split('\0').filter(Boolean));
  const files: Omit<ChangedFile, 'sig'>[] = parseNumstat(numstat).map((f) => {
    const st = status.get(f.path) ?? { status: 'M' as const };
    return { ...f, ...st, uncommitted: dirty.has(f.path) || (!!st.from && dirty.has(st.from)) };
  });
  const untracked = (others ?? '').split('\0').filter(Boolean);
  // Line counts of new files read from disk: one git process per file would be hundreds when an agent scaffolds a project.
  const counted = await Promise.all(untracked.slice(0, Math.max(0, FILES_MAX - files.length)).map(async (path) => {
    return { path, status: 'A' as const, added: await linesIn(join(cwd, path)), deleted: 0, uncommitted: true, untracked: true as const };
  }));
  const all = [...files, ...counted];
  const shown = all.slice(0, FILES_MAX);
  // One hash per file still on disk: what a "viewed" tick is pinned to.
  // Regular files only (a nested repo or submodule is a directory and fails the whole call); if one still fails, hash one by one.
  const onDisk = (await Promise.all(shown.filter((f) => f.status !== 'D').map(async (f) => ((await lstat(join(cwd, f.path)).catch(() => null))?.isFile() ? f.path : null)))).filter((p): p is string => p !== null);
  let hashes = onDisk.length ? (await git(cwd, ['hash-object', '--', ...onDisk]))?.trim().split('\n') : [];
  if (hashes?.length !== onDisk.length) hashes = await Promise.all(onDisk.map(async (p) => (await git(cwd, ['hash-object', '--', p]))?.trim() ?? ''));
  const sigOf = new Map(onDisk.map((p, i) => [p, hashes![i] || null]));
  return {
    dir: cwd, base: b.base, more: files.length + untracked.length - shown.length,
    files: shown.map((f) => ({ ...f, sig: f.status === 'D' ? 'deleted' : sigOf.get(f.path) ?? `${f.added}-${f.deleted}` })),
  };
}

/** The diff of one file from the Changes list (not a path from the request: callers look the file up first). */
export async function fileDiff(cwd: string, base: string, f: ChangedFile): Promise<string> {
  const d = f.untracked
    ? await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', f.path], [0, 1])
    : await git(cwd, ['diff', '--no-color', '--no-ext-diff', '-M', base, '--', ...(f.from ? [f.from] : []), f.path]);
  const text = d ?? '';
  return text.length > FILE_DIFF_MAX ? text.slice(0, FILE_DIFF_MAX) + '\n… diff truncated at 1 MB\n' : text;
}
