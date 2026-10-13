import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev } from './fixtures.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));
const TOKEN = 'h'.repeat(64);

async function boot(extra: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) {
  const repo = tmp();
  const cfg = { ...parseConfig({ extraHosts: ['aw.example:8443'], worlds: [{ id: 'web', name: 'Web', repos: [repo] }], ...extra }), port: 0 };
  const app = startServer(cfg, TOKEN, {
    home: tmp(), procRoot: join(tmp(), 'none'),
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' },
    ...opts,
  });
  await app.listen();
  const port = (app.server.address() as { port: number }).port;
  return { app, port, repo, base: `http://127.0.0.1:${port}` };
}

/** GET /api/state with an explicit Host header. */
const getWithHost = (port: number, host: string) => new Promise<number>((ok, fail) => {
  const r = request({ host: '127.0.0.1', port, path: '/api/state', headers: { host, 'x-aw-token': TOKEN } }, (res) => { res.resume(); ok(res.statusCode!); });
  r.on('error', fail);
  r.end();
});

test('a GUI-started session shows at once as starting, then becomes the real session', async () => {
  const msgs: any[] = [];
  const { app, base, repo } = await boot({}, {
    createSession: async (o: any) => ({ tmuxSession: 'aw-repo-1', dir: o.repo, branch: null, pane: '%55' }),
  });
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { 'x-aw-token': TOKEN } });
  ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.once('open', r));
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
  try {
    const r = await fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ worldId: 'web', repo, task: 'fix the bug' }) });
    assert.equal(r.status, 201);
    let st = await (await fetch(`${base}/api/state`, { headers: H })).json() as any;
    assert.equal(st.sessions.length, 1);
    const s = st.sessions[0];
    assert.equal(s.id, 'starting:aw-repo-1');
    assert.equal(s.state, 'starting');
    assert.equal(s.task, 'fix the bug');
    assert.equal(s.worldId, 'web');
    assert.equal(s.repo, repo);
    assert.deepEqual(s.tmux, { session: 'aw-repo-1', pane: '%55' });
    assert.match(s.now, /trust this folder/);

    // first hook event from that pane (after the user trusted the folder)
    await fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': '%55' }, body: JSON.stringify({ ...ev.start, cwd: repo }) });
    st = await (await fetch(`${base}/api/state`, { headers: H })).json() as any;
    assert.deepEqual(st.sessions.map((x: any) => [x.id, x.state, x.task, x.tmux?.session]), [['sess-1', 'idle', 'fix the bug', 'aw-repo-1']]);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(msgs.some((m) => m.type === 'session-removed' && m.id === 'starting:aw-repo-1'));

    // a starting session whose tmux died is swept
    await app.store.addStarting({ tmuxSession: 'aw-repo-2', pane: '%56', dir: repo, task: null });
    assert.equal(app.store.list().length, 2);
    app.store.sweep(['aw-repo-1']);
    assert.deepEqual(app.store.list().map((x: any) => x.id), ['sess-1']);
  } finally { ws.close(); await app.close(); }
});

test('permission card target says what kind of thing is asked about', async () => {
  const { app } = await boot({}, { deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: null, worktree: false, top: cwd }), branchOf: async () => null, tmuxSessionOf: async () => null, clientsConnected: () => false } });
  try {
    const card = async (tool: string, tool_input: Record<string, unknown>) => {
      await app.store.handle({ ...ev.permBash, session_id: tool, tool_name: tool, tool_input }, null);
      return (app.store.list().find((s: any) => s.id === tool) as any).card;
    };
    assert.deepEqual((await card('Bash', { command: 'npm test' })).target, { type: 'command', value: 'npm test' });
    const w = await card('Write', { file_path: '/w/a.ts', content: 'x' });
    assert.deepEqual(w.target, { type: 'file', value: '/w/a.ts' });
    assert.equal(w.command, '/w/a.ts', 'command kept for compatibility');
    assert.deepEqual((await card('WebFetch', { url: 'https://example.com', prompt: 'x' })).target, { type: 'url', value: 'https://example.com' });
    assert.deepEqual((await card('Glob', { pattern: '**/*.ts' })).target, { type: 'other', value: '**/*.ts' });
    assert.deepEqual((await card('mcp__x__y', {})).target, { type: 'other', value: 'mcp__x__y' });
  } finally { await app.close(); }
});
