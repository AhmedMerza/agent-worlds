import { promisify } from 'node:util';
import { execFile } from './child.ts';

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;

/** GitHub remotes go to gh, everything else (gitlab.com, a self-hosted GitLab) to glab. */
export const cliFor = (remote: string): 'gh' | 'glab' => /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]/i.test(remote.trim()) ? 'gh' : 'glab';

/** The issue's address: both CLIs print it, glab among other lines (and, from 1.85, as /-/work_items/N). */
export function issueUrl(out: string): string {
  const urls = out.match(/https?:\/\/[^\s"'<>]+\/(?:-\/)?(?:issues|work_items)\/\d+/g);
  if (!urls) throw new Error(`no issue address in the reply: ${out.trim().slice(0, 200)}`);
  return urls[urls.length - 1];
}

/**
 * File an issue in the repo at `repo` with its own CLI, which is already logged in.
 * The project is the `upstream` remote when there is one (origin is then your fork), else `origin`, passed as --repo:
 * left to themselves both CLIs pick a remote by their own rules, which can land the issue in a fork.
 * Values go as `--flag=value` so a title starting with "-" is never read as a flag; execFile runs no shell.
 */
export async function fileIssue(repo: string, title: string, body: string): Promise<string> {
  const opts = { cwd: repo, timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1' } };
  const names = (await run('git', ['remote'], opts).catch(() => ({ stdout: '' }))).stdout.split('\n').map((r) => r.trim());
  const name = names.includes('upstream') ? 'upstream' : names.includes('origin') ? 'origin' : null;
  if (!name) throw new Error('this repo has no origin remote to file in');
  const remote = (await run('git', ['remote', 'get-url', name], opts)).stdout.trim();
  const cli = cliFor(remote);
  const args = cli === 'gh'
    ? ['issue', 'create', `--repo=${remote}`, `--title=${title}`, `--body=${body}`]
    : ['issue', 'create', `--repo=${remote}`, `--title=${title}`, `--description=${body}`, '--yes'];
  let out: string;
  try {
    const { stdout, stderr } = await run(cli, args, opts);
    out = `${stdout}\n${stderr}`;
  } catch (e) {
    const x = e as { code?: string; stderr?: string; message: string };
    if (x.code === 'ENOENT') throw new Error(`${cli} is not installed`);
    throw new Error(`${cli} failed: ${(x.stderr || x.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  }
  // The CLI succeeded, so the issue exists: an address we can't read must not put the item back to pending (a second press would file it twice).
  try { return issueUrl(out); } catch { return ''; }
}
