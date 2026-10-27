import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { riskOf, ruleFor, ruleText, addAllowRule, Stats } from '../src/rules.ts';
import { computeConflicts, issueOf } from '../src/conflicts.ts';
import { readTail, readHead, contextOf, firstPrompt, excerpt } from '../src/transcript.ts';
import { reviewOf, testLine, TEST_RE } from '../src/review.ts';
import { Store } from '../src/store.ts';
import { Insights, runClaude } from '../src/insights.ts';
import { parseConfig } from '../src/config.ts';
import { createSession } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { ev, tmp } from './fixtures.ts';
import { createServer as createNetServer } from 'node:net';

const tick = () => new Promise((r) => setImmediate(r));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString();
function gitRepo(): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'T');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}

function setup(root: string, opts: { clients?: boolean; userSettingsPath?: string } = {}) {
  const emitted: any[] = [];
  const cfg = parseConfig({
    worlds: [{ id: 'web', name: 'Web', repos: [`${root}/repo-a`, `${root}/repo-b`] }],
    userSettingsPath: opts.userSettingsPath ?? join(root, 'user-settings.json'),
    claudeProjectsDir: realpathSync(tmpdir()),
  });
  const stats = new Stats(join(root, 'stats.json'));
  const store = new Store(cfg, {
    repoInfo: async (cwd) => {
      const m = cwd.match(/^\/work\/(repo-[ab])(\/.*)?$/);
      const repo = m ? `${root}/${m[1]}` : cwd;
      return { repo, branch: 'main', worktree: false, top: repo };
    },
    branchOf: async () => 'main',
    tmuxSessionOf: async () => null,
    clientsConnected: () => opts.clients ?? true,
    holdMs: 10_000,
    stats,
  }, (e) => emitted.push(e));
  return { store, emitted, cfg, stats };
}
const card = (store: Store, id = 'sess-1') => (store.list().find((s: any) => s.id === id) as any).card;

test('conflict rules', () => {
  const base = { repo: '/r', worktree: false, testing: false };
  const c = computeConflicts([
    { id: 'a', cwd: '/r', branch: 'main', ...base },
    { id: 'b', cwd: '/r', branch: 'main', ...base },
    { id: 'c', cwd: '/r/sub', branch: 'main', ...base },
    { id: 'd', cwd: '/r-wt/x', branch: 'feat/53-login', ...base, worktree: true, testing: true },
    { id: 'e', cwd: '/r-wt/y', branch: 'fix-53-logout', ...base, worktree: true, testing: true },
    { id: 'f', cwd: '/q', branch: 'main', repo: '/q', worktree: false, testing: true },
  ]);
  assert.deepEqual(c.get('a'), [{ withId: 'b', reason: 'same folder' }, { withId: 'c', reason: 'same branch main' }]);
  assert.deepEqual(c.get('d'), [{ withId: 'e', reason: 'shared database: tests in both; same issue #53' }]);
  assert.deepEqual(c.get('f'), []);
  assert.equal(issueOf('feat/53-login'), '53');
  assert.equal(issueOf('fix-#120'), '120');
  assert.equal(issueOf('issue-7-x'), '7');
  assert.equal(issueOf('main'), null);
  assert.equal(issueOf('v2'), null);
  assert.equal(issueOf(null), null);
});

test('store recomputes conflicts and broadcasts both sides; removal clears them', async () => {
  const { store, emitted } = setup(tmp(), { clients: false });
  await store.handle(ev.start, null);
  await store.handle({ ...ev.start, session_id: 'sess-2' }, null);
  const view = (id: string) => store.list().find((s: any) => s.id === id) as any;
  assert.deepEqual(view('sess-1').conflicts, [{ withId: 'sess-2', reason: 'same folder' }]);
  assert.ok(emitted.some((e) => e.type === 'session' && e.session.id === 'sess-1' && e.session.conflicts.length === 1), 'the other side is broadcast too');

  // tests running in both at once
  await store.handle({ ...ev.preBash, tool_input: { command: 'npm test' }, tool_use_id: 't1' }, null);
  await store.handle({ ...ev.preBash, session_id: 'sess-2', tool_input: { command: 'php artisan test' }, tool_use_id: 't2' }, null);
  assert.equal(view('sess-1').conflicts[0].reason, 'same folder; shared database: tests in both');
  await store.handle({ ...ev.postBash, tool_input: { command: 'npm test' }, tool_use_id: 't1', tool_response: { stdout: 'Tests: 12 passed\nDone in 3s', stderr: '' } }, null);
  assert.equal(view('sess-1').conflicts[0].reason, 'same folder');
  await store.handle({ ...ev.preBash, tool_input: { command: 'ls' }, tool_use_id: 't3' }, null);
  assert.equal(view('sess-1').conflicts[0].reason, 'same folder', 'a push that moves nothing keeps them');

  await store.handle({ ...ev.end, session_id: 'sess-2' }, null);
  assert.deepEqual(view('sess-1').conflicts, []);
});
