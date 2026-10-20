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

test('worktree forks from the default branch, not from a dirty/other checked-out branch', async () => {
  const repo = gitRepo();
  const mainSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(repo, 'other.txt'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'other work');
  writeFileSync(join(repo, 'a.txt'), 'dirty\n'); // dirty main checkout
  const bin = join(tmp(), 'stub'); writeFileSync(bin, '#!/usr/bin/env bash\nsleep 30\n'); chmodSync(bin, 0o755);
  const r = await createSession({ repo, worktree: true, branch: 'aw/t', claudeBin: bin, prefix: 'awtest-', home: tmp() });
  try {
    assert.equal(git(r.dir, 'rev-parse', 'HEAD'), mainSha);
    assert.ok(!existsSync(join(r.dir, 'other.txt')));
    const info = await repoInfo(r.dir);
    assert.equal(info.head, mainSha, 'repoInfo reports HEAD for baseSha');
    writeFileSync(join(r.dir, 'w.txt'), 'w\n');
    const rev = (await reviewOf(r.dir, null, info.head!))!;
    assert.deepEqual(rev.files.map((f) => f.path), ['w.txt']);
  } finally { try { execFileSync('tmux', ['kill-session', '-t', '=' + r.tmuxSession]); } catch { /* gone */ } }
});

test('Stop ending in a question is an asking card and waiting', async () => {
  const { store, s } = setup();
  await store.handle(ev.prompt, null);
  await store.handle({ ...ev.stop, last_assistant_message: 'Done thinking.\n\nTabs or spaces?  \n' }, null);
  assert.equal(s().state, 'waiting');
  assert.ok(s().waitingSince);
  assert.deepEqual(s().card, { kind: 'asking', summary: 'Tabs or spaces?' });
  await store.handle({ ...ev.stop, last_assistant_message: 'All done.' }, null);
  assert.equal(s().state, 'done');
  assert.equal(s().card.kind, 'done');
});

test('needs values meaning nothing are normalised; catch-up goes stale when the state moves on', async () => {
  for (const n of ['none', 'None.', ' nothing ', 'N/A', 'no', '-', '"none"', 'NA']) assert.equal(normaliseNeeds(n), '', n);
  assert.equal(normaliseNeeds('Pick a colour'), 'Pick a colour');
  assert.equal(normaliseNeeds('Nothing blocks, but review the diff'), 'Nothing blocks, but review the diff');

  const { store, s } = setup();
  const ins = new Insights(store, 'unused', { summarise: async () => ({ did: 'Did it', needs: 'none' }) });
  const dir = tmp(); const tp = join(dir, 't.jsonl');
  writeFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'first ask' } }) + '\n' + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
  await store.handle({ ...ev.prompt, transcript_path: tp }, null);
  await store.handle({ ...ev.stop, transcript_path: tp }, null);
  await ins.catchup(s());
  assert.equal(s().catchup.needs, '');
  assert.equal(s().catchup.asked, 'Run touch hello.txt', 'asked comes from session.task (hook fallback here)');
  assert.equal(s().catchupStale, false);
  store.push(s());
  assert.equal(s().catchupStale, false, 'unchanged state is not stale');
  await store.handle(ev.prompt, null);
  assert.equal(s().catchupStale, true);
});

test('task stays the first prompt (transcript wins), lastPrompt follows the latest', async () => {
  const { store, s } = setup();
  const ins = new Insights(store, 'unused', { summarise: async () => ({ did: '', needs: '' }) });
  store.deps.onEvent = (x, e) => ins.onEvent(x, e);
  const dir = tmp(); const tp = join(dir, 't.jsonl');
  writeFileSync(tp, JSON.stringify({ type: 'user', message: { role: 'user', content: 'the very first ask' } }) + '\n');
  await store.handle({ ...ev.prompt, prompt: 'second ask, after resume', transcript_path: tp }, null);
  await waitFor(() => s().task === 'the very first ask');
  await store.handle({ ...ev.prompt, prompt: 'third\nmultiline', transcript_path: tp }, null);
  assert.equal(s().task, 'the very first ask');
  assert.equal(s().lastPrompt, 'third');
});

test('branch refreshes on Stop and after Bash, debounced', async () => {
  let branch = 'main'; let calls = 0;
  const { store, s } = setup({ branchOf: async () => { calls++; return branch; }, branchDebounceMs: 80 });
  await store.handle(ev.start, null);
  branch = 'feat';
  await store.handle(ev.postBash, null);
  await waitFor(() => s().branch === 'feat');
  const n = calls;
  branch = 'feat2';
  await store.handle(ev.postBash, null); await store.handle(ev.postBash, null); await store.handle(ev.stop, null);
  assert.equal(calls, n, 'within the window nothing runs yet');
  await waitFor(() => s().branch === 'feat2');
  assert.equal(calls, n + 1, 'one trailing refresh for three events');
});

test('tmux windows we create (new and resume path) use window-size latest and aggressive-resize', async () => {
  const bin = join(tmp(), 'stub'); writeFileSync(bin, '#!/usr/bin/env bash\nsleep 30\n'); chmodSync(bin, 0o755);
  const names: string[] = [];
  try {
    for (const resume of [undefined, 'bbbbbbbb-2222-4222-8222-222222222222']) {
      const r = await createSession({ repo: tmp(), worktree: false, claudeBin: bin, prefix: 'awtest-', home: tmp(), resume });
      names.push(r.tmuxSession);
      const opt = (o: string) => execFileSync('tmux', ['show-options', '-w', '-t', `=${r.tmuxSession}:`, o]).toString().trim();
      assert.equal(opt('window-size'), 'window-size latest');
      assert.equal(opt('aggressive-resize'), 'aggressive-resize on');
    }
  } finally { for (const n of names) try { execFileSync('tmux', ['kill-session', '-t', '=' + n]); } catch { /* gone */ } }
});

test('permissionMode: argv, validation on both endpoints, /api/claude-defaults', async () => {
  const out = join(tmp(), 'argv');
  const bin = join(tmp(), 'stub'); writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${out}\nsleep 30\n`); chmodSync(bin, 0o755);
  const r = await createSession({ repo: tmp(), worktree: false, claudeBin: bin, prefix: 'awtest-', home: '/h', permissionMode: 'plan' });
  try {
    await waitFor(() => existsSync(out));
    assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), ['--permission-mode', 'plan', '--settings', '/h/hooks.json', '--mcp-config', '/h/claude-mcp.json']);
  } finally { try { execFileSync('tmux', ['kill-session', '-t', '=' + r.tmuxSession]); } catch { /* gone */ } }

  const root = tmp();
  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
  const calls: any[] = [];
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [root] }], userSettingsPath: settings }), port: 0 };
  const app = startServer(cfg, 't'.repeat(64), { home: root, createSession: async (o) => { calls.push(o); return { tmuxSession: 'aw-x', dir: o.repo, branch: null }; } });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const h = { 'x-aw-token': 't'.repeat(64), 'content-type': 'application/json' };
  const post = (p: string, b: unknown) => fetch(base + p, { method: 'POST', headers: h, body: JSON.stringify(b) });
  try {
    assert.equal((await post('/api/sessions', { worldId: 'web', repo: root, permissionMode: 'bogus' })).status, 400);
    assert.equal((await post('/api/sessions', { worldId: 'web', repo: root, permissionMode: 'acceptEdits' })).status, 201);
    assert.equal(calls[0].permissionMode, 'acceptEdits');
    assert.equal((await post('/api/sessions', { worldId: 'web', repo: root })).status, 201);
    assert.ok(!('permissionMode' in calls[1]));
    assert.equal((await post('/api/sessions/resume', { sessionId: 'bbbbbbbb-2222-4222-8222-222222222222', permissionMode: 'nope' })).status, 400);
    assert.deepEqual(await (await fetch(base + '/api/claude-defaults', { headers: h })).json(), { permissionMode: 'auto' });
    writeFileSync(settings, '{}');
    assert.deepEqual(await (await fetch(base + '/api/claude-defaults', { headers: h })).json(), { permissionMode: null });
  } finally { await app.close(); }
});

test('workDirOf: edited files and cd/-C git commits; nothing else', async () => {
  const { workDirOf } = await import('../src/store.ts');
  assert.equal(workDirOf('Edit', { file_path: '/w/other/src/a.ts' }), '/w/other/src');
  assert.equal(workDirOf('Bash', { command: 'cd /w/other-wt && git add . && git commit -m x' }), '/w/other-wt');
  assert.equal(workDirOf('Bash', { command: 'git -C "/w/other wt" commit -m x' }), null, 'quoted paths with spaces are skipped, not mangled');
  assert.equal(workDirOf('Bash', { command: 'git -C /w/o commit -m x' }), '/w/o');
  assert.equal(workDirOf('Bash', { command: 'cd /w/other && ls' }), null, 'looking is not working there');
  assert.equal(workDirOf('Read', { file_path: '/w/other/a.ts' }), null);
});
