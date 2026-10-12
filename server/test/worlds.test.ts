import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { PALETTE } from '../src/worlds.ts';
import { ev } from './fixtures.ts';

const TOKEN = 'w'.repeat(64);
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));
const home = tmp();
const code = tmp(); // a folder of repos
function repo(name: string) {
  const d = join(code, name);
  mkdirSync(d);
  execFileSync('git', ['-C', d, 'init', '-q', '-b', 'main']);
  return d;
}
const repoA = repo('repo-a');
const repoB = repo('repo-b');
const repoC = repo('repo-c');
mkdirSync(join(repoA, 'sub'));
mkdirSync(join(code, 'plain'));
mkdirSync(join(code, '.hidden'));
writeFileSync(join(code, 'file.txt'), 'x');
execFileSync('git', ['-C', repoA, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'i']);
const wt = join(code, 'repo-a-wt');
execFileSync('git', ['-C', repoA, 'worktree', 'add', '-q', '-b', 'feat', wt]);

writeFileSync(join(home, 'config.json'), JSON.stringify({ port: 4317, extraHosts: ['localhost:5190'], custom: { keep: true }, worlds: [] }, null, 2));

let app: ReturnType<typeof startServer>;
let base = '';
let ws: WebSocket & { got: any[] };
before(async () => {
  const cfg = { ...parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))), port: 0 };
  app = startServer(cfg, TOKEN, {
    home,
    deps: {
      repoInfo: async (cwd: string) => ({ repo: cwd.startsWith(repoA) || cwd.startsWith(wt) ? repoA : cwd, branch: 'main', worktree: false, top: cwd }),
      branchOf: async () => 'main', tmuxSessionOf: async () => null,
    },
  });
  await app.listen();
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  ws = Object.assign(new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { 'x-aw-token': TOKEN } }), { got: [] as any[] });
  ws.on('message', (m) => ws.got.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.once('open', r));
});
after(async () => { ws.close(); await app.close(); });

const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as any };
};
const saved = () => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
const settle = () => new Promise((r) => setTimeout(r, 50));

test('create: slug id, palette colour, repos validated, persisted with other keys kept', async () => {
  const r = await call('POST', '/api/worlds', { name: '  Web Apps ', repos: [repoA, repoA, wt] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.world, { id: 'web-apps', name: 'Web Apps', color: PALETTE[0], repos: [repoA] }, 'worktree resolves to its main repo; duplicates dropped');
  const r2 = await call('POST', '/api/worlds', { name: 'Web apps!' });
  assert.equal(r2.body.world.id, 'web-apps-2');
  assert.equal(r2.body.world.color, PALETTE[1]);
  const r3 = await call('POST', '/api/worlds', { name: 'Mobile', color: '#123abc', repos: [repoB] });
  assert.equal(r3.body.world.color, '#123abc');

  const s = saved();
  assert.deepEqual(s.custom, { keep: true });
  assert.deepEqual(s.extraHosts, ['localhost:5190']);
  assert.equal(s.port, 4317);
  assert.deepEqual(s.worlds.map((w: any) => w.id), ['web-apps', 'web-apps-2', 'mobile']);
  assert.deepEqual(readdirSync(home).filter((f) => f.endsWith('.tmp')), [], 'atomic write leaves no temp file');
  await settle();
  assert.deepEqual(ws.got.filter((m) => m.type === 'worlds').at(-1).worlds.map((w: any) => w.id), ['web-apps', 'web-apps-2', 'mobile']);
  assert.equal((await call('GET', '/api/state')).body.worlds.length, 3);
});

test('create/update validation errors', async () => {
  const bad = async (body: unknown, re: RegExp) => {
    const r = await call('POST', '/api/worlds', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, re);
  };
  await bad({}, /name/);
  await bad({ name: '' }, /name/);
  await bad({ name: 'x'.repeat(41) }, /name/);
  await bad({ name: 'X', color: 'red' }, /color/);
  await bad({ name: 'X', repos: 'nope' }, /array/);
  await bad({ name: 'X', repos: ['relative/path'] }, /absolute/);
  await bad({ name: 'X', repos: [join(code, 'missing')] }, /no such folder/);
  await bad({ name: 'X', repos: [join(code, 'plain')] }, /not a git repo/);
  await bad({ name: 'X', repos: [join(repoA, 'sub')] }, /not the top folder/);
  await bad({ name: 'X', repos: [repoA] }, /belongs to the Web Apps world/);
  await bad({ name: 'X', repos: [wt] }, /belongs to the Web Apps world/);
  assert.equal(saved().worlds.length, 3, 'nothing saved on errors');

  assert.equal((await call('PATCH', '/api/worlds/nope', { name: 'Y' })).status, 404);
  assert.equal((await call('PATCH', '/api/worlds/mobile', { color: '#zzzzzz' })).status, 400);
  const own = await call('PATCH', '/api/worlds/mobile', { repos: [repoA] });
  assert.equal(own.status, 400);
  assert.match(own.body.error, /Web Apps/);
  assert.equal((await call('PUT', '/api/worlds/mobile', {})).status, 405);
});

test('update: rename keeps the id, repos change moves sessions between worlds', async () => {
  await app.store.handle({ ...ev.start, session_id: 'in-a', cwd: repoA }, null);
  await app.store.handle({ ...ev.start, session_id: 'in-c', cwd: repoC }, null);
  const view = (id: string) => app.store.list().find((s: any) => s.id === id) as any;
  assert.equal(view('in-a').worldId, 'web-apps');
  assert.equal(view('in-c').worldId, null);

  const r = await call('PATCH', '/api/worlds/web-apps', { name: 'Front End', color: '#00ff00' });
  assert.deepEqual(r.body.world, { id: 'web-apps', name: 'Front End', color: '#00ff00', repos: [repoA] });

  ws.got.length = 0;
  const moved = await call('PATCH', '/api/worlds/mobile', { repos: [repoB, repoC] });
  assert.equal(moved.status, 200);
  assert.equal(view('in-c').worldId, 'mobile', 'session joins the world that now has its repo');
  await settle();
  assert.ok(ws.got.some((m) => m.type === 'session' && m.session.id === 'in-c' && m.session.worldId === 'mobile'));
  assert.ok(ws.got.some((m) => m.type === 'worlds'));

  await call('PATCH', '/api/worlds/mobile', { repos: [repoB] });
  assert.equal(view('in-c').worldId, null, 'and leaves it when the repo is removed');
  assert.deepEqual(saved().worlds.find((w: any) => w.id === 'mobile').repos, [repoB]);
});

test('order: must list every id once', async () => {
  assert.equal((await call('POST', '/api/worlds/order', { ids: ['mobile'] })).status, 400);
  assert.equal((await call('POST', '/api/worlds/order', { ids: ['mobile', 'mobile', 'web-apps'] })).status, 400);
  assert.equal((await call('POST', '/api/worlds/order', { ids: 'x' })).status, 400);
  assert.equal((await call('POST', '/api/worlds/order', { ids: ['mobile', 'web-apps-2', 'web-apps'] })).status, 200);
  assert.deepEqual(saved().worlds.map((w: any) => w.id), ['mobile', 'web-apps-2', 'web-apps']);
  assert.deepEqual((await call('GET', '/api/state')).body.worlds.map((w: any) => w.id), ['mobile', 'web-apps-2', 'web-apps']);
});

test('delete: sessions become unsorted, nothing stopped', async () => {
  const view = (id: string) => app.store.list().find((s: any) => s.id === id) as any;
  assert.equal((await call('DELETE', '/api/worlds/nope')).status, 404);
  const r = await call('DELETE', '/api/worlds/web-apps');
  assert.equal(r.status, 200);
  assert.equal(view('in-a').worldId, null);
  assert.equal(view('in-a').state, 'idle', 'session still there');
  assert.ok(!saved().worlds.some((w: any) => w.id === 'web-apps'));
  assert.deepEqual(saved().custom, { keep: true });
  // repo-a is free again
  assert.equal((await call('POST', '/api/worlds', { name: 'Again', repos: [repoA] })).status, 201);
  assert.equal(view('in-a').worldId, 'again');
});

test('a broken config.json is never overwritten', async () => {
  const keep = readFileSync(join(home, 'config.json'), 'utf8');
  writeFileSync(join(home, 'config.json'), '{broken');
  const r = await call('POST', '/api/worlds', { name: 'Nope' });
  assert.equal(r.status, 500);
  assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), '{broken');
  writeFileSync(join(home, 'config.json'), keep);
});

test('fs listing: directories only, no hidden, sorted, repo flag, bounds', async () => {
  const r = await call('GET', `/api/fs?path=${encodeURIComponent(code)}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.path, code);
  assert.equal(r.body.parent, realpathSync(join(code, '..')));
  assert.deepEqual(r.body.entries.map((e: any) => [e.name, e.isRepo]), [['plain', false], ['repo-a', true], ['repo-a-wt', true], ['repo-b', true], ['repo-c', true]]);
  assert.equal(r.body.entries[1].path, repoA);
  assert.equal((await call('GET', '/api/fs?path=relative')).status, 400);
  assert.equal((await call('GET', `/api/fs?path=${encodeURIComponent(join(code, 'missing'))}`)).status, 400);
  assert.equal((await call('GET', `/api/fs?path=${encodeURIComponent(join(code, 'file.txt'))}`)).status, 400);
  assert.equal((await call('GET', '/api/fs?path=/')).body.parent, null);

  const many = tmp();
  for (let i = 0; i < 510; i++) mkdirSync(join(many, `d${String(i).padStart(3, '0')}`));
  const big = await call('GET', `/api/fs?path=${encodeURIComponent(many)}`);
  assert.equal(big.body.entries.length, 500);
  assert.equal(big.body.truncated, true);

  const def = await call('GET', '/api/fs');
  assert.equal(def.status, 200);
  assert.equal(def.body.path, code, 'defaults to where most repos live');

  assert.equal((await fetch(`${base}/api/fs`)).status, 401);
});
