import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeWorktree } from '../src/sys.ts';
import { tmp } from './fixtures.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim();

/** A repo pushed to a bare remote, plus a worktree where Agent Worlds puts one (<repo>-worktrees/<name>). */
function setup(name = 'aw-x') {
  const base = tmp(), repo = join(base, 'r'), remote = join(base, 'remote.git'), dir = join(`${repo}-worktrees`, name);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(repo, 'config', k, v);
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'worktree', 'add', '-q', '-b', `aw/${name}`, dir, 'origin/main');
  return { repo, dir, branch: `aw/${name}` };
}
const hasBranch = (repo: string, b: string) => git(repo, 'branch', '--list', b) !== '';

test('a clean worktree with nothing unpushed is removed, and its merged branch with it', async () => {
  const { repo, dir, branch } = setup();
  assert.equal(await removeWorktree(dir, repo), null);
  assert.equal(existsSync(dir), false);
  assert.equal(hasBranch(repo, branch), false);
});

test('pushed but unmerged work: the worktree goes, the branch stays', async () => {
  const { repo, dir, branch } = setup();
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'work');
  git(dir, 'push', '-q', 'origin', branch);
  assert.equal(await removeWorktree(dir, repo), null);
  assert.equal(existsSync(dir), false);
  assert.equal(hasBranch(repo, branch), true);
});

test('anything that would be lost keeps the worktree', async () => {
  const dirty = setup();
  writeFileSync(join(dirty.dir, 'new.txt'), 'x');
  assert.match(await removeWorktree(dirty.dir, dirty.repo) ?? '', /untracked/);
  assert.equal(existsSync(dirty.dir), true);

  const unpushed = setup();
  git(unpushed.dir, 'commit', '-q', '--allow-empty', '-m', 'local only');
  assert.match(await removeWorktree(unpushed.dir, unpushed.repo) ?? '', /1 commit\(s\) no remote has/);
  assert.equal(existsSync(unpushed.dir), true);
});

test('a worktree Agent Worlds did not make, or one already gone, is left alone', async () => {
  const { repo } = setup();
  const elsewhere = join(tmp(), 'mine');
  git(repo, 'worktree', 'add', '-q', '-b', 'mine', elsewhere, 'origin/main');
  assert.equal(await removeWorktree(elsewhere, repo), undefined);
  assert.equal(existsSync(elsewhere), true);
  assert.equal(await removeWorktree(join(`${repo}-worktrees`, 'gone'), repo), undefined);
});

test('the server cleans a worktree only when its session ended for good, never on a restart, a shared folder or shutdown', async () => {
  const { startServer } = await import('../src/server.ts');
  const { parseConfig } = await import('../src/config.ts');
  const repo = '/work/bakery', wt = (n: string) => `${repo}-worktrees/${n}`;
  const removed: string[] = [];
  let panes = new Map([['%1', new Set(['aw'])], ['%2', new Set(['aw'])], ['%3', new Set(['aw'])], ['%4', new Set(['aw'])], ['%5', new Set(['aw'])]]);
  const app = startServer({ ...parseConfig({}), port: 0 }, 'w'.repeat(64), {
    home: tmp(), procRoot: join(tmp(), 'missing'),
    deps: { repoInfo: async (cwd: string) => ({ repo, branch: 'b', worktree: true, top: cwd }), branchOf: async () => 'b', tmuxSessionOf: async () => 'aw' },
    endPane: async () => null, tmuxPanes: async () => panes,
    removeWorktree: async (dir: string, r: string) => { assert.equal(r, repo); removed.push(dir); return null; },
  });
  await app.listen();
  const start = (id: string, cwd: string, pane: string) => app.store.handle({ session_id: id, hook_event_name: 'SessionStart', cwd }, pane);
  const end = (id: string) => fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/sessions/${id}/end`, { method: 'POST', headers: { 'x-aw-token': 'w'.repeat(64) }, body: '{"force":true}' });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    await start('ended', wt('a'), '%1');
    assert.equal((await end('ended')).status, 200); await settle();
    assert.deepEqual(removed, [wt('a')], 'End cleans it');

    await start('quit', wt('b'), '%2');
    await app.store.handle({ session_id: 'quit', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, '%2'); await settle();
    assert.deepEqual(removed, [wt('a'), wt('b')], '/exit cleans it');

    await start('restarted', wt('c'), '%3');
    await app.store.handle({ session_id: 'restarted', hook_event_name: 'SessionEnd', reason: 'other' }, '%3'); await settle();
    assert.equal(removed.length, 2, 'a restart (or any end that may resume) keeps it');

    await start('one', wt('d'), '%4'); await start('two', wt('d'), '%5');
    assert.equal((await end('one')).status, 200); await settle();
    assert.equal(removed.length, 2, 'another session still works in it');

    panes = new Map([['%3', new Set(['aw'])]]); // %5 closed by itself (the agent quit at its first prompt)
    await app.sweep(); await settle();
    assert.deepEqual(removed.slice(2), [wt('d')], 'a pane that closed by itself cleans it');
  } finally {
    await start('live', wt('e'), '%3');
    await app.close(); await settle();
    assert.equal(removed.includes(wt('e')), false, 'shutting the server down keeps it');
  }
});
