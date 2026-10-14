import { execFile } from 'node:child_process';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { AGENTS, launchArgs, type AgentId } from './agents.ts';

export type RepoInfo = { repo: string; branch: string | null; worktree: boolean; top?: string; head?: string | null };

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
  const head = (await run('git', ['-C', cwd, 'rev-parse', '-q', '--verify', 'HEAD']))?.trim() || null;
  return { repo, branch: await branchOf(cwd), worktree: top !== repo, top, head };
}

export async function branchOf(cwd: string): Promise<string | null> {
  const b = await run('git', ['-C', cwd, 'branch', '--show-current']);
  return b && b.trim() ? b.trim() : null;
}

/**
 * The ref a new worktree branch starts from: the repo's default branch (origin/HEAD, else main,
 * else master), never whatever the main checkout happens to have checked out. HEAD only when the
 * repo has none of those.
 */
export async function defaultStart(repo: string): Promise<string> {
  const remote = (await run('git', ['-C', repo, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']))?.trim();
  for (const ref of [remote, 'main', 'master']) {
    if (ref && (await run('git', ['-C', repo, 'rev-parse', '-q', '--verify', ref + '^{commit}'])) !== null) return ref;
  }
  return 'HEAD';
}

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;

export const PANE_RE = /^%\d{1,6}$/;

export const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

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

/** The flags of a running claude worth keeping when it starts again: never its first prompt or session. */
export function keptFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (a === '--dangerously-skip-permissions' || /^--(settings|permission-mode|model)=/.test(a)) out.push(a);
    else if (/^--(settings|permission-mode|model)$/.test(a) && i + 1 < argv.length) out.push(a, argv[++i]);
  }
  return out;
}

/** Quits the pane's claude and resumes the same conversation in a fresh one, in the same pane, so the browser stays attached. */
export function restartClaude(pane: string, sessionId: string, cwd: string, argv: string[], home: string | null): Promise<string | null> {
  if (!PANE_RE.test(pane)) return Promise.resolve('not a tmux pane');
  const env = home ? ['-e', `AGENT_WORLDS_HOME=${home}`] : [];
  return runErr('tmux', ['respawn-pane', '-k', '-t', pane, '-c', cwd, ...env, argv[0], '--resume', sessionId, ...keptFlags(argv)]);
}

/** Type literal text into a pane, then press Enter. Text never touches a shell. */
export async function typeInto(pane: string, text: string): Promise<boolean> {
  if (!PANE_RE.test(pane)) return false;
  if (text && (await run('tmux', ['send-keys', '-t', pane, '-l', '--', text])) === null) return false;
  return (await run('tmux', ['send-keys', '-t', pane, 'Enter'])) !== null;
}

const slug = (s: string, max = 24) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'task';

/** Sessions run inside tmux so they outlive the server and can be watched from several screens at once. */
export const hasTmux = async () => (await run('tmux', ['-V'])) !== null;
export const TMUX_INSTALL = process.platform === 'darwin' ? 'brew install tmux' : 'sudo dnf install tmux, or sudo apt install tmux';
export const TMUX_MISSING = `tmux is not installed, so sessions run inside Agent Worlds itself and end when it restarts or updates. Install tmux (${TMUX_INSTALL}) and restart Agent Worlds to keep sessions running across restarts and to open them from your own terminal.`;
/** Runs the agent CLI as a session the server owns (no tmux). */
export type SpawnDirect = (name: string, file: string, args: string[], cwd: string, env: Record<string, string>) => Promise<void>;

/**
 * Start the agent CLI (`claude` unless told otherwise) in a new detached tmux session, optionally in a fresh worktree
 * (<repo>-worktrees/<branch>, new branch forked from the repo's default branch, see defaultStart). Everything goes through argv; nothing touches a shell.
 */
export async function createSession(opts: { repo: string; task?: string; worktree: boolean; branch?: string; claudeBin?: string; agent?: AgentId; prefix?: string; home?: string; resume?: string; permissionMode?: string; spawnDirect?: SpawnDirect }): Promise<{ tmuxSession: string; dir: string; branch: string | null; pane?: string | null; direct?: boolean }> {
  const direct = !(await hasTmux());
  if (direct && !opts.spawnDirect) throw new Error(`this needs tmux, which is not installed (${TMUX_INSTALL}). Start sessions from the web page instead.`); // before any worktree is made
  const id = randomBytes(2).toString('hex');
  let dir = opts.repo;
  let branch: string | null = null;
  if (opts.worktree) {
    if (!('head' in await repoInfo(opts.repo))) throw new Error(`${opts.repo} is not a git repo, so it cannot use a worktree`);
    branch = opts.branch || `aw/${slug(opts.task || 'session', 32)}-${id}`;
    if ((await run('git', ['check-ref-format', '--branch', branch])) === null || branch.startsWith('-')) throw new Error(`invalid branch name: ${branch}`);
    dir = join(`${opts.repo}-worktrees`, branch.replace(/\//g, '-'));
    const err = await runErr('git', ['-C', opts.repo, 'worktree', 'add', '-b', branch, dir, await defaultStart(opts.repo)]);
    if (err !== null) throw new Error(`git worktree add failed: ${err}`);
  }
  const name = `${opts.prefix ?? 'aw-'}${slug(basename(opts.repo))}-${id}`;
  const task = (opts.task ?? '').trim();
  // With `home`, the session reports to this server (Claude through <home>/hooks.json) even when the
  // user never installed the hooks globally.
  const agent = opts.agent ?? 'claude';
  const bin = agent === 'claude' ? opts.claudeBin ?? 'claude' : AGENTS[agent].bin;
  const { args, env: agentEnv } = launchArgs(agent, { home: opts.home, resume: opts.resume, permissionMode: opts.permissionMode, task });
  const vars = { ...(opts.home ? { AGENT_WORLDS_HOME: opts.home } : {}), ...agentEnv };
  const env = Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  if (direct) {
    // AGENT_WORLDS_PTY lets aw-hook tell the server which of its sessions an event belongs to (tmux has TMUX_PANE for that).
    try { await opts.spawnDirect!(name, bin, args, dir, { ...vars, AGENT_WORLDS_PTY: name }); } catch (e) { throw new Error(`could not start ${bin}: ${(e as Error).message}`); }
    return { tmuxSession: name, dir, branch, pane: null, direct: true };
  }
  const err = await runErr('tmux', ['new-session', '-d', '-s', name, '-c', dir, ...env, bin, ...args]);
  if (err !== null) throw new Error(`tmux failed: ${err}`);
  // Several clients (a desktop terminal and the browser) may attach at once: size the window to
  // whichever client was used last instead of shrinking it to the smallest one.
  await run('tmux', ['set-option', '-w', '-t', `=${name}:`, 'window-size', 'latest']);
  await run('tmux', ['set-option', '-w', '-t', `=${name}:`, 'aggressive-resize', 'on']);
  const pane = (await run('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{pane_id}']))?.trim() ?? '';
  return { tmuxSession: name, dir, branch, pane: PANE_RE.test(pane) ? pane : null };
}

/** null on success, else the trimmed stderr. */
function runErr(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, _o, stderr) => done(err ? (String(stderr).trim() || err.message).slice(0, 500) : null));
  });
}
