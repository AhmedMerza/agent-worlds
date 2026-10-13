import { execFile } from 'node:child_process';

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

/** The commit this branch forked from the default branch, or HEAD when there is no default branch to compare with. */
async function baseOf(cwd: string): Promise<string | null> {
  const remote = (await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  for (const ref of [remote, 'main', 'master'].filter(Boolean) as string[]) {
    if (await git(cwd, ['rev-parse', '-q', '--verify', ref + '^{commit}'])) {
      const mb = (await git(cwd, ['merge-base', 'HEAD', ref]))?.trim();
      if (mb) return mb;
    }
  }
  return (await git(cwd, ['rev-parse', '-q', '--verify', 'HEAD']))?.trim() || null;
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

/**
 * What a session changed: everything since `baseSha` (the HEAD when the session was first seen),
 * committed or not, plus the still-uncommitted part on its own. Without a usable baseSha (a
 * session that predates the server) it falls back to "ahead of the default branch" and baseSha is null.
 */
export async function reviewOf(cwd: string, tests: Review['tests'], baseSha: string | null = null): Promise<Review | null> {
  let base: string | null = null;
  if (baseSha && /^[0-9a-f]{7,64}$/i.test(baseSha)) base = (await git(cwd, ['rev-parse', '-q', '--verify', baseSha + '^{commit}']))?.trim() || null;
  const known = base !== null;
  base ??= await baseOf(cwd);
  if (!base) return null;
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
