import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { hooksBlock, writeHooksFile } from '../src/hooks.ts';
import { createSession } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev } from './fixtures.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));
const waitFor = async (f: () => boolean, ms = 3000) => { for (let t = 0; t < ms && !f(); t += 25) await new Promise((r) => setTimeout(r, 25)); };

test('writeHooksFile writes the same block as `hooks --print`, private', () => {
  const home = tmp();
  const f = writeHooksFile(home);
  assert.equal(f, join(home, 'hooks.json'));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), hooksBlock());
  assert.equal(statSync(f).mode & 0o777, 0o600);
  writeHooksFile(home); // refresh in place
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), hooksBlock());
});

test('createSession launches claude with --settings <home>/hooks.json and AGENT_WORLDS_HOME; task optional', async () => {
  const home = tmp();
  const repo = tmp();
  const out = join(tmp(), 'argv');
  const bin = join(tmp(), 'claude-stub');
  writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "HOME=$AGENT_WORLDS_HOME" "$@" > ${out}\nsleep 30\n`);
  chmodSync(bin, 0o755);
  const names: string[] = [];
  try {
    const a = await createSession({ repo, task: 'fix it', worktree: false, claudeBin: bin, prefix: 'awtest-', home });
    names.push(a.tmuxSession);
    await waitFor(() => existsSync(out));
    assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [`HOME=${home}`, '--settings', join(home, 'hooks.json'), '--', 'fix it']);

    execFileSync('rm', [out]);
    const b = await createSession({ repo, worktree: false, claudeBin: bin, prefix: 'awtest-', home });
    names.push(b.tmuxSession);
    await waitFor(() => existsSync(out));
    assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [`HOME=${home}`, '--settings', join(home, 'hooks.json')], 'blank session: no task argument');
  } finally {
    for (const n of names) try { execFileSync('tmux', ['kill-session', '-t', '=' + n]); } catch { /* gone */ }
  }
});

test('POST /api/sessions: task optional, home passed through', async () => {
  const root = tmp();
  const calls: any[] = [];
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [root] }] }), port: 0 };
  const app = startServer(cfg, 't'.repeat(64), { home: root, createSession: async (o) => { calls.push(o); return { tmuxSession: 'aw-x', dir: o.repo, branch: null }; } });
  await app.listen();
  try {
    const r = await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/sessions`, {
      method: 'POST', headers: { 'x-aw-token': 't'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify({ worldId: 'web', repo: root }),
    });
    assert.equal(r.status, 201);
    assert.equal(calls[0].task, '');
    assert.equal(calls[0].home, root);
  } finally { await app.close(); }
});

test('the same hook reported twice (two command strings) is handled once and both get the reply', async () => {
  const cfg = { ...parseConfig({}), port: 0 };
  const token = 'd'.repeat(64);
  const app = startServer(cfg, token, {
    home: tmp(),
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => null },
  });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const H = { 'x-aw-token': token, 'content-type': 'application/json', 'x-aw-pane': '%9' };
  const hook = (b: unknown) => fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { 'x-aw-token': token } });
  await new Promise((r) => ws.once('open', r));
  try {
    await Promise.all([hook(ev.prompt), hook(ev.prompt)]);
    const s = app.store.sessions.get('sess-1')!;
    assert.equal(s.log.filter((l) => l.text.startsWith('You:')).length, 1, 'prompt logged once');

    const a = hook(ev.permBash);
    const b = hook(ev.permBash);
    await waitFor(() => s.pending.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.pending.length, 1, 'one card, not two');
    assert.equal(app.store.decide('sess-1', { requestId: s.pending[0].requestId, decision: 'allow' }), null);
    const [ra, rb] = await Promise.all([a, b]);
    const ta = await ra.text();
    assert.equal(ta, await rb.text());
    assert.equal(JSON.parse(ta).hookSpecificOutput.decision.behavior, 'allow');

    // the same event again later (a new turn) is NOT swallowed
    await new Promise((r) => setTimeout(r, 600));
    await hook(ev.prompt);
    assert.equal(s.log.filter((l) => l.text.startsWith('You:')).length, 2);
  } finally { ws.close(); await app.close(); }
});

test('createSession refuses a worktree in a plain (non-git) folder', async () => {
  await assert.rejects(createSession({ repo: tmp(), worktree: true }), /not a git repo, so it cannot use a worktree/);
});
