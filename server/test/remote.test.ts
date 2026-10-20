import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:http';
import { parseConfig } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { Password, LoginLimiter } from '../src/remote.ts';

import { tmp } from './fixtures.ts';
const TOKEN = 'r'.repeat(64);

test('Password: hash only, right one passes, wrong and missing fail', () => {
  const p = new Password(join(tmp(), 'password.json'));
  assert.equal(p.isSet(), false);
  assert.equal(p.check('anything'), false);
  p.set('correct horse battery');
  assert.equal(p.check('correct horse battery'), true);
  assert.equal(p.check('correct horse batterY'), false);
  p.clear();
  assert.equal(p.isSet(), false);
});

test('LoginLimiter: 5 failures in 15 minutes lock for 15 minutes', () => {
  let t = 0;
  const l = new LoginLimiter(() => t);
  for (let i = 0; i < 4; i++) l.fail();
  assert.equal(l.locked(), 0);
  l.fail();
  assert.equal(l.locked(), 15 * 60_000);
  t = 15 * 60_000;
  assert.equal(l.locked(), 0);
  // old failures age out
  for (let i = 0; i < 4; i++) l.fail();
  t += 16 * 60_000;
  l.fail();
  assert.equal(l.locked(), 0);
});

/** Raw request so Host and headers are exactly what a tunnel would send. */
const raw = (port: number, method: string, path: string, headers: Record<string, string>, body = '') => new Promise<{ status: number; headers: any; body: string }>((ok, fail) => {
  const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
    let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body: d }));
  });
  r.on('error', fail); r.end(body);
});

test('public link: needs a password, logs who came in from where, lockout, off again', async () => {
  const home = tmp();
  const fake = join(home, 'cloudflared');
  writeFileSync(fake, '#!/bin/sh\necho "INF |  https://brave-otter-12.trycloudflare.com  |" >&2\nexec sleep 30\n');
  chmodSync(fake, 0o755);
  const app = startServer({ ...parseConfig({}), port: 0 }, TOKEN, { home, procRoot: join(home, 'none'), cloudflared: fake, phoneAddresses: () => [] });
  await app.listen();
  const port = (app.server.address() as { port: number }).port;
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json', host: `127.0.0.1:${port}` };
  const api = (method: string, path: string, b?: unknown) => raw(port, method, path, H, b === undefined ? '' : JSON.stringify(b));
  const TH = 'brave-otter-12.trycloudflare.com';
  try {
    assert.equal((await api('POST', '/api/tunnel', { on: true })).status, 400, 'no password, no public link');
    assert.equal((await api('POST', '/api/password', { password: 'short' })).status, 400);
    assert.equal((await api('POST', '/api/password', { password: 'a long enough secret' })).status, 200);
    assert.equal(JSON.parse((await api('POST', '/api/tunnel', { on: true })).body).url, `https://${TH}`);
    assert.equal(JSON.parse((await api('GET', '/api/phone')).body).tunnel, `https://${TH}`);

    // through the tunnel: unauthenticated pages go to the login page
    const tun = { host: TH, 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'PhoneBrowser/1', 'x-forwarded-proto': 'https' };
    const home302 = await raw(port, 'GET', '/', tun);
    assert.equal(home302.status, 302);
    assert.equal(home302.headers.location, '/login');
    const form = { ...tun, 'content-type': 'application/x-www-form-urlencoded', origin: `https://${TH}` };
    assert.equal((await raw(port, 'POST', '/login', form, 'password=nope')).status, 401);
    const good = await raw(port, 'POST', '/login', form, 'password=a+long+enough+secret');
    assert.equal(good.status, 302);
    assert.ok(good.headers['set-cookie'].some((c: string) => /^aw_token=r+;.*Secure/.test(c)));
    assert.ok(good.headers['set-cookie'].some((c: string) => /^aw_dev=[\w-]+;/.test(c)));

    const log = JSON.parse((await api('GET', '/api/access')).body);
    assert.deepEqual(log.entries.map((e: any) => [e.via, e.ok, e.ip, e.route, e.agent]), [
      ['password', true, '203.0.113.7', 'public link', 'PhoneBrowser/1'],
      ['password', false, '203.0.113.7', 'public link', 'PhoneBrowser/1'],
    ]);
    assert.equal(log.devices.length, 1);
    assert.equal(log.devices[0].ip, '203.0.113.7');

    // a forged CF-Connecting-IP without the tunnel host is not believed
    await raw(port, 'GET', '/?token=wrong', { host: `127.0.0.1:${port}`, 'cf-connecting-ip': '198.51.100.1' });
    assert.equal(JSON.parse((await api('GET', '/api/access')).body).entries[0].ip, '127.0.0.1');

    // lockout after 5 wrong passwords in a row
    for (let i = 0; i < 5; i++) await raw(port, 'POST', '/login', form, 'password=nope'); // a success reset the count
    assert.equal((await raw(port, 'POST', '/login', form, 'password=a+long+enough+secret')).status, 429, 'locked even for the right one');

    // off: the tunnel host is no longer accepted
    assert.equal((await api('POST', '/api/tunnel', { on: false })).status, 200);
    assert.equal((await raw(port, 'GET', '/login', { host: TH })).status, 421);
  } finally { await app.close(); }
});

test('installCloudflared: downloads the release file, makes it runnable, checks --version', async () => {
  const { installCloudflared } = await import('../src/remote.ts');
  const { createServer } = await import('node:http');
  const script = '#!/bin/sh\n[ "$1" = "--version" ] && echo "cloudflared version 2026.9.0"\n';
  const srv = createServer((req, res) => {
    if (req.url === '/cloudflared-linux-amd64') { res.end(script); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', () => ok()));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const dir = join(tmp(), 'bin');
  try {
    const bin = await installCloudflared(dir, base, 'cloudflared-linux-amd64');
    assert.equal(bin, join(dir, 'cloudflared'));
    assert.equal((await import('node:fs')).statSync(bin).mode & 0o111, 0o111, 'executable');
    await assert.rejects(installCloudflared(join(tmp(), 'b2'), base, 'cloudflared-linux-arm64'), /download failed \(404\)/);
    await assert.rejects(installCloudflared(dir, base, null), /no automatic install/);
  } finally { srv.close(); }
});
