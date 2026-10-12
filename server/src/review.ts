import { execFile } from 'node:child_process';

export type Review = { files: { path: string; added: number; deleted: number }[]; diff: string; tests: { command: string; ok: boolean; line: string } | null };

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

/** Uncommitted changes plus commits ahead of the default branch, as numstat and a capped unified diff. */
export async function reviewOf(cwd: string, tests: Review['tests']): Promise<Review | null> {
  const base = await baseOf(cwd);
  if (!base) return null;
  const numstat = await git(cwd, ['diff', '--numstat', '-z', base]);
  if (numstat === null) return null;
  const files: Review['files'] = [];
  // -z format: "added\tdeleted\tpath\0" (renames: "a\td\t\0old\0new\0")
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/s);
    if (!m) continue;
    let path = m[3];
    if (!path) { path = parts[i + 2] ?? parts[i + 1] ?? ''; i += 2; }
    files.push({ path, added: m[1] === '-' ? 0 : +m[1], deleted: m[2] === '-' ? 0 : +m[2] });
  }
  let diff = (await git(cwd, ['diff', '--no-color', '--no-ext-diff', base])) ?? '';
  const untracked = ((await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])) ?? '').split('\0').filter(Boolean);
  for (const f of untracked.slice(0, UNTRACKED_MAX)) {
    const d = (await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', f], [0, 1])) ?? '';
    const added = d.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
    files.push({ path: f, added, deleted: 0 });
    if (diff.length < DIFF_MAX) diff += d;
  }
  if (diff.length > DIFF_MAX) diff = diff.slice(0, DIFF_MAX) + '\n… diff truncated at 200 KB\n';
  return { files, diff, tests };
}

export const TEST_RE = /\b(phpunit|artisan\s+test|pest|vitest|jest|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|pytest|go\s+test|flutter\s+test|cargo\s+test|node\s+--test)\b/;

/** One line that best summarises a test run's output. */
export function testLine(output: string): string {
  const lines = output.split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).slice(-40);
  const hit = [...lines].reverse().find((l) => /\b(pass(ed|es)?|fail(ed|ures?)?|tests?|errors?|ok)\b/i.test(l));
  const line = hit ?? lines.at(-1) ?? '';
  return line.length > 200 ? line.slice(0, 199) + '…' : line;
}
