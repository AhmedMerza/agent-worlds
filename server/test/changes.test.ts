import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { changesOf, fileDiff } from '../src/review.ts';
import { computeConflicts } from '../src/conflicts.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { repoInfo } from '../src/sys.ts';
import { tmp } from './fixtures.ts';

const TOKEN = 'c'.repeat(64);
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim();
function gitRepo(): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 't@example.com'); git(d, 'config', 'user.name', 'T');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n'); writeFileSync(join(d, 'gone.txt'), 'x\n'); writeFileSync(join(d, 'old.txt'), 'keep\nthis\nfile\n');
  git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}

test('changes: committed, uncommitted, untracked, deleted and renamed files, with a sig that moves when content does', async () => {
  const d = gitRepo();
  const base = git(d, 'rev-parse', 'HEAD');
  writeFileSync(join(d, 'b.txt'), 'b1\nb2\n'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'add b');
  writeFileSync(join(d, 'a.txt'), 'one\nTWO\n');
  unlinkSync(join(d, 'gone.txt'));
  renameSync(join(d, 'old.txt'), join(d, 'new-name.txt')); git(d, 'add', '-A', 'old.txt', 'new-name.txt');
  writeFileSync(join(d, 'fresh.txt'), 'f1\nf2\nf3\n');

  const c = (await changesOf(d, base))!;
  const by = Object.fromEntries(c.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['a.txt', 'b.txt', 'fresh.txt', 'gone.txt', 'new-name.txt']);
  assert.deepEqual([by['b.txt'].status, by['b.txt'].uncommitted], ['A', false], 'committed in the session');
  assert.deepEqual([by['a.txt'].status, by['a.txt'].uncommitted, by['a.txt'].added, by['a.txt'].deleted], ['M', true, 1, 1]);
  assert.deepEqual([by['gone.txt'].status, by['gone.txt'].sig], ['D', 'deleted']);
  assert.deepEqual([by['new-name.txt'].status, by['new-name.txt'].from], ['R', 'old.txt']);
  assert.deepEqual([by['fresh.txt'].untracked, by['fresh.txt'].added], [true, 3]);
  assert.equal(c.more, 0);

  assert.match(await fileDiff(d, c.base, by['a.txt']), /^-two$\n^\+TWO$/m);
  assert.match(await fileDiff(d, c.base, by['fresh.txt']), /^\+f3$/m, 'an untracked file diffs against nothing');
  assert.match(await fileDiff(d, c.base, by['new-name.txt']), /rename from old\.txt/, 'a rename shows as one, not as an add');

  const sig = by['a.txt'].sig;
  writeFileSync(join(d, 'a.txt'), 'one\nTWO\nthree\n');
  const again = (await changesOf(d, base))!.files.find((f) => f.path === 'a.txt')!;
  assert.notEqual(again.sig, sig, 'editing a file changes its sig, so a viewed tick goes stale');
});

test('conflicts: two worktrees that changed one file say so; one folder does not repeat it', () => {
  const c = computeConflicts([
    { id: 'a', repo: '/r', cwd: '/r-wt/a', branch: 'aw/a', worktree: true, testing: false, files: ['src/x.ts', 'README.md'] },
    { id: 'b', repo: '/r', cwd: '/r-wt/b', branch: 'aw/b', worktree: true, testing: false, files: ['src/x.ts'] },
    { id: 'c', repo: '/r', cwd: '/r-wt/b', branch: 'aw/b', worktree: true, testing: false, files: ['src/x.ts'] },
    { id: 'd', repo: '/other', cwd: '/other', branch: 'main', worktree: false, testing: false, files: ['src/x.ts'] },
  ]);
  assert.deepEqual(c.get('a'), [{ withId: 'b', reason: 'both changed src/x.ts' }, { withId: 'c', reason: 'both changed src/x.ts' }]);
  assert.deepEqual(c.get('b'), [{ withId: 'a', reason: 'both changed src/x.ts' }, { withId: 'c', reason: 'same folder' }]);
  assert.deepEqual(c.get('d'), [], 'another repo never overlaps');
});

test('changes over HTTP: list, one file\'s diff, viewed ticks; a path outside the list is refused', async () => {
  const repo = gitRepo();
  const cfg = { ...parseConfig({ worlds: [{ id: 'w', name: 'W', repos: [repo] }] }), port: 0 };
  const app = startServer(cfg, TOKEN, { home: tmp(), procRoot: join(tmp(), 'none'), deps: { repoInfo, branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' } } as any);
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json', 'x-aw-pane': '%7' };
  const get = (p: string) => fetch(`${base}/api/sessions/s-1/${p}`, { headers: H });
  try {
    await fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify({ session_id: 's-1', cwd: repo, transcript_path: '', hook_event_name: 'SessionStart', source: 'startup' }) });
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n');
    const list = await get('changes');
    assert.equal(list.status, 200);
    assert.deepEqual((await list.json() as any).files.map((f: any) => f.path), ['a.txt']);

    const d = await get('diff?path=a.txt');
    assert.match((await d.json() as any).diff, /^\+TWO$/m);
    for (const p of ['/etc/passwd', '../a.txt', 'gone.txt']) assert.equal((await get(`diff?path=${encodeURIComponent(p)}`)).status, 404, p);

    const tick = (path: string, viewed: boolean) => fetch(`${base}/api/sessions/s-1/viewed`, { method: 'POST', headers: H, body: JSON.stringify({ path, viewed }) });
    assert.equal((await tick('a.txt', true)).status, 200);
    assert.equal((await tick('nope.txt', true)).status, 404);
    const state = async () => ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).sessions.find((s: any) => s.id === 's-1');
    const s = await state();
    assert.equal(s.viewed['a.txt'], s.changes.files[0].sig);
    assert.equal((await tick('a.txt', false)).status, 200);
    assert.deepEqual((await state()).viewed, {});

    // An edit by the agent reaches the list on its own, from the tool-use hook, with no request for it.
    writeFileSync(join(repo, 'b.txt'), 'new\n');
    await fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify({ session_id: 's-1', cwd: repo, transcript_path: '', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: join(repo, 'b.txt') }, tool_response: {} }) });
    let paths: string[] = [];
    for (let i = 0; i < 60 && paths.length < 2; i++) { await new Promise((r) => setTimeout(r, 100)); paths = (await state()).changes.files.map((f: any) => f.path); }
    assert.deepEqual(paths.sort(), ['a.txt', 'b.txt']);
  } finally { await app.close(); }
});
