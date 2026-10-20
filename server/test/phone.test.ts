import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { parseConfig } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { phoneAddresses, Pairing } from '../src/phone.ts';

import { tmp } from './fixtures.ts';
const TOKEN = 'p'.repeat(64);

test('phoneAddresses: Tailscale and private IPv4 only', () => {
  const i = (address: string, internal = false, family = 'IPv4') => ({ address, internal, family, netmask: '', mac: '', cidr: null }) as any;
  const got = phoneAddresses({ lo: [i('127.0.0.1', true)], eno1: [i('192.168.60.61'), i('fe80::1', false, 'IPv6')], tailscale0: [i('100.101.1.2')], wan: [i('8.8.8.8')], vpn: [i('10.0.0.5')] });
  assert.deepEqual(got, [
    { address: '192.168.60.61', kind: 'lan', iface: 'eno1' },
    { address: '100.101.1.2', kind: 'tailscale', iface: 'tailscale0' },
    { address: '10.0.0.5', kind: 'lan', iface: 'vpn' },
  ]);
});

test('Pairing: a code works once and expires', () => {
  let t = 0;
  const p = new Pairing(1000, () => t);
  const a = p.issue();
  assert.equal(p.redeem(a.code), true);
  assert.equal(p.redeem(a.code), false, 'single use');
  const b = p.issue();
  t = 1000;
  assert.equal(p.redeem(b.code), false, 'expired');
  assert.equal(p.redeem('nope'), false);
});

/** GET with an explicit Host, returning status and set-cookie. Sent from 127.0.0.3 so it counts as another device. */
const getRaw = (host: string, port: number, path: string) => new Promise<{ status: number; cookie: string | undefined }>((ok, fail) => {
  const r = request({ host, port, path, localAddress: '127.0.0.3', headers: { host: `${host}:${port}` } }, (res) => { res.resume(); ok({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0] }); });
  r.on('error', fail);
  r.end();
});

test('server: allow a phone address, pair once over it, stop allowing; config remembers', async () => {
  const home = tmp();
  const cfg = { ...parseConfig({}), port: 0 };
  // 127.0.0.2 stands in for a LAN address: Linux answers on all of 127/8.
  const app = startServer(cfg, TOKEN, { home, procRoot: join(home, 'none'), cloudflared: null, detectFirewall: async () => 'firewalld', phoneAddresses: () => [{ address: '127.0.0.2', kind: 'lan', iface: 'eno1' }] });
  await app.listen();
  const port = (app.server.address() as { port: number }).port;
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
  const call = async (path: string, body?: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? { headers: H } : { method: 'POST', headers: H, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    assert.deepEqual((await call('/api/phone')).body, { port, addresses: [{ address: '127.0.0.2', kind: 'lan', iface: 'eno1', allowed: false }], firewall: 'firewalld', lanReached: false, passwordSet: false, cloudflared: false, canInstall: true, tunnel: null });
    assert.equal((await call('/api/phone/pair', { address: '127.0.0.2' })).status, 400, 'no code before phones are allowed');
    assert.equal((await call('/api/phone/allow', { address: '8.8.8.8', allow: true })).status, 400, 'only our own addresses');

    assert.equal((await call('/api/phone/allow', { address: '127.0.0.2', allow: true })).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).listen, ['127.0.0.1', '127.0.0.2']);
    const { body } = await call('/api/phone/pair', { address: '127.0.0.2' });
    const path = new URL(body.url).pathname;
    assert.match(body.url, new RegExp(`^http://127\\.0\\.0\\.2:${port}/pair/[\\w-]{24}$`));
    const first = await getRaw('127.0.0.2', port, path);
    assert.equal(first.status, 302);
    assert.match(first.cookie!, new RegExp(`^aw_token=${TOKEN};.*HttpOnly`));
    assert.equal((await getRaw('127.0.0.2', port, path)).status, 401, 'the code is single use');
    assert.equal((await call('/api/phone')).body.lanReached, true, 'a phone got through over the network');

    assert.equal((await call('/api/phone/allow', { address: '127.0.0.2', allow: false })).status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).listen, ['127.0.0.1']);
    await assert.rejects(getRaw('127.0.0.2', port, '/'), 'no longer listening there');
  } finally { await app.close(); }
});

test('history: the conversation from the transcript; 404 unknown, 409 without a transcript', async () => {
  const home = tmp();
  const { ev } = await import('./fixtures.ts');
  const tp = join(home, 'proj', 'sess.jsonl');
  (await import('node:fs')).mkdirSync(join(home, 'proj'));
  writeFileSync(tp, [
    { type: 'user', message: { role: 'user', content: 'Fix the login bug' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\nmore' } }, { type: 'text', text: 'Fixed. Tests pass.' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const app = startServer({ ...parseConfig({ claudeProjectsDir: home }), port: 0 }, TOKEN, {
    home, procRoot: join(home, 'none'), cloudflared: null, detectFirewall: async () => null,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' },
  });
  await app.store.handle({ ...ev.start, session_id: 'with', transcript_path: tp }, '%7');
  await app.store.handle({ ...ev.start, session_id: 'without', transcript_path: undefined }, null);
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const get = async (id: string) => { const r = await fetch(`${base}/api/sessions/${id}/history`, { headers: { 'x-aw-token': TOKEN } }); return { status: r.status, body: await r.json() as any }; };
  try {
    assert.deepEqual(await get('with'), { status: 200, body: { turns: [
      { who: 'you', text: 'Fix the login bug' }, { who: 'step', text: 'Bash: npm test' }, { who: 'claude', text: 'Fixed. Tests pass.' },
    ] } });
    assert.equal((await get('without')).status, 409);
    assert.equal((await get('nope')).status, 404);
  } finally { await app.close(); }
});
