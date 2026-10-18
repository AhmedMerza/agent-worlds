import { test } from 'node:test';
import { TOOL_NAMES } from '../src/mcp.ts';
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

test('writeHooksFile writes the same block as `hooks --print` plus the mailbox, private', () => {
  const home = tmp();
  const f = writeHooksFile(home);
  assert.equal(f, join(home, 'hooks.json'));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { ...hooksBlock(), permissions: { allow: TOOL_NAMES.map((t) => `mcp__aw__${t}`) } });
  assert.equal(statSync(f).mode & 0o777, 0o600);
  const mcp = JSON.parse(readFileSync(join(home, 'claude-mcp.json'), 'utf8')).mcpServers.aw;
  assert.match(mcp.command, /\/bin\/aw-mcp$/);
  assert.deepEqual(mcp.args, ['claude']);
  assert.equal(statSync(join(home, 'claude-mcp.json')).mode & 0o777, 0o600);
  writeHooksFile(home); // refresh in place
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { ...hooksBlock(), permissions: { allow: TOOL_NAMES.map((t) => `mcp__aw__${t}`) } });
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
    assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [`HOME=${home}`, '--settings', join(home, 'hooks.json'), '--mcp-config', join(home, 'claude-mcp.json'), '--', 'fix it']);

    execFileSync('rm', [out]);
    const b = await createSession({ repo, worktree: false, claudeBin: bin, prefix: 'awtest-', home });
    names.push(b.tmuxSession);
    await waitFor(() => existsSync(out));
    assert.deepEqual(readFileSync(out, 'utf8').trim().split('\n'), [`HOME=${home}`, '--settings', join(home, 'hooks.json'), '--mcp-config', join(home, 'claude-mcp.json')], 'blank session: no task argument');
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

test('kimi with a task starts a `kimi -p` run that `kimi -c` then continues; without a task it is plain kimi', async () => {
  const path = process.env.PATH;
  process.env.PATH = tmp(); // no tmux, so the pane is spawned directly and we see the argv
  try {
    const calls: unknown[][] = [];
    const spawnDirect = async (...a: unknown[]) => { calls.push(a); };
    await createSession({ repo: tmp(), task: `fix it's bug`, worktree: false, agent: 'kimi', home: tmp(), prefix: 'awtest-', spawnDirect });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 'bash');
    assert.deepEqual(calls[0][2], ['-c', `'kimi' -p 'fix it'\\''s bug' && exec 'kimi' -c`]);
    assert.equal((calls[0][4] as any).AGENT_WORLDS_HOME !== undefined, true, 'hooks env still applies');

    // a handoff task (spaced path in double quotes, as /continue builds it) survives the chain quoting
    calls.length = 0;
    const handoffTask = 'Read "/tmp/home dir/handoffs/k1.md" and carry on from there.';
    await createSession({ repo: tmp(), task: handoffTask, worktree: false, agent: 'kimi', home: tmp(), prefix: 'awtest-', spawnDirect });
    assert.deepEqual(calls[0][2], ['-c', `'kimi' -p 'Read "/tmp/home dir/handoffs/k1.md" and carry on from there.' && exec 'kimi' -c`]);

    calls.length = 0;
    await createSession({ repo: tmp(), worktree: false, agent: 'kimi', home: tmp(), prefix: 'awtest-', spawnDirect });
    assert.equal(calls[0][1], 'kimi', 'no task: plain interactive kimi');
    assert.deepEqual(calls[0][2], []);
  } finally { process.env.PATH = path; }
});

test('createSession refuses a worktree in a plain (non-git) folder', async () => {
  await assert.rejects(createSession({ repo: tmp(), worktree: true }), /not a git repo, so it cannot use a worktree/);
});

test('without tmux: the server runs claude itself; the CLI (no server to own it) says to install tmux', async () => {
  const path = process.env.PATH;
  process.env.PATH = tmp(); // an empty folder: no tmux, no git
  try {
    await assert.rejects(createSession({ repo: tmp(), worktree: false }), /needs tmux, which is not installed/);
    const calls: unknown[][] = [];
    const repo = tmp();
    const r = await createSession({ repo, task: 'hi', worktree: false, home: '/h', prefix: 'awtest-', spawnDirect: async (...a) => { calls.push(a); } });
    assert.equal(r.direct, true);
    assert.equal(r.pane, null);
    assert.deepEqual(calls, [[r.tmuxSession, 'claude', ['--settings', '/h/hooks.json', '--mcp-config', '/h/claude-mcp.json', '--', 'hi'], repo, { AGENT_WORLDS_HOME: '/h', AGENT_WORLDS_PTY: r.tmuxSession }]]);
  } finally { process.env.PATH = path; }
});

test('a direct (no tmux) session: starts, links its hooks, shows in the web terminal, takes replies, ends with its process', async () => {
  const path = process.env.PATH;
  const repo = tmp();
  const bin = join(tmp(), 'claude-stub');
  writeFileSync(bin, '#!/bin/bash\necho "READY $AGENT_WORLDS_PTY"\nwhile read -r l; do echo "GOT:$l"; [ "$l" = bye ] && exit 0; done\n');
  chmodSync(bin, 0o755);
  const token = 'q'.repeat(64);
  const cfg = { ...parseConfig({ claudeBin: bin, worlds: [{ id: 'w', name: 'W', repos: [repo] }] }), port: 0 };
  const app = startServer(cfg, token, { home: tmp(), onRestart: () => {}, prepareRestart: async () => null });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const H = { 'x-aw-token': token, 'content-type': 'application/json' };
  process.env.PATH = tmp(); // no tmux
  try {
    const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ worldId: 'w', repo }) });
    assert.equal(r.status, 201);
    const name = (await r.json() as any).tmuxSession;
    assert.equal(app.store.sessions.get(`starting:${name}`)?.direct, name);

    // aw-hook sends the pty name; the first event replaces the 'starting' card
    await fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pty': name }, body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'd-1', cwd: repo }) });
    const s = app.store.sessions.get('d-1')!;
    assert.equal(s.direct, name);
    assert.equal(app.store.sessions.has(`starting:${name}`), false);

    const pty = new WebSocket(`${base.replace('http', 'ws')}/pty?session=d-1`, { headers: { 'x-aw-token': token } });
    let out = '';
    pty.on('message', (d) => { out += d.toString(); });
    await waitFor(() => out.includes(`READY ${name}`));
    assert.ok(out.includes(`READY ${name}`), 'replays what was printed before the browser attached');
    pty.send(JSON.stringify({ t: 'in', d: 'hello\r' }));
    await waitFor(() => out.includes('GOT:hello'));
    assert.ok(out.includes('GOT:hello'));

    const restart = await fetch(`${base}/api/restart`, { method: 'POST', headers: H, body: '{}' });
    assert.equal(restart.status, 409);
    assert.match((await restart.json() as any).error, /without tmux and will end/);

    assert.equal((await fetch(`${base}/api/sessions/d-1/input`, { method: 'POST', headers: H, body: JSON.stringify({ text: 'bye' }) })).status, 200);
    await waitFor(() => !app.store.sessions.has('d-1'));
    assert.equal(app.store.sessions.has('d-1'), false, 'the card goes when claude exits');
    pty.close();
  } finally { process.env.PATH = path; await app.close(); }
});
