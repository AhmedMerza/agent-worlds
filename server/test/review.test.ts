import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Insights, normaliseNeeds } from '../src/insights.ts';
import { reviewOf } from '../src/review.ts';
import { createSession, repoInfo } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev } from './fixtures.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));
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
