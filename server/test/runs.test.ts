import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { saveRuns, loadRuns, excludeRunFiles, newRun } from '../src/runs.ts';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev, tmp } from './fixtures.ts';

const TOKEN = 'c'.repeat(64);
const launched: any[] = [];
const ended: string[] = [];
let failNext = false, slow = 0;
const dir = tmp('aw-run-');
let app: ReturnType<typeof startServer>;
let base = '';
const home = tmp('aw-run-home-');

before(async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    home, installed: () => true,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => {
      if (slow) await new Promise((r) => setTimeout(r, slow));
      if (failNext) { failNext = false; throw new Error('tmux is gone'); }
      launched.push(o);
      return { tmuxSession: `awtest-run-${launched.length}`, dir, branch: null, pane: `%${50 + launched.length}` };
    }) as any,
    typeInto: async () => true,
    endPane: async (pane: string) => { ended.push(pane); return null; },
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
  assert.equal((await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'cursor' }] })).status, 400);
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

test('a code review that says CHANGES sends the work back to Build, at most twice; stopping ends every round\'s sessions', async () => {
  const { body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'build', agent: 'claude' }, { kind: 'review-code', agent: 'claude' }] });
  const id = body.run.id, files = join(dir, `.aw/run-${id}`);
  mkdirSync(files, { recursive: true });
  const panes: string[] = [];
  const step = async (sid: string, summary: string) => {
    const pane = `%${50 + launched.length}`; panes.push(pane);
    await hook(ev.start, sid, pane); await hook(ev.prompt, sid, pane);
    return (await handoff(pane, summary)).content[0].text as string;
  };
  const run = async () => ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).runs.find((x: any) => x.id === id);
  assert.match(launched.at(-1).task, /step 1 of 2 \(Build\)/);
  assert.doesNotMatch(launched.at(-1).task, /round/);
  for (const round of [2, 3]) {
    await step(`cb-build-${round}`, 'built');
    writeFileSync(join(files, 'code-review.md'), '## **CHANGES**\n\n- the export skips the header row\n');
    assert.match(await step(`cb-review-${round}`, 'needs a header row'), /next step has started/);
    assert.match(launched.at(-1).task, new RegExp(`step 1 of 2 \\(Build\\)[\\s\\S]*round ${round}: the code review asked for changes[\\s\\S]*The step before you \\(Review code, claude\\) left a handoff[\\s\\S]*needs a header row`));
    const r = await run();
    assert.equal(r.current, 0); assert.equal(r.rounds, round - 1); assert.equal(r.steps[0].sessionId, null, 'the new build session links on its first hook');
  }
  await step('cb-build-4', 'built');
  const n = launched.length;
  assert.match(await step('cb-review-4', 'still no header'), /user checks your work/);
  assert.equal(launched.length, n, 'no third round');
  const held = await run();
  assert.equal(held.status, 'waiting'); assert.match(held.note, /still asks for changes after 2 rounds/);
  assert.equal((await post(`/api/runs/${id}/next`)).body.run.status, 'done', 'you can go on anyway');
  assert.equal((await post(`/api/runs/${id}/stop`, { endSessions: true })).status, 200);
  assert.deepEqual(panes.filter((p) => !ended.includes(p)), [], 'earlier rounds\' sessions end too');
});

test('a code review that says APPROVED, or that you move on yourself, goes on as usual', async () => {
  const { body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'build', agent: 'claude' }, { kind: 'review-code', agent: 'claude' }, { kind: 'plan', agent: 'claude' }] });
  const id = body.run.id, files = join(dir, `.aw/run-${id}`);
  mkdirSync(files, { recursive: true });
  let pane = `%${50 + launched.length}`;
  await hook(ev.start, 'ap-build', pane); await hook(ev.prompt, 'ap-build', pane); await handoff(pane, 'built');
  writeFileSync(join(files, 'code-review.md'), 'APPROVED\n');
  pane = `%${50 + launched.length}`;
  await hook(ev.start, 'ap-review', pane); await hook(ev.prompt, 'ap-review', pane); await handoff(pane, 'fine');
  assert.match(launched.at(-1).task, /step 3 of 3 \(Plan\)/);
  const { body: b2 } = await post('/api/runs', { ...RUN, steps: [{ kind: 'build', agent: 'claude' }, { kind: 'review-code', agent: 'claude' }, { kind: 'plan', agent: 'claude' }] });
  mkdirSync(join(dir, `.aw/run-${b2.run.id}`), { recursive: true });
  writeFileSync(join(dir, `.aw/run-${b2.run.id}`, 'code-review.md'), 'CHANGES\n');
  await post(`/api/runs/${b2.run.id}/next`); // build moved on by hand
  pane = `%${50 + launched.length}`;
  await hook(ev.start, 'mv-review', pane); await hook(ev.prompt, 'mv-review', pane); await hook(ev.stop, 'mv-review', pane);
  assert.match((await post(`/api/runs/${b2.run.id}/next`)).body.run.steps[2].status, /running/, 'moved on by hand: no round back');
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
  const dir = tmp('aw-runs-');
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
  writeFileSync(file, '[null, {"id": 1}, {"id": "x", "status": "running", "steps": [], "current": 0}, {"id": "y", "status": "running", "steps": [{}], "current": 3},'
    + ' {"id": "z", "status": "running", "steps": [null], "current": 0}, {"id": "w", "status": "running", "steps": [{"status": "running", "kind": "dance", "agent": "claude"}], "current": 0}]');
  assert.deepEqual(loadRuns(file), []);
  writeFileSync(file, '{not json');
  assert.deepEqual(loadRuns(file), []);
});

test('excludeRunFiles adds .aw/ to the repo\'s exclude once, and leaves a non-git folder alone', async () => {
  const repo = tmp('aw-ex-');
  execFileSync('git', ['init', '-q', repo]);
  await excludeRunFiles(repo);
  await excludeRunFiles(repo);
  const ex = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(ex.split('\n').filter((l) => l === '.aw/').length, 1);
  const plain = tmp('aw-ex-');
  mkdirSync(join(plain, 'x'));
  await excludeRunFiles(plain); // no throw, nothing written
});

test('stop can end the run\'s sessions too, also once the run is over', async () => {
  const { body } = await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude' }, { kind: 'build', agent: 'claude' }] });
  const id = body.run.id, plan = `%${50 + launched.length}`;
  await hook(ev.start, 'plan-end', plan);
  await hook(ev.prompt, 'plan-end', plan);
  await handoff(plan, 'planned');
  const build = `%${50 + launched.length}`; // still a starting card: matched by its pane
  assert.notEqual(build, plan);
  ended.length = 0;
  const r = await post(`/api/runs/${id}/stop`, { endSessions: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.status, 'stopped');
  assert.deepEqual(ended.sort(), [plan, build].sort());
  const sessions = ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).sessions;
  assert.ok(!sessions.some((s: any) => s.tmux && [plan, build].includes(s.tmux.pane)), 'their cards are gone');
  assert.equal((await post(`/api/runs/${id}/stop`)).status, 409, 'stopping twice without ending sessions is still refused');
  assert.equal((await post(`/api/runs/${id}/stop`, { endSessions: true })).status, 200, 'ending what is left of a stopped run is fine');
});

test('a user-started run defaults Codex to unrestricted across steps and restarts', async () => {
  const steps = [{ kind: 'plan', agent: 'claude', checkpoint: true }, { kind: 'build', agent: 'codex' }];
  assert.equal((await post('/api/runs', { ...RUN, steps: [{ kind: 'plan', agent: 'claude' }], codexUnrestricted: true })).status, 400);
  const { status, body } = await post('/api/runs', { ...RUN, steps });
  assert.equal(status, 201);
  assert.equal(body.run.codexUnrestricted, true);
  const saved = loadRuns(join(home, 'runs.json')).find((r) => r.id === body.run.id);
  assert.equal(saved?.codexUnrestricted, true);
  const pane = `%${50 + launched.length}`;
  await hook(ev.start, 'access-plan', pane);
  await hook(ev.prompt, 'access-plan', pane);
  await handoff(pane, 'planned');
  await post(`/api/runs/${body.run.id}/next`);
  assert.equal(launched.at(-1).agent, 'codex');
  assert.equal(launched.at(-1).codexUnrestricted, true);
  const bounded = await post('/api/runs', { ...RUN, steps: [{ kind: 'build', agent: 'codex' }], codexUnrestricted: false });
  assert.equal(bounded.status, 201);
  assert.equal(bounded.body.run.codexUnrestricted, undefined);
  assert.equal(launched.at(-1).codexUnrestricted, false);
});

test('a lead-started Codex run saves unrestricted access across restarts', () => {
  const r = newRun({ task: 'build', worldId: 'web', repo: '/work/repo-a', worktree: false, now: 1, parent: 'lead-one', steps: [{ kind: 'build', agent: 'codex', checkpoint: false }] });
  assert.equal(r.codexUnrestricted, true);
  const file = join(tmp(), 'runs.json');
  saveRuns(file, new Map([[r.id, r]]), 1);
  assert.equal(loadRuns(file)[0].codexUnrestricted, true);
  const old = { ...r }; delete old.codexUnrestricted;
  writeFileSync(file, JSON.stringify([old]));
  assert.equal(loadRuns(file)[0].codexUnrestricted, false, 'old lead runs keep their previous sandbox behavior');
});
