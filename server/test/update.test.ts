import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { watchCode, prepareRestart } from '../src/update.ts';

import { tmp } from './fixtures.ts';

test('watchCode fires once when a source file becomes newer than at startup', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'a.ts'), 'x');
  let fired = 0;
  const stop = watchCode(() => fired++, [dir]);
  try {
    await new Promise((r) => setTimeout(r, 50));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'b.ts'), 'y');
    for (let i = 0; i < 40 && !fired; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(fired, 1);
    writeFileSync(join(dir, 'a.ts'), 'z');
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(fired, 1, 'only once');
  } finally { stop(); }
});

test('prepareRestart reports a server that does not load, and passes the real one', async () => {
  const root = tmp();
  mkdirSync(join(root, 'server/src'), { recursive: true });
  writeFileSync(join(root, 'server/src/server.ts'), 'export const x = ;\n');
  assert.match(await prepareRestart(root) ?? '', /does not load/);
  assert.equal(await prepareRestart(join(import.meta.dirname, '../..')), null);
});

test('POST /api/restart: refuses without a launcher or with broken code, else restarts', async () => {
  const cfg = { ...parseConfig({}), port: 0 };
  const go = async ({ before, ...opts }: Parameters<typeof startServer>[2] & { before?: (app: ReturnType<typeof startServer>) => void }) => {
    const app = startServer(cfg, 't'.repeat(64), { home: tmp(), ...opts });
    await app.listen();
    before?.(app);
    try {
      const r = await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/restart`, { method: 'POST', headers: { 'x-aw-token': 't'.repeat(64) } });
      return { status: r.status, body: await r.json() as any };
    } finally { app.store.sessions.clear(); await app.close(); } // the fake sessions can't go through store.remove
  };
  assert.equal((await go({})).status, 501);

  let restarted = 0;
  const broken = await go({ onRestart: () => restarted++, prepareRestart: async () => 'web build failed: boom' });
  assert.equal(broken.status, 409);
  assert.match(broken.body.error, /boom/);

  const waiting = await go({ onRestart: () => restarted++, prepareRestart: async () => null, before: (app) => {
    app.store.sessions.set('w', { id: 'w', repoName: 'shop', task: 'Fix the checkout', pending: [{}] } as any);
  } });
  assert.equal(waiting.status, 409);
  assert.match(waiting.body.error, /^This session is waiting for your answer: shop \(Fix the checkout\)/, 'names the session');

  const several = await go({ onRestart: () => restarted++, prepareRestart: async () => null, before: (app) => {
    app.store.sessions.set('a', { id: 'a', repoName: 'shop', task: 'x'.repeat(41), pending: [{}] } as any);
    app.store.sessions.set('b', { id: 'b', repoName: 'blog', pending: [{}] } as any);
  } });
  assert.equal(several.status, 409);
  assert.match(several.body.error, new RegExp(`^These sessions are waiting for your answer: shop \\(${'x'.repeat(40)}…\\), blog\\. `), 'cuts long tasks, names task-less sessions by repo');

  const ok = await go({ onRestart: () => restarted++, prepareRestart: async () => null });
  assert.equal(ok.status, 202);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(restarted, 1, 'restarts only after the checks pass');
});
