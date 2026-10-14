import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from 'node:fs';
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
import { ev, stubClaude } from './fixtures.ts';
import { createServer as createNetServer } from 'node:net';

const tmp = (p = 'awtest-') => realpathSync(mkdtempSync(join(tmpdir(), p)));
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

test('createSession: worktree on a new branch, tmux session in it', async () => {
  const repo = gitRepo();
  const bin = stubClaude(tmp(), 'sleep 30');
  const r = await createSession({ repo, task: 'Fix the login bug!', worktree: true, claudeBin: bin, prefix: 'awtest-' });
  try {
    assert.match(r.branch!, /^aw\/fix-the-login-bug-[0-9a-f]{4}$/);
    assert.equal(r.dir, join(`${repo}-worktrees`, r.branch!.replace(/\//g, '-')));
    assert.equal(git(r.dir, 'branch', '--show-current').trim(), r.branch);
    assert.match(r.tmuxSession, /^awtest-awtest-[a-z0-9]+-[0-9a-f]{4}$/);
    assert.equal(execFileSync('tmux', ['display-message', '-p', '-t', '=' + r.tmuxSession + ':', '#{pane_current_path}']).toString().trim(), r.dir);
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', '=' + r.tmuxSession]); } catch { /* already gone */ }
  }
  await assert.rejects(createSession({ repo, task: '', worktree: true, branch: 'bad..name', prefix: 'awtest-' }), /invalid branch/);
  await assert.rejects(createSession({ repo, task: '', worktree: true, branch: r.branch!, prefix: 'awtest-' }), /worktree add failed/);
});

test('POST /api/sessions validates, PWA files are public, multiple listen addresses', async () => {
  const root = tmp();
  const dist = tmp();
  writeFileSync(join(dist, 'index.html'), 'app');
  writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"x"}');
  writeFileSync(join(dist, 'icon-192.png'), 'png');
  const calls: any[] = [];
  // a free port (the fixed test slot may be busy with another run)
  const port = await new Promise<number>((ok) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
  const cfg = { ...parseConfig({ listen: ['127.0.0.1', '127.0.0.2'], worlds: [{ id: 'web', name: 'Web', repos: [`${root}/repo-a`] }] }), port };
  const app = startServer(cfg, 'k'.repeat(64), {
    webDist: dist, home: root,
    createSession: async (o) => { calls.push(o); if (o.branch === 'boom') throw new Error('git worktree add failed: nope'); return { tmuxSession: 'aw-x-1', dir: o.repo, branch: null }; },
  });
  await app.listen();
  try {
    const H = { 'x-aw-token': 'k'.repeat(64), 'content-type': 'application/json' };
    const post = (b: unknown) => fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify(b) });
    assert.equal((await post({ worldId: 'nope', repo: `${root}/repo-a` })).status, 400);
    assert.equal((await post({ worldId: 'web', repo: '/etc' })).status, 400);
    assert.equal((await post({ worldId: 'web', repo: `${root}/repo-a`, task: 5 })).status, 400);
    assert.equal((await post({ worldId: 'web', repo: `${root}/repo-a`, branch: 'x', worktree: false })).status, 400);
    const ok = await post({ worldId: 'web', repo: `${root}/repo-a`, task: 'do it', worktree: true });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { tmuxSession: 'aw-x-1' });
    assert.deepEqual({ ...calls[0], spawnDirect: undefined }, { spawnDirect: undefined, agent: 'claude', repo: `${root}/repo-a`, task: 'do it', worktree: true, branch: undefined, claudeBin: 'claude', home: root, prefix: undefined });
    const bad = await post({ worldId: 'web', repo: `${root}/repo-a`, worktree: true, branch: 'boom' });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /worktree add failed/);
    const st = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: H })).json() as any;
    assert.deepEqual(st.worlds[0].repos, [`${root}/repo-a`]);

    const m = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    assert.equal(m.status, 200);
    assert.equal(m.headers.get('content-type'), 'application/manifest+json');
    assert.equal((await fetch(`http://127.0.0.1:${port}/icon-192.png`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/icon-512.png`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 401, 'the app itself stays authed');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);

    assert.equal((await fetch(`http://127.0.0.2:${port}/api/state`, { headers: H })).status, 200, 'second listen address works');
    assert.equal((await fetch(`http://127.0.0.2:${port}/api/state`, { headers: { ...H, origin: `http://127.0.0.2:${port}` } })).status, 200, 'its origin is allowed');

    // catch-up endpoint
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/nope/catchup`, { method: 'POST', headers: H })).status, 404);
  } finally { await app.close(); }
});

test('config: listen, userSettingsPath, claudeBin', () => {
  assert.deepEqual(parseConfig({}).listen, ['127.0.0.1']);
  const c = parseConfig({ listen: ['127.0.0.1', '100.64.0.5'], userSettingsPath: '~/x/settings.json', claudeBin: '/opt/claude' });
  assert.equal(c.host, '127.0.0.1');
  assert.match(c.userSettingsPath, /^\/.*\/x\/settings\.json$/);
  assert.equal(c.claudeBin, '/opt/claude');
  assert.throws(() => parseConfig({ listen: [] }), /listen/);
  assert.throws(() => parseConfig({ claudeBin: 5 }), /claudeBin/);
  assert.equal(parseConfig({}).contextLimit, 1_000_000);
  assert.equal(parseConfig({ contextLimit: 200_000 }).contextLimit, 200_000);
  assert.throws(() => parseConfig({ contextLimit: 'big' }), /contextLimit/);
});
