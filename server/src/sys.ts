import { execFile } from 'node:child_process';
import { dirname, basename } from 'node:path';

export type RepoInfo = { repo: string; branch: string | null; worktree: boolean };

function run(cmd: string, args: string[], timeout = 3000): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout }, (err, stdout) => done(err ? null : stdout.toString()));
  });
}

/** Main repo path (worktrees resolved to the repo they belong to), branch, and whether cwd is a linked worktree. */
export async function repoInfo(cwd: string): Promise<RepoInfo> {
  const out = await run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  if (!out) return { repo: cwd, branch: null, worktree: false };
  const [top, common] = out.trim().split('\n');
  const repo = basename(common) === '.git' ? dirname(common) : common;
  return { repo, branch: await branchOf(cwd), worktree: top !== repo };
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
