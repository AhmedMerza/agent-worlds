import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Recovery } from '../src/recovery.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { tmp } from './fixtures.ts';

const TOKEN = 'r'.repeat(64);

test('recoverable sessions survive a restart, follow a changed id, and only disappear when ended', () => {
  const file = join(tmp(), 'recovery.json');
  const one = new Recovery(file);
  one.upsert({ id: 'session-old', agent: 'codex', cwd: '/work/repo', task: 'finish it', lastPrompt: 'keep going', updatedAt: 20 });

  const two = new Recovery(file);
  assert.deepEqual(two.list(), [{ id: 'session-old', agent: 'codex', cwd: '/work/repo', task: 'finish it', lastPrompt: 'keep going', updatedAt: 20 }]);
  two.rename('session-old', 'session-new');
  assert.equal(new Recovery(file).get('session-new')?.cwd, '/work/repo');

  two.delete('session-new');
  assert.deepEqual(new Recovery(file).list(), []);
});

test('starting placeholders are never offered as recoverable conversations', () => {
  const file = join(tmp(), 'recovery.json');
  const recovery = new Recovery(file);
  recovery.upsert({ id: 'starting:aw-x', agent: 'claude', cwd: '/work/repo', task: null, lastPrompt: null, updatedAt: 1 });
  assert.deepEqual(recovery.list(), []);
});

test('after a server or computer stop, Resume all relaunches every remembered conversation', async () => {
  const home = tmp(), repo = tmp(), procRoot = join(tmp(), 'missing');
  const cfg = { ...parseConfig({}), port: 0 };
  const deps = { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-recovered' };
  const first = startServer(cfg, TOKEN, { home, procRoot, deps });
  await first.listen();
  await first.store.handle({ session_id: 'session-one', hook_event_name: 'SessionStart', cwd: repo }, '%1');
  await first.close();
  writeFileSync(join(home, 'parents.json'), JSON.stringify({ 'session-one': 'lead-1234' }));

  const launched: any[] = [];
  const second = startServer({ ...cfg, port: 0 }, TOKEN, {
    home, procRoot, deps,
    createSession: async (o: any) => { launched.push(o); return { tmuxSession: 'aw-recovered', dir: o.repo, branch: null, pane: '%2' }; },
    endPane: async () => null,
  });
  await second.listen();
  await second.scan();
  const base = `http://127.0.0.1:${(second.server.address() as { port: number }).port}`;
  const headers = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
  try {
    const before = await (await fetch(`${base}/api/state`, { headers })).json() as any;
    assert.deepEqual(before.recoverable.map((s: any) => [s.id, s.agent, s.cwd]), [['session-one', 'claude', repo]]);
    const response = await fetch(`${base}/api/sessions/resume-all`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { started: ['session-one'], failed: [] });
    assert.deepEqual(launched.map((o) => [o.agent, o.resume, o.repo]), [['claude', 'session-one', repo]]);
    const after = await (await fetch(`${base}/api/state`, { headers })).json() as any;
    assert.match(after.sessions[0].now, /^Restoring saved Claude Code conversation/);
    const ended = await fetch(`${base}/api/sessions/${encodeURIComponent(after.sessions[0].id)}/end`, { method: 'POST', headers, body: '{}' });
    assert.equal(ended.status, 200);
    assert.deepEqual(new Recovery(join(home, 'recovery.json')).list(), [], 'ending before the first hook forgets the original conversation id');
    assert.equal(JSON.parse(readFileSync(join(home, 'parents.json'), 'utf8'))['session-one'], undefined, 'ending for good clears the original conversation team');
  } finally { await second.close(); }
});

test('a conversation can only start restoring once, only while its CLI is installed, and restart reminders can be dismissed', async () => {
  const home = tmp(), repo = tmp(), procRoot = join(tmp(), 'missing');
  const file = join(home, 'recovery.json');
  new Recovery(file).upsert({ id: 'session-qwen', agent: 'qwen', cwd: repo, task: 'finish it', lastPrompt: 'keep going', updatedAt: 20 });
  new Recovery(file).upsert({ id: 'session-dismiss', agent: 'qwen', cwd: repo, task: null, lastPrompt: null, updatedAt: 10 });
  new Recovery(file).upsert({ id: 'session-missing', agent: 'gemini', cwd: repo, task: null, lastPrompt: null, updatedAt: 5 });
  let entered!: () => void, release!: () => void, launches = 0;
  let installed = true;
  const started = new Promise<void>((ok) => { entered = ok; });
  const gate = new Promise<void>((ok) => { release = ok; });
  const app = startServer({ ...parseConfig({}), port: 0 }, TOKEN, {
    home, procRoot,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-qwen' },
    createSession: async (o: any) => { if (++launches === 1) { entered(); await gate; } return { tmuxSession: 'aw-qwen', dir: o.repo, branch: null, pane: '%3' }; },
    installed: () => installed,
  });
  await app.listen();
  await app.scan();
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
  const body = JSON.stringify({ sessionId: 'session-qwen', agent: 'qwen' });
  try {
    const first = fetch(`${base}/api/sessions/resume`, { method: 'POST', headers, body });
    await started;
    const duplicate = await fetch(`${base}/api/sessions/resume`, { method: 'POST', headers, body });
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json() as any).error, /already being restored/);
    const restoringDismiss = await fetch(`${base}/api/recovery/session-qwen`, { method: 'DELETE', headers });
    assert.equal(restoringDismiss.status, 409, 'an in-flight claim and its fallback record stay intact');
    release();
    assert.equal((await first).status, 201);
    app.store.remove(app.store.sessions.get('starting:aw-qwen')!);
    const retry = await fetch(`${base}/api/sessions/resume`, { method: 'POST', headers, body });
    assert.equal(retry.status, 201, 'a CLI that exits before its first hook can be restored again');

    const dismissed = await fetch(`${base}/api/recovery/session-dismiss`, { method: 'DELETE', headers });
    assert.equal(dismissed.status, 200);
    assert.equal(new Recovery(file).get('session-dismiss'), undefined);

    installed = false;
    const missing = await fetch(`${base}/api/sessions/resume`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'session-missing', agent: 'gemini' }) });
    assert.equal(missing.status, 422);
    assert.match((await missing.json() as any).error, /Gemini CLI is not installed/);
    assert.equal(launches, 2, 'a missing CLI never reaches the launcher');
  } finally { release(); await app.close(); }
});

test('closing a pane forgets its conversation, but losing the whole tmux server keeps it to resume', async () => {
  const home = tmp(), repo = tmp(), procRoot = join(tmp(), 'missing');
  const cfg = { ...parseConfig({}), port: 0 };
  const deps = { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' };
  let panes = new Map([['%1', new Set(['aw-x'])], ['%2', new Set(['aw-x'])], ['%9', new Set(['other'])]]);
  const app = startServer(cfg, TOKEN, { home, procRoot, deps, tmuxPanes: async () => panes });
  await app.listen();
  try {
    await app.store.handle({ session_id: 'closed-one', hook_event_name: 'SessionStart', cwd: repo }, '%1');
    await app.store.handle({ session_id: 'crashed-one', hook_event_name: 'SessionStart', cwd: repo }, '%2');
    await app.scan();
    panes = new Map([['%2', new Set(['aw-x'])], ['%9', new Set(['other'])]]);
    await app.sweep();
    assert.deepEqual(new Recovery(join(home, 'recovery.json')).list().map((s) => s.id), ['crashed-one'], 'a closed pane is not an interruption');
    panes = new Map();
    await app.sweep();
    assert.deepEqual(new Recovery(join(home, 'recovery.json')).list().map((s) => s.id), ['crashed-one'], 'no tmux server at all: still offered');
  } finally { await app.close(); }
});
