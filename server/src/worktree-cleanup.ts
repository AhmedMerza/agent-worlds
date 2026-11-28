import { promisify } from 'node:util';
import { readdir, readlink, realpath, lstat, readFile, mkdir, writeFile, rename, mkdtemp, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { execFile } from './child.ts';
import { branchChange, type ForgeLookup } from './forge.ts';

const run = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await run('git', ['-C', repo, ...args], {
  timeout: 15_000, maxBuffer: 4 << 20,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' },
})).stdout.trimEnd();
const inside = (path: string, parent: string) => path === parent || path.startsWith(parent + sep);
export const CLEANUP_DELAY = 3 * 24 * 3600_000;
export type WorktreeRecord = { session: string; repo: string; dir: string; branch: string; baseSha: string; createdAt: number; removedAt?: number };
export type WorktreeRow = { repo: string; dir: string; branch: string | null; head: string; owned: boolean; bytes: number | null; ageMs: number; live: boolean | null; reason: string | null; url?: string };
export type CleanupOptions = { home: string; repos: () => string[]; liveDirs: () => string[]; procRoot?: string; forge?: ForgeLookup; now?: () => number; onRemoved?: (dir: string) => void; step?: (step: 'beforeQuarantine' | 'afterQuarantine' | 'beforeBranchDelete', dir: string) => void | Promise<void> };

async function branchCheckouts(repo: string, branch: string): Promise<string[]> {
  const raw = await git(repo, 'worktree', 'list', '--porcelain', '-z');
  return raw.split('\0\0').filter((block) => {
    const fields = block.split('\0');
    if (!fields.some((f) => f.startsWith('worktree ')) || fields.includes('bare')) return false;
    // An initializing add may have resolved this branch but not written HEAD yet.
    return fields.includes(`branch refs/heads/${branch}`) || fields.includes('locked initializing')
      || !fields.some((f) => /^HEAD [a-f0-9]{40,64}$/.test(f) && !/^HEAD 0+$/.test(f));
  })
    .flatMap((block) => block.split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice(9)));
}

/** One creation-state file per terminal, outside the checkout so ignored data is never thrown away. */
export async function recordWorktree(home: string, record: WorktreeRecord) {
  const folder = join(home, 'worktrees');
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, record.session + '.json');
  await writeFile(file + '.tmp', JSON.stringify(record), { mode: 0o600 });
  await rename(file + '.tmp', file);
}

/** Every process counts, including shells and dev servers. Inaccessible /proc is unknown, never idle. */
export async function processUse(dir: string, procRoot = '/proc'): Promise<boolean | null> {
  let names: string[];
  try { names = await readdir(procRoot); } catch { return null; }
  let unknown = false;
  for (const pid of names.filter((n) => /^\d+$/.test(n))) {
    const folder = join(procRoot, pid);
    try {
      // Deleted-but-open files still belong to the checkout. Include directory handles,
      // mapped files and executable/root links, not just the process's current directory.
      const uses = (path: string) => inside(path.replace(/ \(deleted\)$/, ''), dir);
      for (const link of ['cwd', 'exe', 'root']) if (uses(await readlink(join(folder, link)))) return true;
      for (const fd of await readdir(join(folder, 'fd'))) if (uses(await readlink(join(folder, 'fd', fd)))) return true;
      const maps = await readFile(join(folder, 'maps'), 'utf8');
      for (const line of maps.split('\n')) {
        const path = line.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/)?.[1];
        if (path && uses(path.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))))) return true;
      }
    } catch {
      // Ignore only a process proven gone. Permission failures (any UID), missing
      // links on a live process and racing fd closures cannot prove the tree idle.
      try { await lstat(folder); unknown = true; }
      catch (e) { if (!['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) unknown = true; }
    }
  }
  return unknown ? null : false;
}

/** A Git add may have resolved a ref before registering its checkout. Fail closed
 * for every UID. Scan before the final worktree list: an add that exits during
 * this scan must have registered by the time that subsequent list is read. */
async function gitRunning(procRoot = '/proc'): Promise<boolean | null> {
  let names: string[];
  try { names = await readdir(procRoot); } catch { return null; }
  let unknown = false;
  for (const pid of names.filter((n) => /^\d+$/.test(n))) {
    const folder = join(procRoot, pid);
    try {
      if (/^git(?:-|$)/.test(basename((await readlink(join(folder, 'exe'))).replace(/ \(deleted\)$/, '')))) return true;
    } catch {
      try { await lstat(folder); unknown = true; }
      catch (e) { if (!['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) unknown = true; }
    }
  }
  return unknown ? null : false;
}

async function size(dir: string): Promise<number | null> {
  try {
    const { stdout } = await run('du', ['-sk', '--', dir], { timeout: 10_000 });
    const kb = Number(stdout.split(/\s/)[0]);
    return Number.isFinite(kb) ? kb * 1024 : null;
  } catch { return null; }
}

/** Serialized inventory/removal. Each removal rechecks everything; inventories never authorize deletion. */
export class WorktreeCleanup {
  private lock: Promise<unknown> = Promise.resolve();
  private opts: CleanupOptions;
  constructor(opts: CleanupOptions) { this.opts = opts; }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn); this.lock = next.catch(() => {}); return next;
  }
  private async records(): Promise<WorktreeRecord[]> {
    const dir = join(this.opts.home, 'worktrees');
    const out: WorktreeRecord[] = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      try {
        const r = JSON.parse(await readFile(join(dir, name), 'utf8'));
        if (name === r.session + '.json' && typeof r.repo === 'string' && typeof r.dir === 'string' && typeof r.branch === 'string' && /^[a-f0-9]{40,64}$/.test(r.baseSha)) out.push(r);
      } catch { /* malformed records never prove ownership */ }
    }
    return out;
  }
  private async candidates(): Promise<WorktreeRow[]> {
    const records = await this.records(), rows: WorktreeRow[] = [];
    for (const repo of new Set([...this.opts.repos(), ...records.filter((r) => !r.removedAt).map((r) => r.repo)])) {
      try {
        const canonical = await realpath(repo);
        if (canonical !== resolve(repo)) continue;
        const raw = await git(repo, 'worktree', 'list', '--porcelain', '-z');
        for (const block of raw.split('\0\0')) {
          const fields = block.split('\0');
          const dir = fields.find((s) => s.startsWith('worktree '))?.slice(9);
          if (!dir || dir === repo || fields.includes('bare')) continue;
          const branch = fields.find((s) => s.startsWith('branch refs/heads/'))?.slice(18) ?? null;
          const head = fields.find((s) => s.startsWith('HEAD '))?.slice(5) ?? '';
          const owned = records.some((r) => !r.removedAt && r.repo === repo && r.dir === dir && r.branch === branch)
            || (dirname(dir) === `${repo}-worktrees` && basename(dir).startsWith('aw-') && !!branch?.startsWith('aw/'));
          let ageMs = 0;
          try { ageMs = Math.max(0, (this.opts.now?.() ?? Date.now()) - (await lstat(dir)).birthtimeMs); } catch { /* kept below */ }
          rows.push({ repo, dir, branch, head, owned, bytes: null, ageMs, live: null, reason: null });
        }
      } catch { /* repo cannot be inspected: nothing in it can be removed */ }
    }
    return rows;
  }
  private async inspect(row: WorktreeRow, verifyForge = true): Promise<WorktreeRow> {
    const keep = (reason: string | null) => ({ ...row, reason });
    try {
      if (await realpath(row.dir) !== row.dir || !(await lstat(row.dir)).isDirectory()) return keep('Worktree path changed');
      row.live = this.opts.liveDirs().some((d) => inside(d, row.dir)) || await processUse(row.dir, this.opts.procRoot);
      if (row.live !== false) return keep(row.live ? 'In use by a session, run or process' : 'Cannot verify running processes');
      if (!row.branch) return keep('Detached HEAD');
      const attached = await branchCheckouts(row.repo, row.branch);
      if (attached.length !== 1 || attached[0] !== row.dir) return keep('Local branch is checked out elsewhere');
      if ((await git(row.dir, 'rev-parse', '--show-toplevel')) !== row.dir) return keep('Worktree path changed');
      if ((await git(row.dir, 'ls-files', '-v')).split('\n').some((line) => /^[a-zS]/.test(line))) return keep('Tracked files hide changes from Git status');
      if ((await git(row.dir, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching')).length) return keep('Uncommitted, untracked or ignored files');
      // Even tracked run/handoff notes must survive cleanup.
      try { if ((await readdir(join(row.dir, '.aw'))).length) return keep('Run or handoff data in .aw/'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return keep('Cannot inspect .aw/ data'); }
      if (!verifyForge) return keep(null);
      const remotes = (await git(row.repo, 'remote')).split('\n');
      const target = remotes.includes('upstream') ? 'upstream' : remotes.includes('origin') ? 'origin' : null;
      if (!target) return keep('No forge remote');
      const remote = await git(row.repo, 'remote', 'get-url', target);
      const change = await (this.opts.forge ?? branchChange)(row.repo, remote, row.branch);
      if (!change) return keep('Cannot verify a unique forge change');
      row.url = change.url;
      if (change.state !== 'merged') return keep('Pull or merge request is not merged');
      if (change.headSha !== row.head) return keep('Merged change has a different head SHA');
      const mergedAt = Date.parse(change.mergedAt ?? '');
      if (!Number.isFinite(mergedAt) || (this.opts.now?.() ?? Date.now()) - mergedAt < CLEANUP_DELAY) return keep('Merged less than three days ago or merge time unknown');
      // Check the live remote, not stale tracking refs. A deleted source branch is safe: the merged forge head proves the commits were pushed.
      const source = (await git(row.repo, 'config', '--get', `branch.${row.branch}.remote`).catch(() => '')) || (remotes.includes('origin') ? 'origin' : target);
      if (!remotes.includes(source)) return keep('Cannot verify pushed branch');
      const sourceUrl = await git(row.repo, 'remote', 'get-url', source);
      const pushed = await git(row.repo, 'ls-remote', '--heads', sourceUrl, `refs/heads/${row.branch}`);
      if (pushed && pushed.split(/\s/)[0] !== row.head) return keep('Branch has unpushed commits or remote head changed');
      if ((await git(row.dir, 'rev-parse', 'HEAD')) !== row.head || (await git(row.dir, 'branch', '--show-current')) !== row.branch) return keep('Worktree changed during checks');
      return keep(null);
    } catch { return keep('Safety check failed or forge/remote unreachable'); }
  }
  list(repo?: string): Promise<WorktreeRow[]> {
    return this.serial(async () => {
      const rows = [];
      for (const row of (await this.candidates()).filter((r) => !repo || r.repo === repo)) {
        const checked = await this.inspect(row, false);
        checked.bytes = await size(row.dir).catch(() => null);
        rows.push(checked);
      }
      return rows;
    });
  }
  remove(dir: string, explicit = false): Promise<{ removed: boolean; reason: string | null }> {
    return this.serial(async () => {
      const row = (await this.candidates()).find((r) => r.dir === dir);
      if (!row) return { removed: false, reason: 'Not a registered linked worktree' };
      if (!row.owned && !explicit) return { removed: false, reason: 'Not an Agent Worlds worktree; explicit removal required' };
      const checked = await this.inspect(row);
      if (checked.reason) return { removed: false, reason: checked.reason };
      let quarantine: string | undefined;
      let staging: string | undefined;
      const restore = async () => {
        if (!quarantine) return;
        if (quarantine !== dir) {
          // git worktree move nests into an existing destination directory. Rename
          // instead: a racing nonempty replacement must never be overwritten.
          try { await lstat(dir); throw new Error('Original path is occupied'); }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          await rename(quarantine, dir);
          quarantine = dir;
        }
        await git(row.repo, 'worktree', 'repair', '--', dir);
        quarantine = undefined;
      };
      try {
        // These checks alone cannot protect ignored files written before removal.
        if (this.opts.liveDirs().some((d) => inside(d, dir)) || await processUse(dir, this.opts.procRoot) !== false
          || (await git(dir, 'ls-files', '-v')).split('\n').some((line) => /^[a-zS]/.test(line))
          || (await readdir(join(dir, '.aw')).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })).length
          || (await git(dir, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching')).length
          || (await git(dir, 'rev-parse', 'HEAD')) !== row.head
          || (await git(dir, 'branch', '--show-current')) !== row.branch) return { removed: false, reason: 'Worktree changed during checks' };
        await this.opts.step?.('beforeQuarantine', dir);
        staging = await mkdtemp(join(dirname(dir), `.aw-removing-${basename(dir)}-`));
        const moved = join(staging, 'checkout');
        await git(row.repo, 'worktree', 'move', '--', dir, moved); // Same filesystem; NEVER --force.
        quarantine = moved;
        await this.opts.step?.('afterQuarantine', moved);
        // Writers using the original pathname can now only create a separate folder.
        // Handles that followed the move are detected by the full process scan.
        const final = await this.inspect({ ...row, dir: moved }, false);
        if (final.reason || this.opts.liveDirs().some((d) => inside(d, dir))
          || (await git(moved, 'rev-parse', 'HEAD')) !== row.head
          || (await git(moved, 'branch', '--show-current')) !== row.branch) {
          await restore();
          return { removed: false, reason: final.reason ?? 'Worktree changed during checks' };
        }
        await git(row.repo, 'worktree', 'remove', '--', moved); // NEVER --force
        quarantine = undefined;
        this.opts.onRemoved?.(dir);
        let note: string | null = null;
        let branchDeleted = false;
        let recoveryPending = false;
        try {
          // Atomic compare-and-delete: an external ref update must never lose its new commits.
          if ((await branchCheckouts(row.repo, row.branch!)).length) note = 'Worktree removed; local branch kept because it is checked out elsewhere';
          else {
            await this.opts.step?.('beforeBranchDelete', dir);
            await git(row.repo, 'update-ref', '--no-deref', '-d', `refs/heads/${row.branch}`, row.head);
            branchDeleted = true;
            recoveryPending = true;
            // Git's ref lock does not lock worktree registration. If a checkout raced
            // the deletion (or cannot be inspected), restore create-only: never overwrite
            // a concurrent writer's ref, including a symbolic ref.
            let keepBranch = true;
            try {
              const running = await gitRunning(this.opts.procRoot);
              keepBranch = (await branchCheckouts(row.repo, row.branch!)).length > 0 || running !== false;
            }
            finally {
              if (keepBranch) await git(row.repo, 'update-ref', '--no-deref', `refs/heads/${row.branch}`, row.head, '').catch(async () => {
                await git(row.repo, 'rev-parse', '--verify', `refs/heads/${row.branch}`); // A competing writer already kept it.
              });
            }
            recoveryPending = false;
            if (keepBranch) {
              branchDeleted = false;
              note = 'Worktree removed; local branch kept because another checkout or Git operation may use it';
            }
            if (branchDeleted) await git(row.repo, 'config', '--remove-section', `branch.${row.branch}`).catch((e) => { if (!/no such section/i.test(e.stderr ?? '')) throw e; });
          }
        } catch {
          note = recoveryPending
            ? `Worktree removed; could not verify or restore local branch ${row.branch} at ${row.head}; inspect the branch before continuing`
            : branchDeleted ? 'Worktree and local branch removed; could not clear local branch settings'
              : 'Worktree removed; local branch kept because its head changed or Git refused deletion';
        }
        try {
          for (const r of await this.records()) if (r.dir === dir && r.repo === row.repo) await recordWorktree(this.opts.home, { ...r, removedAt: this.opts.now?.() ?? Date.now() });
        } catch { note = [note, 'Could not update the worktree creation record'].filter(Boolean).join('. '); }
        return { removed: true, reason: note };
      } catch {
        if (quarantine) {
          try { await restore(); }
          catch { return { removed: false, reason: `Worktree kept at ${quarantine}; original path could not be restored` }; }
        }
        return { removed: false, reason: 'Git refused cleanup; inspect the worktree and local branch' };
      } finally {
        if (staging) await rmdir(staging).catch(() => {});
      }
    });
  }
  async sweep() {
    // Inventory is read-only. Automatic removal considers owned checkouts only, with fresh guards each time.
    const rows = await this.serial(() => this.candidates());
    const results = [];
    for (const row of rows) if (row.owned) results.push({ dir: row.dir, ...await this.remove(row.dir) });
    return results;
  }
}
