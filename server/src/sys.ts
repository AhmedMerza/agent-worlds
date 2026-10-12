import { execFile } from 'node:child_process';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export type RepoInfo = { repo: string; branch: string | null; worktree: boolean; top?: string };

function run(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout }, (err, stdout) => done(err ? null : stdout.toString()));
  });
}

/** Main repo path (worktrees resolved to the repo they belong to), branch, and whether cwd is a linked worktree. */
export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const out = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (!out) return { repo: cwd, branch: null, worktree: false, top: cwd };
  const [top, common] = out.trim().split('\n');
  const repo = basename(common) === '.git' ? dirname(common) : common;
  return { repo, branch: await branchOf(cwd), worktree: top !== repo, top };
}

export async function branchOf(cwd: string): Promise<string | null> {
  const b = await run('git', ['-C', cwd, 'branch', '--show-current']);
  return b && b.trim() ? b.trim() : null;
}

export const PANE_RE = /^%\d{1,6}$/;

export async function tmuxSessionOf(pane: string): Promise<string | null> {
  if (!PANE_RE.test(pane)) return null;
  const s = await run('tmux', ['display-message', '-p', '-t', pane, '#{session_name}']);
  return s && s.trim() ? s.trim() : null;
}

/** Names of live tmux sessions, [] when no tmux server runs, null when tmux itself is unavailable. */
export function tmuxSessions(): Promise<string[] | null> {
  return new Promise((done) => {
    execFile('tmux', ['list-sessions', '-F', '#{session_name}'], { timeout: 3000 }, (err, stdout, stderr) => {
      if (!err) return done(stdout.toString().split('\n').filter(Boolean));
      const msg = String(stderr);
      done(/no server running|error connecting/i.test(msg) ? [] : null);
    });
  });
}

/** Type literal text into a pane, then press Enter. Text never touches a shell. */
export async function typeInto(pane: string, text: string): Promise<boolean> {
  if (!PANE_RE.test(pane)) return false;
  if (text && (await run('tmux', ['send-keys', '-t', pane, '-l', '--', text])) === null) return false;
  return (await run('tmux', ['send-keys', '-t', pane, 'Enter'])) !== null;
}

const slug = (s: string, max = 24) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'task';

/**
 * Start `claude` in a new detached tmux session, optionally in a fresh worktree
 * (<repo>-worktrees/<branch>, new branch). Everything goes through argv; nothing touches a shell.
 */
export async function createSession(opts: { repo: string; task?: string; worktree: boolean; branch?: string; claudeBin?: string; prefix?: string; home?: string }): Promise<{ tmuxSession: string; dir: string; branch: string | null }> {
  const id = randomBytes(2).toString('hex');
  let dir = opts.repo;
  let branch: string | null = null;
  if (opts.worktree) {
    branch = opts.branch || `aw/${slug(opts.task || 'session', 32)}-${id}`;
    if ((await run('git', ['check-ref-format', '--branch', branch])) === null || branch.startsWith('-')) throw new Error(`invalid branch name: ${branch}`);
    dir = join(`${opts.repo}-worktrees`, branch.replace(/\//g, '-'));
    const err = await runErr('git', ['-C', opts.repo, 'worktree', 'add', '-b', branch, '--', dir]);
    if (err !== null) throw new Error(`git worktree add failed: ${err}`);
  }
  const name = `${opts.prefix ?? 'aw-'}${slug(basename(opts.repo))}-${id}`;
  const task = (opts.task ?? '').trim();
  // With `home`, the session reports to this server through <home>/hooks.json even when the
  // user never installed the hooks globally.
  const env = opts.home ? ['-e', `AGENT_WORLDS_HOME=${opts.home}`] : [];
  const settings = opts.home ? ['--settings', join(opts.home, 'hooks.json')] : [];
  const err = await runErr('tmux', ['new-session', '-d', '-s', name, '-c', dir, ...env, opts.claudeBin ?? 'claude', ...settings, ...(task ? ['--', task] : [])]);
  if (err !== null) throw new Error(`tmux failed: ${err}`);
  return { tmuxSession: name, dir, branch };
}

/** null on success, else the trimmed stderr. */
function runErr(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, _o, stderr) => done(err ? (String(stderr).trim() || err.message).slice(0, 500) : null));
  });
}
