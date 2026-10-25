import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, realpathSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Insights, normaliseNeeds } from '../src/insights.ts';
import { reviewOf } from '../src/review.ts';
import { createSession, repoInfo } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev, tmp } from './fixtures.ts';

const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'pipe' }).toString().trim();
function gitRepo(): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main'); git(d, 'config', 'user.email', 't@example.com'); git(d, 'config', 'user.name', 'T');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'init');
  return d;
}
const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); assert.ok(f(), 'timed out'); };

function setup(over: Record<string, unknown> = {}, repo = '/work/repo-a') {
  const cfg = parseConfig({ claudeProjectsDir: realpathSync(tmpdir()) });
  const store = new Store(cfg, {
    repoInfo: async () => ({ repo, branch: 'main', worktree: false, top: repo, head: 'abc1234' }),
    branchOf: async () => 'main', tmuxSessionOf: async () => null, clientsConnected: () => false, holdMs: 1000,
    stats: { get: () => 0, inc: () => 1 }, ...over,
  } as any, () => {});
  return { store, s: () => store.sessions.get('sess-1')! as any };
}

test('review is relative to baseSha: committed + uncommitted + untracked, other work excluded', async () => {
  const d = gitRepo();
  // someone else's earlier commit on this branch is before the session's base
  writeFileSync(join(d, 'old.txt'), 'old\n'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'before session');
  const base = git(d, 'rev-parse', 'HEAD');
  writeFileSync(join(d, 'b.txt'), 'b1\nb2\n'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'add b');
  writeFileSync(join(d, 'a.txt'), 'one\nTWO\n');
  writeFileSync(join(d, 'new.txt'), 'n\n');
  const r = (await reviewOf(d, null, base))!;
  assert.equal(r.baseSha, base);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ['a.txt', 'b.txt', 'new.txt']);
  assert.deepEqual(r.commits.map((c) => c.subject), ['add b']);
  assert.equal(r.commits[0].sha, git(d, 'rev-parse', 'HEAD'));
  assert.deepEqual(r.uncommitted.map((f) => f.path).sort(), ['a.txt', 'new.txt']);
  assert.ok(!/old\.txt/.test(r.diff));
  // after committing everything nothing is uncommitted
  git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'rest');
  const r2 = (await reviewOf(d, null, base))!;
  assert.deepEqual(r2.uncommitted, []);
  assert.deepEqual(r2.commits.map((c) => c.subject), ['rest', 'add b']);
  // unknown base: old behaviour, baseSha null
  const r3 = (await reviewOf(d, null, null))!;
  assert.equal(r3.baseSha, null);
  assert.equal((await reviewOf(d, null, 'deadbeefdeadbeef'))!.baseSha, null);
});

test('review attaches only to done cards', async () => {
  const d = gitRepo();
  writeFileSync(join(d, 'a.txt'), 'x\n');
  const { store, s } = setup({}, d);
  const ins = new Insights(store, 'unused', { summarise: async () => ({ did: '', needs: '' }) });
  store.deps.onEvent = (x, e) => ins.onEvent(x, e);
  await store.handle({ ...ev.stop, cwd: d, last_assistant_message: 'Which one?' }, null);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s().card.review, undefined);
});

test('review follows the worktree a session committed in, with its branch', async () => {
  const main = gitRepo();
  const wt = join(tmp(), 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  writeFileSync(join(main, 'unrelated.txt'), 'someone else\n'); // dirty main checkout: not this session's work
  const store = new Store(parseConfig({}), {
    repoInfo, branchOf: async () => 'main', tmuxSessionOf: async () => null, clientsConnected: () => false, holdMs: 1000,
    stats: { get: () => 0, inc: () => 1 }, onEvent: (s, e) => ins.onEvent(s, e),
  }, () => {});
  const ins = new Insights(store, 'unused', { summarise: async () => ({ did: '', needs: '' }) });
  await store.handle({ ...ev.prompt, cwd: main }, null);
  writeFileSync(join(wt, 'b.txt'), 'b\n'); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', 'journey screen');
  await store.handle({ ...ev.postBash, cwd: main, tool_input: { command: `cd ${wt} && git commit -m 'journey screen'` } }, null);
  await waitFor(() => store.sessions.get('sess-1')!.reviewTop === wt);
  await store.handle({ ...ev.stop, cwd: main }, null);
  const s = store.sessions.get('sess-1')! as any;
  await waitFor(() => !!s.card?.review);
  assert.equal(s.card.review.dir, wt);
  assert.equal(s.card.review.branch, 'feat/x');
  assert.equal(s.card.review.elsewhere, true);
  assert.deepEqual(s.card.review.commits.map((c: any) => c.subject), ['journey screen']);
  assert.ok(!s.card.review.uncommitted.some((f: any) => f.path === 'unrelated.txt'), 'the main checkout is not reviewed');
});

test('without a baseSha, review forks from the nearest default branch, not a stale origin ref', async () => {
  const d = gitRepo();
  git(d, 'update-ref', 'refs/remotes/origin/dev', 'HEAD'); // fetched long ago, never updated
  git(d, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/dev');
  git(d, 'checkout', '-q', '-b', 'dev');
  for (const n of ['x', 'y', 'z']) { writeFileSync(join(d, n), n); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'dev ' + n); }
  git(d, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(d, 'f.txt'), 'f\n'); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', 'feature work');
  const r = (await reviewOf(d, null))!;
  assert.deepEqual(r.commits.map((c) => c.subject), ['feature work']);
  assert.deepEqual(r.files.map((f) => f.path), ['f.txt']);
});

test('without a baseSha: no remote, an unrelated ref, no default branch, detached HEAD', async () => {
  const commit = (d: string, n: string) => { writeFileSync(join(d, n), n); git(d, 'add', '.'); git(d, 'commit', '-q', '-m', n); };
  // no remote, default branch master
  const a = gitRepo(); git(a, 'branch', '-m', 'master'); git(a, 'checkout', '-q', '-b', 'feat'); commit(a, 'a1');
  assert.deepEqual((await reviewOf(a, null))!.commits.map((c) => c.subject), ['a1']);
  // origin/HEAD names a ref with no shared history: skipped, main still used
  const b = gitRepo(); git(b, 'checkout', '-q', '--orphan', 'other'); commit(b, 'orphan');
  git(b, 'update-ref', 'refs/remotes/origin/other', 'HEAD'); git(b, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/other');
  git(b, 'checkout', '-q', 'main'); git(b, 'checkout', '-q', '-b', 'feat'); commit(b, 'b1');
  assert.deepEqual((await reviewOf(b, null))!.commits.map((c) => c.subject), ['b1']);
  // no default branch at all: nothing to compare with, so nothing is claimed
  const c = gitRepo(); git(c, 'branch', '-m', 'trunk'); commit(c, 'c1');
  const rc = (await reviewOf(c, null))!;
  assert.deepEqual([rc.commits.length, rc.files.length], [0, 0]);
  // detached HEAD two commits past main
  const d = gitRepo(); commit(d, 'd1'); commit(d, 'd2'); git(d, 'checkout', '-q', '--detach', 'HEAD'); git(d, 'branch', '-f', 'main', 'HEAD~2');
  const rd = (await reviewOf(d, null))!;
  assert.deepEqual([rd.branch, rd.commits.map((x) => x.subject)], [null, ['d2', 'd1']]);
});
