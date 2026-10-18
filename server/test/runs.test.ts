import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev } from './fixtures.ts';

const TOKEN = 'c'.repeat(64);
const launched: any[] = [];
const dir = mkdtempSync(join(tmpdir(), 'aw-run-'));
let app: ReturnType<typeof startServer>;
let base = '';

before(async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    home: mkdtempSync(join(tmpdir(), 'aw-run-home-')),
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => {
      launched.push(o);
      return { tmuxSession: `awtest-run-${launched.length}`, dir, branch: null, pane: `%${50 + launched.length}` };
    }) as any,
    typeInto: async () => true,
  });
  await app.listen();
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
after(() => app.close());

const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
const post = async (path: string, body: object = {}) => { const r = await fetch(base + path, { method: 'POST', headers: H, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
const hook = (body: object, id: string, pane: string) => fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id, cwd: dir }) });
const handoff = async (pane: string, summary: string) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_handoff', arguments: { summary } } }) });
  return ((await r.json()) as any).result;
};
const RUN = { worldId: 'web', repo: '/work/repo-a', task: 'add CSV export' };

test('POST /api/runs validates the task and steps', async () => {
  assert.equal((await post('/api/runs', { ...RUN, task: '' , steps: [{ kind: 'plan', agent: 'claude' }] })).status, 400);
  assert.equal((await post('/api/runs', { ...RUN, steps: [] })).status, 400);
  assert.equal((await post('/api/runs', { ...RUN, steps: [{ kind: 'dance', agent: 'claude' }] })).status, 400);
  assert.equal((await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'gemini' }] })).status, 400);
  assert.equal(launched.length, 0);
});

test('a run: plan hands off, waits at its checkpoint, build starts with the handoff, then the run is done', async () => {
  const { status, body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude', checkpoint: true }, { kind: 'build', agent: 'claude' }] });
  assert.equal(status, 201);
  const id = body.run.id;
  assert.equal(launched.length, 1);
  assert.equal(launched[0].repo, '/work/repo-a');
  assert.match(launched[0].task, /step 1 of 2 \(Plan\)[\s\S]*add CSV export[\s\S]*\.aw\/run-\w+\/plan\.md[\s\S]*aw_handoff/);

  assert.equal((await handoff('%51', 'too early')).isError, true, 'the session is not known yet');
  await hook(ev.start, 'plan-1', '%51');
  await hook(ev.prompt, 'plan-1', '%51');
  assert.match((await handoff('%51', 'plan.md is ready')).content[0].text, /user checks your work/);
  assert.equal(launched.length, 1, 'held at the checkpoint');
  assert.equal((await handoff('%51', 'again')).isError, true, 'a step hands off once');

  const next = await post(`/api/runs/${id}/next`);
  assert.equal(next.status, 200);
  assert.equal(launched.length, 2);
  assert.equal(launched[1].repo, dir, 'later steps run in the first step\'s folder');
  assert.equal(launched[1].worktree, false);
  assert.match(launched[1].task, /step 2 of 2 \(Build\)[\s\S]*left a handoff: read ".*handoffs\/plan-1\.md" first\. Its summary: plan\.md is ready/);

  await hook(ev.start, 'build-1', '%52');
  await hook(ev.prompt, 'build-1', '%52');
  assert.match((await handoff('%52', 'built and committed')).content[0].text, /run is done/);
  assert.equal(next.body.run.id, id);
  assert.equal((await post(`/api/runs/${id}/next`)).status, 409, 'done is done');
});

test('a step whose turn ends without a handoff waits for you; "next" moves it on, "stop" ends the run', async () => {
  const { body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude' }, { kind: 'review-plan', agent: 'claude' }, { kind: 'build', agent: 'claude' }] });
  const id = body.run.id, pane = `%${50 + launched.length}`;
  await hook(ev.start, 'plan-2', pane);
  await hook(ev.prompt, 'plan-2', pane);
  await hook(ev.stop, 'plan-2', pane);
  const run = ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).runs.find((x: any) => x.id === id);
  assert.equal(run.status, 'waiting');
  assert.match(run.note, /Plan ended its turn without handing off/);
  const n = launched.length;
  const r = await post(`/api/runs/${id}/next`);
  assert.equal(launched.length, n + 1, 'moved on by hand');
  assert.equal(r.body.run.current, 1);
  assert.equal((await post(`/api/runs/${id}/stop`)).body.run.status, 'stopped');
  assert.equal((await post(`/api/runs/${id}/next`)).status, 409);
});
