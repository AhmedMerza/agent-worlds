import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev } from './fixtures.ts';

const TOKEN = 'a'.repeat(64);
const dist = mkdtempSync(join(tmpdir(), 'aw-dist-'));
mkdirSync(join(dist, 'assets'));
writeFileSync(join(dist, 'index.html'), '<h1>app</h1>');
writeFileSync(join(dist, 'assets', 'x.js'), 'console.log(1)');

const fakePty = new EventEmitter() as any;
let app: ReturnType<typeof startServer>;
let base = '';
let wsBase = '';

before(async () => {
  const cfg = { ...parseConfig({ extraHosts: ['localhost:5190'], worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    holdMs: 5000,
    webDist: dist,
    deps: {
      repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }),
      branchOf: async () => 'main',
      tmuxSessionOf: async () => 'awtest-fake',
    },
    spawnPty: async (session: string, cols: number, rows: number) => {
      fakePty.spawned = { session, cols, rows };
      fakePty.written = [];
      fakePty.killed = false;
      return {
        write: (d: string) => fakePty.written.push(d),
        resize: (c: number, r: number) => { fakePty.size = [c, r]; },
        kill: () => { fakePty.killed = true; },
        onData: (cb: (d: string) => void) => fakePty.on('data', cb),
        onExit: () => {},
      } as any;
    },
  });
  await app.listen();
  const { port } = app.server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});
after(() => app.close());

const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
const hook = (body: unknown, pane = '%7') => fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify(body) });
const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body) });
const state = async () => (await (await fetch(`${base}/api/state`, { headers: H })).json()) as any;
const openWs = (path: string, headers: Record<string, string> = { 'x-aw-token': TOKEN }) => new Promise<WebSocket & { got: string[] }>((ok, fail) => {
  const ws = Object.assign(new WebSocket(wsBase + path, { headers }), { got: [] as string[] });
  ws.on('message', (m) => ws.got.push(m.toString()));
  ws.once('open', () => ok(ws));
  ws.once('error', fail);
  ws.once('unexpected-response', (_r, res) => fail(new Error(String(res.statusCode))));
});

test('auth: every route needs the token', async () => {
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'x-aw-token': 'b'.repeat(64) } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'x-aw-token': 'short' } })).status, 401);
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/hook`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { cookie: `aw_token=${TOKEN}` } })).status, 200);
  await assert.rejects(openWs('/ws', {}), /401/);
  await assert.rejects(openWs('/pty?session=x', {}), /401/);
});

test('auth: /?token= sets an HttpOnly SameSite=Strict cookie and redirects', async () => {
  const r = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  assert.match(r.headers.get('set-cookie')!, /^aw_token=a+; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.equal((await fetch(`${base}/?token=wrong`, { redirect: 'manual' })).status, 401);
});

test('origin check: foreign origins are refused, configured extra hosts allowed', async () => {
  assert.equal((await fetch(`${base}/api/state`, { headers: { ...H, origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { ...H, origin: 'http://localhost:5190' } })).status, 200);
  await assert.rejects(openWs('/ws', { 'x-aw-token': TOKEN, origin: 'http://evil.example' }), /403/);
});

test('hook: non-decision events answer 204, bad input 400', async () => {
  const r = await hook(ev.start);
  assert.equal(r.status, 204);
  assert.equal((await fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: '{nope' })).status, 400);
  assert.equal((await hook({ hook_event_name: 'Stop' })).status, 400);
  const s = (await state()).sessions.find((x: any) => x.id === 'sess-1');
  assert.equal(s.tmux.pane, '%7');
});

test('hook: PermissionRequest with no GUI connected answers {} at once', async () => {
  const r = await hook(ev.permBash);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{}');
  const s = (await state()).sessions[0];
  assert.equal(s.card.live, false);
  await hook(ev.postBash);
});

test('hook: PermissionRequest is held until POST /permission, broadcast over /ws', async () => {
  const ws = await openWs('/ws');
  await new Promise((r) => setTimeout(r, 50));
  const msgs = () => ws.got.map((m) => JSON.parse(m));
  assert.equal(msgs()[0].type, 'snapshot');
  assert.ok(Array.isArray(msgs()[0].worlds));

  const held = hook({ ...ev.permBash, prompt_id: 'p2' }); // a later turn asking the same thing
  let card: any;
  for (let i = 0; i < 50 && !card?.live; i++) {
    await new Promise((r) => setTimeout(r, 20));
    card = (await state()).sessions[0]?.card;
  }
  assert.equal(card.kind, 'permission');
  assert.ok(msgs().some((m) => m.type === 'session' && m.session.card?.requestId === card.requestId));

  assert.equal((await post('/api/sessions/sess-1/permission', { requestId: card.requestId, decision: 'nope' })).status, 400);
  const ok = await post('/api/sessions/sess-1/permission', { requestId: card.requestId, decision: 'allow', scope: 'once' });
  assert.equal(ok.status, 200);
  const res = await held;
  assert.deepEqual(await res.json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal((await post('/api/sessions/sess-1/permission', { requestId: card.requestId, decision: 'allow' })).status, 409);
  assert.equal((await post('/api/sessions/nope/permission', { requestId: card.requestId, decision: 'allow' })).status, 404);

  // The hook process dying (Esc in the terminal) drops the card.
  const ac = new AbortController();
  const killed = fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify({ ...ev.permBash, session_id: 'sess-2' }), signal: ac.signal }).catch(() => 'aborted');
  await new Promise((r) => setTimeout(r, 100));
  ac.abort();
  assert.equal(await killed, 'aborted');
  await new Promise((r) => setTimeout(r, 100));
  const s2 = (await state()).sessions.find((x: any) => x.id === 'sess-2');
  assert.equal(s2.card, null);
  assert.equal(s2.state, 'idle');
  ws.close();
});

test('input, ack and answer validate', async () => {
  assert.equal((await post('/api/sessions/sess-1/input', { text: 5 })).status, 400);
  assert.equal((await post('/api/sessions/sess-1/input', { text: 'x'.repeat(10001) })).status, 400);
  assert.equal((await post('/api/sessions/nope/input', { text: 'hi' })).status, 404);
  assert.equal((await post('/api/sessions/sess-1/answer', { requestId: 'x', answers: [] })).status, 400);
  assert.equal((await post('/api/sessions/sess-1/ack', {})).status, 200);
  assert.equal((await state()).sessions.find((x: any) => x.id === 'sess-1').state, 'idle');
  assert.equal((await post('/api/sessions/nope/ack', {})).status, 404);
  assert.equal((await post('/api/sessions/sess-1/explode', {})).status, 404);
});

test('static: serves web/dist with SPA fallback and blocks traversal', async () => {
  const get = (p: string) => fetch(base + p, { headers: H });
  assert.equal(await (await get('/')).text(), '<h1>app</h1>');
  assert.equal(await (await get('/assets/x.js')).text(), 'console.log(1)');
  assert.equal(await (await get('/world/web')).text(), '<h1>app</h1>');
  const r = await get('/%2e%2e/%2e%2e/etc/passwd');
  assert.notEqual(await r.text(), (await import('node:fs')).readFileSync('/etc/passwd', 'utf8'));
});

test('pty: attaches to the session tmux, forwards input/resize, kills on close', async () => {
  await assert.rejects(openWs('/pty?session=nope'), /404/);
  const ws = await openWs('/pty?session=sess-1');
  ws.send(JSON.stringify({ t: 'resize', cols: 120, rows: 40 }));
  ws.send(JSON.stringify({ t: 'in', d: '/help\r' }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fakePty.spawned.session, 'awtest-fake');
  assert.deepEqual(fakePty.size, [120, 40]);
  assert.deepEqual(fakePty.written, ['/help\r']);
  fakePty.emit('data', '\x1b[1mhello');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ws.got, ['\x1b[1mhello']);
  ws.send('not json');
  ws.send(JSON.stringify({ t: 'resize', cols: -1, rows: 'x' }));
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fakePty.killed, true);
});
