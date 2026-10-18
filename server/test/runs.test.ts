import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { saveRuns, loadRuns, excludeRunFiles, newRun } from '../src/runs.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev } from './fixtures.ts';

const TOKEN = 'c'.repeat(64);
const launched: any[] = [];
let failNext = false, slow = 0;
const dir = mkdtempSync(join(tmpdir(), 'aw-run-'));
let app: ReturnType<typeof startServer>;
let base = '';
const home = mkdtempSync(join(tmpdir(), 'aw-run-home-'));

before(async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    home,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => {
      if (slow) await new Promise((r) => setTimeout(r, slow));
      if (failNext) { failNext = false; throw new Error('tmux is gone'); }
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
  const saved = JSON.parse(readFileSync(join(home, 'runs.json'), 'utf8')).find((x: any) => x.id === id);
  assert.equal(saved.status, 'done', 'kept in runs.json for the next server start');
  assert.deepEqual(saved.steps.map((s: any) => s.sessionId), ['plan-1', 'build-1']);
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

test('runs.json brings a run back after a restart, and its step can still hand off', async () => {
  const { body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude' }, { kind: 'build', agent: 'claude' }] });
  const pane = `%${50 + launched.length}`;
  await hook(ev.start, 'plan-3', pane);
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  const again = startServer(cfg, TOKEN, {
    home,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => { launched.push(o); return { tmuxSession: 'awtest-again', dir, branch: null, pane: '%99' }; }) as any,
  });
  await again.listen();
  try {
    const b2 = `http://127.0.0.1:${(again.server.address() as { port: number }).port}`;
    const state = (await (await fetch(`${b2}/api/state`, { headers: H })).json()) as any;
    assert.equal(state.runs.find((x: any) => x.id === body.run.id).status, 'running');
    await fetch(`${b2}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...ev.prompt, session_id: 'plan-3', cwd: dir }) });
    const r = await fetch(`${b2}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_handoff', arguments: { summary: 'after the restart' } } }) });
    assert.match(((await r.json()) as any).result.content[0].text, /next step has started/);
    assert.equal(launched.at(-1).repo, dir);
  } finally { await again.close(); }
});

test('a worktree run is named after the run; /clear in a step keeps it able to hand off', async () => {
  const { body } = await post('/api/runs', { ...RUN, worktree: true, steps: [{ kind: 'plan', agent: 'claude' }, { kind: 'build', agent: 'claude' }] });
  const first = launched.at(-1);
  assert.deepEqual([first.worktree, first.branch], [true, `aw/run-${body.run.id}`]);
  const pane = `%${50 + launched.length}`;
  await hook(ev.start, 'plan-4', pane);
  await hook(ev.start, 'plan-4b', pane); // /clear: a new conversation replaces the old one in the same pane
  const run = ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).runs.find((x: any) => x.id === body.run.id);
  assert.equal(run.steps[0].sessionId, 'plan-4b');
  await hook(ev.prompt, 'plan-4b', pane);
  assert.match((await handoff(pane, 'planned after a /clear')).content[0].text, /next step has started/);
});

const runOfState = async (id: string) => ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).runs.find((x: any) => x.id === id);

test('a step that cannot start fails the run, which can be dismissed; Stop while a step starts stays stopped', async () => {
  failNext = true;
  const bad = await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude' }] });
  assert.equal(bad.status, 422);
  assert.deepEqual([bad.body.run.status, bad.body.run.steps[0].status], ['failed', 'pending']);
  assert.match(bad.body.run.note, /could not start: tmux is gone/);
  assert.equal((await post(`/api/runs/${bad.body.run.id}/stop`)).body.run.status, 'stopped', 'Dismiss');

  const { body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude' }, { kind: 'build', agent: 'claude' }] });
  const pane = launched.at(-1) && `%${50 + launched.length}`;
  await hook(ev.start, 'plan-5', pane);
  await hook(ev.prompt, 'plan-5', pane);
  slow = 150;
  const handing = handoff(pane, 'plan ready');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await post(`/api/runs/${body.run.id}/next`)).status, 409, 'a second move-on while the first is in flight');
  assert.equal((await handoff(pane, 'again')).isError, true);
  assert.equal((await post(`/api/runs/${body.run.id}/stop`)).body.run.status, 'stopped');
  assert.match((await handing).content[0].text, /stopped the run/);
  slow = 0;
  assert.equal((await runOfState(body.run.id)).status, 'stopped', 'not run on by the step that was starting');
});

test('a step whose session ends waits; moving on gives no borrowed handoff; a pause-after step moves on by hand; work resumes the run', async () => {
  const { body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude', checkpoint: true }, { kind: 'review-plan', agent: 'claude' }, { kind: 'build', agent: 'claude' }] });
  const id = body.run.id;
  let pane = `%${50 + launched.length}`;
  await hook(ev.start, 'plan-6', pane);
  await hook(ev.prompt, 'plan-6', pane);
  await hook(ev.stop, 'plan-6', pane);
  assert.equal((await runOfState(id)).status, 'waiting');
  await hook({ ...ev.prompt, prompt: 'use the existing exporter' }, 'plan-6', pane); // you answered it: at work again (a different payload: identical ones within 500 ms are deduplicated)
  assert.equal((await runOfState(id)).status, 'running');
  await hook({ ...ev.stop, last_assistant_message: 'Plan written.' }, 'plan-6', pane);
  const n = launched.length;
  await post(`/api/runs/${id}/next`); // a pause-after step that never handed off: moved on by hand anyway
  assert.equal(launched.length, n + 1);
  pane = `%${50 + launched.length}`;
  await hook(ev.start, 'review-6', pane);
  await hook(ev.end, 'review-6', pane);
  const gone = await runOfState(id);
  assert.equal(gone.status, 'waiting');
  assert.match(gone.note, /session ended before handing off/);
  await post(`/api/runs/${id}/next`);
  assert.doesNotMatch(launched.at(-1).task, /left a handoff/, 'the step before had no session, so there is no handoff to point at');
});

test('runs.json: finished runs are pruned, live ones never; a corrupt file is ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-runs-'));
  const file = join(dir, 'runs.json');
  const map = new Map();
  const mk = (status: string, startedAt: number) => { const r = { ...newRun({ task: 't', worldId: 'w', repo: '/r', worktree: false, now: startedAt, steps: [{ kind: 'plan', agent: 'claude', checkpoint: false }] }), status }; map.set(r.id, r); return r; };
  const now = Date.now();
  const oldWaiting = mk('waiting', now - 30 * 864e5);
  mk('done', now - 30 * 864e5);
  for (let i = 0; i < 55; i++) mk('done', now - i);
  saveRuns(file, map, now);
  const kept = loadRuns(file);
  assert.equal(kept.filter((r) => r.status === 'done').length, 50);
  assert.ok(kept.some((r) => r.id === oldWaiting.id), 'a live run is never pruned');
  writeFileSync(file, '[null, {"id": 1}, {"id": "x", "steps": [], "current": 0}, {"id": "y", "steps": [{}], "current": 3}]');
  assert.deepEqual(loadRuns(file), []);
  writeFileSync(file, '{not json');
  assert.deepEqual(loadRuns(file), []);
});

test('excludeRunFiles adds .aw/ to the repo\'s exclude once, and leaves a non-git folder alone', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'aw-ex-'));
  execFileSync('git', ['init', '-q', repo]);
  await excludeRunFiles(repo);
  await excludeRunFiles(repo);
  const ex = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(ex.split('\n').filter((l) => l === '.aw/').length, 1);
  const plain = mkdtempSync(join(tmpdir(), 'aw-ex-'));
  mkdirSync(join(plain, 'x'));
  await excludeRunFiles(plain); // no throw, nothing written
});
