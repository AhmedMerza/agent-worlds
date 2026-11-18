import { promisify } from 'node:util';
import { execFile } from './child.ts';

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;

/** GitHub remotes go to gh, everything else (gitlab.com, a self-hosted GitLab) to glab. */
export const cliFor = (remote: string): 'gh' | 'glab' => /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]/i.test(remote.trim()) ? 'gh' : 'glab';

/** The issue's address: both CLIs print it, glab among other lines. */
export function issueUrl(out: string): string {
  const urls = out.match(/https?:\/\/[^\s"'<>]+\/(?:-\/)?issues\/\d+/g);
  if (!urls) throw new Error(`no issue address in the reply: ${out.trim().slice(0, 200)}`);
  return urls[urls.length - 1];
}

/**
 * File an issue in the repo at `repo` with its own CLI, which is already logged in.
 * Values go as `--flag=value` so a title starting with "-" is never read as a flag; execFile runs no shell.
 */
export async function fileIssue(repo: string, title: string, body: string): Promise<string> {
  const opts = { cwd: repo, timeout: TIMEOUT_MS, maxBuffer: 1 << 20, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_PROMPT: '1' } };
  let remote: string;
  try { remote = (await run('git', ['remote', 'get-url', 'origin'], opts)).stdout; } catch { throw new Error('this repo has no origin remote to file in'); }
  const cli = cliFor(remote);
  const args = cli === 'gh'
    ? ['issue', 'create', `--title=${title}`, `--body=${body}`]
    : ['issue', 'create', `--title=${title}`, `--description=${body}`, '--yes'];
  try {
    const { stdout, stderr } = await run(cli, args, opts);
    return issueUrl(`${stdout}\n${stderr}`);
  } catch (e) {
    const x = e as { code?: string; stderr?: string; message: string };
    if (x.code === 'ENOENT') throw new Error(`${cli} is not installed`);
    throw new Error(`${cli} failed: ${(x.stderr || x.message).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
  }
}
