import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './fixtures.ts';
import { WorktreeCleanup, CLEANUP_DELAY, recordWorktree, processUse } from '../src/worktree-cleanup.ts';
import type { ForgeChange } from '../src/forge.ts';
import { Recovery } from '../src/recovery.ts';

const git = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(owned = true) {
  const root = tmp('aw-cleanup-'), repo = join(root, 'repo'), remote = join(root, 'remote.git'), home = join(root, 'home'), proc = join(root, 'proc');
  mkdirSync(repo); mkdirSync(proc);
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'file'), 'base'); writeFileSync(join(repo, '.gitignore'), 'ignored\n.aw/\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'base');
  git(root, 'init', '--bare', remote); git(repo, 'remote', 'add', 'origin', remote); git(repo, 'push', '-u', 'origin', 'main');
  const branch = owned ? 'aw/test' : 'manual/test', dir = join(`${repo}-worktrees`, owned ? 'aw-test' : 'manual-test');
  git(repo, 'worktree', 'add', '-b', branch, dir);
  writeFileSync(join(dir, 'file'), 'changed'); git(dir, 'commit', '-am', 'work'); git(dir, 'push', '-u', 'origin', branch);
  const head = git(dir, 'rev-parse', 'HEAD'), now = Date.now();
  let change: ForgeChange | null = { state: 'merged', headSha: head, mergedAt: new Date(now - CLEANUP_DELAY).toISOString(), url: 'https://example.com/pr/1' };
  let unavailable = false;
  const live: string[] = [], removed: string[] = [];
  const recovery = new Recovery(join(home, 'recoverable.json'));
  recovery.upsert({ id: 'old-session', agent: 'codex', cwd: dir, task: null, lastPrompt: null, updatedAt: now });
  const cleaner = new WorktreeCleanup({ home, repos: () => [repo], liveDirs: () => live, procRoot: proc, now: () => now,
    forge: async () => { if (unavailable) throw new Error('offline'); return change; }, onRemoved: (d) => { removed.push(d); recovery.dropFolder(d); } });
  return { root, repo, remote, home, proc, branch, dir, head, now, live, removed, cleaner, recovery,
    change: (c: Partial<ForgeChange>) => { change = { ...change!, ...c }; }, offline: () => { unavailable = true; } };
}

test('merged at identical SHA for three days: removes owned checkout, local branch and resume entries; remote stays', async () => {
  const f = await fixture();
  assert.deepEqual(await f.cleaner.sweep(), [{ dir: f.dir, removed: true, reason: null }]);
  assert.equal(existsSync(f.dir), false);
  assert.equal(git(f.repo, 'branch', '--list', f.branch), '');
  assert.equal(git(f.repo, 'ls-remote', '--heads', 'origin', `refs/heads/${f.branch}`).split(/\s/)[0], f.head);
  assert.deepEqual(f.recovery.list(), []); assert.deepEqual(f.removed, [f.dir]);
});

const keeps: [string, (f: Awaited<ReturnType<typeof fixture>>) => void | Promise<void>][] = [
  ['assume-unchanged tracked file', (f) => { git(f.dir, 'update-index', '--assume-unchanged', 'file'); writeFileSync(join(f.dir, 'file'), 'hidden changes'); }],
  ['skip-worktree tracked file', (f) => { git(f.dir, 'update-index', '--skip-worktree', 'file'); writeFileSync(join(f.dir, 'file'), 'hidden changes'); }],
  ['process scan unavailable', (f) => { rmSync(f.proc, { recursive: true }); }],
  ['dirty tracked file', (f) => { writeFileSync(join(f.dir, 'file'), 'unsaved'); }],
  ['untracked file', (f) => { writeFileSync(join(f.dir, 'new-file'), 'unsaved'); }],
  ['ignored file', (f) => { writeFileSync(join(f.dir, 'ignored'), 'secret'); }],
  ['run or handoff data', (f) => { mkdirSync(join(f.dir, '.aw')); writeFileSync(join(f.dir, '.aw', 'handoff.md'), 'notes'); }],
  ['tracked run data', (f) => { mkdirSync(join(f.dir, '.aw')); writeFileSync(join(f.dir, '.aw', 'handoff.md'), 'notes'); git(f.dir, 'add', '-f', '.aw'); git(f.dir, 'commit', '-m', 'notes'); git(f.dir, 'push'); f.change({ headSha: git(f.dir, 'rev-parse', 'HEAD') }); }],
  ['unpushed commit', (f) => { writeFileSync(join(f.dir, 'file'), 'local'); git(f.dir, 'commit', '-am', 'local'); f.change({ headSha: git(f.dir, 'rev-parse', 'HEAD') }); }],
  ['merged at another SHA', (f) => { f.change({ headSha: git(f.repo, 'rev-parse', 'main') }); }],
  ['less than three days', (f) => { f.change({ mergedAt: new Date(f.now - CLEANUP_DELAY + 1).toISOString() }); }],
  ['invalid merge time', (f) => { f.change({ mergedAt: 'not-a-time' }); }],
  ['unmerged request', (f) => { f.change({ state: 'open' }); }],
  ['forge unreachable', (f) => { f.offline(); }],
  ['remote unreachable', (f) => { git(f.repo, 'remote', 'set-url', 'origin', join(f.root, 'absent.git')); }],
  ['live managed session or run', (f) => { f.live.push(join(f.dir, 'subfolder')); }],
  ['live process cwd', (f) => { mkdirSync(join(f.proc, '123')); symlinkSync(f.dir, join(f.proc, '123', 'cwd')); }],
];
for (const [name, mutate] of keeps) test(`keeps ${name} with real git`, async () => {
  const f = await fixture(); await mutate(f);
  const result = await f.cleaner.remove(f.dir);
  assert.equal(result.removed, false, result.reason ?? name);
  assert.ok(result.reason);
  if (['dirty tracked file', 'untracked file', 'ignored file', 'run or handoff data'].includes(name)) assert.equal(result.reason, 'Uncommitted, untracked or ignored files');
  if (name === 'tracked run data') assert.equal(result.reason, 'Run or handoff data in .aw/');
  if (name === 'live managed session or run' || name === 'live process cwd') assert.equal(result.reason, 'In use by a session, run or process');
  if (name === 'assume-unchanged tracked file' || name === 'skip-worktree tracked file') assert.equal(result.reason, 'Tracked files hide changes from Git status');
  if (name === 'process scan unavailable') assert.equal(result.reason, 'Cannot verify running processes');
  assert.ok(existsSync(f.dir));
  assert.equal(git(f.repo, 'branch', '--list', f.branch).includes(f.branch), true);
  assert.equal(f.recovery.list().length, 1);
});

test('non-AW worktrees: read-only list and automatic sweep never remove; explicit click uses all safety checks', async () => {
  const f = await fixture(false);
  const rows = await f.cleaner.list(); assert.equal(rows.length, 1); assert.equal(rows[0].owned, false); assert.ok(rows[0].bytes! > 0); assert.equal(rows[0].live, false);
  assert.deepEqual(await f.cleaner.sweep(), []); assert.equal((await f.cleaner.remove(f.dir)).removed, false); assert.ok(existsSync(f.dir));
  writeFileSync(join(f.dir, 'ignored'), 'secret'); assert.equal((await f.cleaner.remove(f.dir, true)).removed, false);
});
test('explicit removal of safe non-AW worktree', async () => { const f = await fixture(false); assert.equal((await f.cleaner.remove(f.dir, true)).removed, true); });
test('both legacy path AND aw branch required for automatic ownership', async () => {
  const f = await fixture(); git(f.dir, 'branch', '-m', 'manual/renamed');
  assert.equal((await f.cleaner.list())[0].owned, false); assert.deepEqual(await f.cleaner.sweep(), []); assert.ok(existsSync(f.dir));
});
test('creation record proves ownership outside legacy naming, preserves base SHA, and records removal', async () => {
  const f = await fixture(false);
  await recordWorktree(f.home, { session: 'terminal-1', repo: f.repo, dir: f.dir, branch: f.branch, baseSha: git(f.repo, 'rev-parse', 'main'), createdAt: f.now });
  assert.equal((await f.cleaner.list())[0].owned, true);
  assert.equal((await f.cleaner.sweep())[0].removed, true);
  const record = JSON.parse(readFileSync(join(f.home, 'worktrees', 'terminal-1.json'), 'utf8'));
  assert.equal(record.removedAt, f.now); assert.equal(record.baseSha, git(f.repo, 'rev-parse', 'main'));
});
test('missing proc directory is unknown', async () => { assert.equal(await processUse('/tmp/anything', '/does-not-exist-aw-120'), null); });
test('real child with cwd in checkout blocks removal', async () => {
  const f = await fixture(); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.dir, stdio: 'ignore' });
  try { assert.equal(await processUse(f.dir), true); } finally { child.kill(); await new Promise((r) => child.once('exit', r)); }
});

test('list performs no forge or remote reads and never removes', async () => {
  const f = await fixture();
  const cleaner = new WorktreeCleanup({ home: f.home, repos: () => [f.repo], liveDirs: () => [], procRoot: f.proc,
    forge: async () => { throw new Error('list must not call forge'); } });
  const rows = await cleaner.list(f.repo); assert.equal(rows[0].reason, null); assert.ok(existsSync(f.dir));
  assert.deepEqual(await cleaner.list('/not-configured'), []);
});

test('merged identical SHA with source branch deleted: removes checkout and local branch', async () => {
  const f = await fixture(); git(f.repo, 'push', 'origin', '--delete', f.branch);
  assert.equal((await f.cleaner.remove(f.dir)).removed, true);
  assert.equal(existsSync(f.dir), false); assert.equal(git(f.repo, 'branch', '--list', f.branch), '');
});

test('server inventory, explicit confirmation, live session protection, removed-folder history and recovery pruning', async () => {
  const { startServer } = await import('../src/server.ts');
  const { parseConfig } = await import('../src/config.ts');
  const f = await fixture(false), token = 'cleanup-test-token', logs = join(f.home, 'logs');
  mkdirSync(logs, { recursive: true });
  const project = join(logs, f.dir.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(project);
  writeFileSync(join(project, 'session-gone.jsonl'), JSON.stringify({ session_id: 'session-gone', cwd: f.dir, type: 'last-prompt', lastPrompt: 'past work' }) + '\n');
  new Recovery(join(f.home, 'recovery.json')).upsert({ id: 'session-gone', agent: 'codex', cwd: f.dir, task: null, lastPrompt: null, updatedAt: f.now });
  const app = startServer({ ...parseConfig({ worlds: [{ id: 'test', repos: [f.repo] }], claudeProjectsDir: logs }), port: 0 }, token, {
    home: f.home, procRoot: f.proc, tmuxPanes: async () => new Map(),
    deps: { repoInfo: async () => ({ repo: f.repo, branch: f.branch, worktree: true }), tmuxSessionOf: async () => 'aw-test-120-mocked' },
    cleanupForge: async () => ({ state: 'merged', headSha: f.head, mergedAt: new Date(f.now - CLEANUP_DELAY - 1000).toISOString(), url: 'https://example.com/pr/1' }),
  });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { 'x-aw-token': token, 'content-type': 'application/json' };
  const get = (path: string) => fetch(base + path, { headers });
  const remove = (body: unknown) => fetch(base + '/api/worktrees/remove', { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/api/worktrees')).status, 401);
    assert.equal((await (await get('/api/worktrees')).json() as any).worktrees.length, 1);
    assert.ok(existsSync(f.dir)); assert.equal((await remove({ dir: f.dir })).status, 400);
    assert.equal((await remove({ dir: f.repo, confirm: true })).status, 409);
    assert.equal((await (await get('/api/history?repo=' + encodeURIComponent(f.repo))).json() as any).sessions.length, 1);
    await app.store.handle({ session_id: 'session-live', hook_event_name: 'SessionStart', cwd: f.dir }, '%120');
    assert.equal((await remove({ dir: f.dir, confirm: true })).status, 409);
    app.store.remove(app.store.sessions.get('session-live')!);
    await app.store.handle({ session_id: 'session-hook-only', hook_event_name: 'SessionStart', cwd: f.dir }, null);
    assert.equal((await remove({ dir: f.dir, confirm: true })).status, 409, 'a live hook-only session needs no tmux pane to protect its folder');
    app.store.remove(app.store.sessions.get('session-hook-only')!);
    assert.equal((await remove({ dir: f.dir, confirm: true })).status, 200);
    assert.deepEqual((await (await get('/api/history?repo=' + encodeURIComponent(f.repo))).json() as any).sessions, []);
    assert.deepEqual(new Recovery(join(f.home, 'recovery.json')).list(), []);
    assert.equal((await remove({ dir: f.dir, confirm: true })).status, 409);
  } finally { await app.close(); }
});

test('changes made while forge checks run are rechecked before removal', async () => {
  const f = await fixture();
  const cleaner = new WorktreeCleanup({ home: f.home, repos: () => [f.repo], liveDirs: () => [], procRoot: f.proc,
    forge: async () => { writeFileSync(join(f.dir, 'ignored'), 'new secret'); return { state: 'merged', headSha: f.head, mergedAt: new Date(f.now - CLEANUP_DELAY - 1000).toISOString(), url: 'https://example.com/pr/1' }; } });
  assert.equal((await cleaner.remove(f.dir)).removed, false); assert.ok(existsSync(join(f.dir, 'ignored')));
});

test('branch advancing between inspection and deletion is kept by atomic expected-SHA delete', async () => {
  const f = await fixture(), next = git(f.repo, 'rev-parse', 'main');
  const cleaner = new WorktreeCleanup({ home: f.home, repos: () => [f.repo], liveDirs: () => [], procRoot: f.proc,
    forge: async () => ({ state: 'merged', headSha: f.head, mergedAt: new Date(f.now - CLEANUP_DELAY - 1000).toISOString(), url: 'https://example.com/pr/1' }),
    onRemoved: () => { git(f.repo, 'update-ref', `refs/heads/${f.branch}`, next, f.head); },
  });
  const result = await cleaner.remove(f.dir);
  assert.equal(result.removed, true); assert.match(result.reason!, /local branch kept/);
  assert.equal(git(f.repo, 'rev-parse', `refs/heads/${f.branch}`), next);
});

test('hidden tracked changes introduced during merge verification are kept', async () => {
  const f = await fixture();
  const cleaner = new WorktreeCleanup({ home: f.home, repos: () => [f.repo], liveDirs: () => [], procRoot: f.proc,
    forge: async () => { git(f.dir, 'update-index', '--assume-unchanged', 'file'); writeFileSync(join(f.dir, 'file'), 'hidden while checking'); return { state: 'merged', headSha: f.head, mergedAt: new Date(f.now - CLEANUP_DELAY - 1000).toISOString(), url: 'https://example.com/pr/1' }; } });
  assert.equal((await cleaner.remove(f.dir)).removed, false); assert.equal(readFileSync(join(f.dir, 'file'), 'utf8'), 'hidden while checking');
});

test('duplicate checkout of same branch keeps both folders and the branch', async () => {
  const f = await fixture(), other = join(f.root, 'second-checkout');
  git(f.repo, 'worktree', 'add', '--force', other, f.branch);
  assert.equal((await f.cleaner.remove(f.dir)).removed, false);
  assert.ok(existsSync(f.dir)); assert.equal(git(other, 'rev-parse', 'HEAD'), f.head);
});

test('new checkout attached after folder removal keeps the local branch', async () => {
  const f = await fixture(), other = join(f.root, 'new-checkout');
  const cleaner = new WorktreeCleanup({ home: f.home, repos: () => [f.repo], liveDirs: () => [], procRoot: f.proc,
    forge: async () => ({ state: 'merged', headSha: f.head, mergedAt: new Date(f.now - CLEANUP_DELAY - 1000).toISOString(), url: 'https://example.com/pr/1' }),
    onRemoved: () => { git(f.repo, 'worktree', 'add', other, f.branch); } });
  const result = await cleaner.remove(f.dir);
  assert.equal(result.removed, true); assert.match(result.reason!, /checked out elsewhere/);
  assert.equal(git(other, 'rev-parse', 'HEAD'), f.head);
});

test('symbolic ref retargeted after folder removal never deletes the primary branch', async () => {
  const f = await fixture();
  git(f.repo, 'update-ref', 'refs/heads/main', f.head);
  const cleaner = new WorktreeCleanup({ home: f.home, repos: () => [f.repo], liveDirs: () => [], procRoot: f.proc,
    forge: async () => ({ state: 'merged', headSha: f.head, mergedAt: new Date(f.now - CLEANUP_DELAY - 1000).toISOString(), url: 'https://example.com/pr/1' }),
    onRemoved: () => { git(f.repo, 'symbolic-ref', `refs/heads/${f.branch}`, 'refs/heads/main'); } });
  assert.equal((await cleaner.remove(f.dir)).removed, true);
  assert.equal(git(f.repo, 'branch', '--list', 'main').includes('main'), true, 'deletion must not dereference a concurrently retargeted branch');
});
