import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type SetupOptions = { enabled?: boolean; command?: string; timeoutSeconds?: number };
export type SetupJob = { repo: string; dir: string; name: string; task: string; agent: string; parent?: string | null; options: SetupOptions };
export type SetupStatus = { state: 'running' | 'ready' | 'error'; message: string };
export const SETUP_TIMEOUT_SECONDS = 600;

export function setupOptions(raw: unknown): Record<string, SetupOptions> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('worktreeSetup must be an object keyed by repo path');
  const out: Record<string, SetupOptions> = {};
  for (const [repo, value] of Object.entries(raw)) {
    if (!repo.startsWith('/') || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('worktreeSetup needs absolute repo paths and setup options');
    const v = value as Record<string, unknown>;
    if (v.enabled !== undefined && typeof v.enabled !== 'boolean') throw new Error('setup enabled must be true or false');
    if (v.command !== undefined && (typeof v.command !== 'string' || v.command.length > 4000)) throw new Error('setup command must be a string of at most 4000 characters');
    if (v.timeoutSeconds !== undefined && (!Number.isInteger(v.timeoutSeconds) || Number(v.timeoutSeconds) < 1 || Number(v.timeoutSeconds) > 3600)) throw new Error('setup timeoutSeconds must be 1-3600');
    out[repo] = { ...(v.enabled !== undefined ? { enabled: v.enabled as boolean } : {}), ...(v.command !== undefined ? { command: v.command as string } : {}), ...(v.timeoutSeconds !== undefined ? { timeoutSeconds: v.timeoutSeconds as number } : {}) };
  }
  return out;
}

export function writeSetupStatus(file: string, status: SetupStatus) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 });
  renameSync(tmp, file);
}

/** git itself interprets the include file, including negation, rooted patterns and directory globs. */
export function copySetupFiles(repo: string, dir: string): number {
  const include = join(repo, '.worktreeinclude');
  let files: string[];
  if (existsSync(include)) {
    const ignored = execFileSync('git', ['-C', repo, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { maxBuffer: 16 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
    const selected = new Set(execFileSync('git', ['-C', repo, 'ls-files', '--others', '--ignored', `--exclude-from=${include}`, '-z'], { maxBuffer: 16 * 1024 * 1024 }).toString().split('\0').filter(Boolean));
    files = ignored.filter((f) => selected.has(f));
  } else files = readdirSync(repo).filter((f) => f.startsWith('.env'));
  let copied = 0;
  for (const file of files) {
    const src = join(repo, file), dest = resolve(dir, file);
    if (!dest.startsWith(resolve(dir) + sep) || !lstatSync(src).isFile()) continue;
    // Never follow a branch's symlink out of its new checkout, or overwrite its tracked config.
    try { lstatSync(dest); continue; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let parent = dirname(dest);
    while (!existsSync(parent)) parent = dirname(parent);
    if (relative(realpathSync(dir), realpathSync(parent)).split(sep).includes('..')) throw new Error(`copy destination leaves the worktree: ${file}`);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied++;
  }
  return copied;
}

export function setupCommands(dir: string, options: SetupOptions): string[] {
  if (options.command?.trim()) return [options.command];
  return [...(existsSync(join(dir, 'composer.lock')) ? ['composer install --no-interaction --prefer-dist --no-progress'] : []), ...(existsSync(join(dir, 'pubspec.yaml')) ? ['flutter pub get'] : [])];
}

/** A separate process in the session's own terminal: survives server restarts and inherits its real stdio. */
export async function runSetup(job: SetupJob, statusFile: string): Promise<boolean> {
  const report = (state: SetupStatus['state'], message: string) => { console.log(`[Worktree setup] ${message}`); writeSetupStatus(statusFile, { state, message }); };
  const limit = (job.options.timeoutSeconds ?? SETUP_TIMEOUT_SECONDS) * 1000;
  const deadline = Date.now() + limit;
  const execute = (file: string, args: string[], label: string) => new Promise<void>((ok, fail) => {
    if (Date.now() >= deadline) return fail(new Error(`timed out after ${limit / 1000}s`));
    const child = spawn(file, args, { cwd: job.dir, stdio: 'inherit', detached: true });
    let timedOut = false;
    const stop = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ } };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    for (const signal of signals) process.once(signal, stop);
    const cleanup = () => { clearTimeout(timer); for (const signal of signals) process.removeListener(signal, stop); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, deadline - Date.now()));
    child.once('error', (error) => { cleanup(); fail(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (timedOut || Date.now() >= deadline) fail(new Error(`timed out after ${limit / 1000}s`));
      else if (code !== 0) fail(new Error(`${label} exited ${code ?? signal}`));
      else ok();
    });
  });
  try {
    report('running', 'Copying worktree configuration…');
    // Discovery and copying can block (large or remote filesystems), so they share the install deadline.
    await execute(process.execPath, [fileURLToPath(import.meta.url), '--copy', job.repo, job.dir], 'copying configuration');
    for (const command of setupCommands(job.dir, job.options)) {
      report('running', `Running ${command}`);
      await execute('/bin/sh', ['-c', command], command);
    }
    report('ready', 'Worktree ready. Starting agent…');
    return true;
  } catch (e) {
    report('error', `Worktree setup failed: ${(e as Error).message}. Agent was not started. Check the terminal and repo setup settings, then start a new session.`);
    return false;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--copy') {
    const count = copySetupFiles(process.argv[3], process.argv[4]);
    console.log(`Copied ${count} configuration file${count === 1 ? '' : 's'}.`);
  } else {
    const file = process.argv[2];
    try {
      const job = JSON.parse(readFileSync(file, 'utf8')) as SetupJob;
      process.exitCode = await runSetup(job, file + '.status') ? 0 : 1;
    } catch (e) {
      const message = `Worktree setup could not start: ${(e as Error).message}. Agent was not started.`;
      console.error(message);
      writeSetupStatus(file + '.status', { state: 'error', message });
      process.exitCode = 1;
    }
  }
}
