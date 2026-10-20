import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect, createServer as createNetServer } from 'node:net';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev, tmp } from './fixtures.ts';

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

test('Host header must be one of ours (DNS-rebinding guard), for HTTP and websockets', async () => {
  const { app, port } = await boot();
  try {
    assert.equal(await getWithHost(port, `127.0.0.1:${port}`), 200);
    assert.equal(await getWithHost(port, `localhost:${port}`), 200);
    assert.equal(await getWithHost(port, `LOCALHOST:${port}`), 200, 'case-insensitive');
    assert.equal(await getWithHost(port, 'aw.example:8443'), 200, 'extraHosts entry');
    assert.equal(await getWithHost(port, `evil.example:${port}`), 421);
    assert.equal(await getWithHost(port, 'localhost:1'), 421, 'right name, wrong port');
    // HTTP/1.0 without any Host header
    const noHost = await new Promise<string>((ok) => {
      const s = connect(port, '127.0.0.1', () => s.end(`GET /api/state HTTP/1.0\r\nX-AW-Token: ${TOKEN}\r\n\r\n`));
      let d = '';
      s.on('data', (c) => (d += c)).on('end', () => ok(d));
    });
    assert.match(noHost, /^HTTP\/1\.1 421/);
    // the token cookie route is guarded too
    assert.equal(await new Promise<number>((ok) => request({ host: '127.0.0.1', port, path: `/?token=${TOKEN}`, headers: { host: 'evil.example' } }, (res) => { res.resume(); ok(res.statusCode!); }).end()), 421);

    const ws = (host: string) => new Promise<string>((ok) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-aw-token': TOKEN, host } });
      w.once('open', () => { w.close(); ok('open'); });
      w.once('unexpected-response', (_q, res) => ok(String(res.statusCode)));
    });
    assert.equal(await ws(`127.0.0.1:${port}`), 'open');
    assert.equal(await ws(`evil.example:${port}`), '421');
  } finally { await app.close(); }
});

test('extra listen addresses are accepted as Host', async () => {
  const port = await new Promise<number>((ok) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
  const cfg = { ...parseConfig({ listen: ['127.0.0.1', '127.0.0.3'] }), port };
  const app = startServer(cfg, TOKEN, { home: tmp(), procRoot: join(tmp(), 'none') });
  await app.listen();
  try {
    assert.equal(await getWithHost(port, `127.0.0.3:${port}`), 200);
    assert.equal(await getWithHost(port, `127.0.0.4:${port}`), 421);
  } finally { await app.close(); }
});

test('a busy port gives a clear startup error', async () => {
  const busy = createNetServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
  const port = (busy.address() as { port: number }).port;
  const home = tmp();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ port }));
  const bin = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../bin/agent-worlds');
  const r = await new Promise<{ code: number; err: string }>((ok) =>
    execFile(bin, ['start'], { env: { ...process.env, AGENT_WORLDS_HOME: home }, timeout: 15000 }, (e, _o, err) => ok({ code: (e?.code as number) ?? 0, err: String(err) })));
  busy.close();
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`port ${port} is busy — another Agent Worlds\\? change "port" in .*config\\.json`));
});
