import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { ev, tmp } from './fixtures.ts';

const TOKEN = 'd'.repeat(64);
const launched: any[] = [];
const ended: string[] = [];
let app: ReturnType<typeof startServer>;
let base = '';
const home = tmp('aw-spawn-home-');

before(async () => {
  const cfg = { ...parseConfig({ worlds: [
    { id: 'web', name: 'Web', repos: ['/work/repo-a', '/work/repo-b'], leadSpawn: true, maxSpawned: 2 },
    { id: 'ops', name: 'Ops', repos: ['/work/ops'] },
  ] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    home, spawnIdMs: 1000,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => {
      launched.push(o);
      return { tmuxSession: `awtest-spawn-${launched.length}`, dir: o.repo, branch: null, pane: `%${10 + launched.length}` };
    }) as any,
    typeInto: async () => true,
    endPane: async (pane: string) => { ended.push(pane); return null; },
  });
  await app.listen();
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
after(() => app.close());

const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
const hook = (body: object, id: string, pane: string, cwd: string) => fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id, cwd }) });
const tool = async (pane: string, name: string, args: object = {}) => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return ((await r.json()) as any).result as { content: { text: string }[]; isError?: boolean };
};
const state = async () => (await (await fetch(`${base}/api/state`, { headers: H })).json()) as any;
const LEAD = 'aaaa1111-0000', OTHER = 'bbbb2222-0000', OPS = 'cccc3333-0000';

test('aw_spawn is refused while the world has not enabled leadSpawn', async () => {
  await hook(ev.start, OPS, '%3', '/work/ops');
  const r = await tool('%3', 'aw_spawn', { folder: 'ops', task: 'fix the deploy' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /off for the Ops world.*"leadSpawn": true/);
  assert.equal(launched.length, 0);
});

test('aw_spawn only starts sessions in configured worlds\' folders', async () => {
  await hook(ev.start, LEAD, '%1', '/work/repo-a');
  for (const folder of ['/etc', 'missing']) {
    const r = await tool('%1', 'aw_spawn', { folder, task: 'x' });
    assert.equal(r.isError, true, folder);
    assert.match(r.content[0].text, /not one of the configured worlds' folders/);
  }
  for (const folder of ['/work/ops', 'ops']) {
    const r = await tool('%1', 'aw_spawn', { folder, task: 'x', agent: 'nope' });
    assert.match(r.content[0].text, /agent must be one of/, `${folder} resolves to the other world's folder`);
  }
  assert.equal((await tool('%1', 'aw_spawn', { folder: 'repo-b', task: 'x', agent: 'nope' })).isError, true);
  assert.equal(launched.length, 0);
});

test('a spawned session records its lead, shows it in aw_agents and survives its first hook', async () => {
  const pending = tool('%1', 'aw_spawn', { folder: 'repo-b', task: 'add CSV export', agent: 'claude' });
  let s = await state();
  for (let i = 0; i < 40 && !s.sessions.some((x: any) => x.id === 'starting:awtest-spawn-1'); i++) { await new Promise((r) => setTimeout(r, 10)); s = await state(); }
  assert.deepEqual([launched[0].repo, launched[0].task, launched[0].worktree, launched[0].agent], ['/work/repo-b', 'add CSV export', true, 'claude']);
  assert.equal(s.sessions.find((x: any) => x.id === 'starting:awtest-spawn-1').parent, LEAD);

  await hook(ev.start, 'dddd4444-0000', '%11', '/work/repo-b'); // its agent is up: the card gets its real id
  const r = await pending;
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.match(r.content[0].text, /session id dddd4444-0000/, 'aw_spawn waits for the real id instead of handing back the tmux name');
  s = await state();
  assert.ok(s.sessions.find((x: any) => x.id === LEAD).log.some((l: any) => /^Started Claude Code in repo-b: add CSV export/.test(l.text)), 'logged in the lead\'s recent steps');
  assert.equal(s.sessions.find((x: any) => x.id === 'dddd4444-0000').parent, LEAD);
  const peers = JSON.parse((await tool('%1', 'aw_agents')).content[0].text);
  assert.equal(peers.find((p: any) => p.id === 'dddd4444-0000').parent, LEAD);
  assert.equal(peers.find((p: any) => p.id === OPS).parent, null);
  assert.equal(JSON.parse(readFileSync(join(home, 'parents.json'), 'utf8'))['dddd4444-0000'], LEAD, 'kept across a restart');
});

test('the world\'s maxSpawned caps live spawned sessions', async () => {
  const two = await tool('%1', 'aw_spawn', { folder: '/work/ops', task: 'second', worktree: false });
  assert.equal(two.isError, undefined, two.content[0].text);
  assert.equal(launched[1].repo, '/work/ops');
  assert.equal(launched[1].worktree, false);
  assert.equal((await state()).sessions.find((x: any) => x.id === 'starting:awtest-spawn-2').worldId, 'ops');
  const three = await tool('%1', 'aw_spawn', { folder: 'repo-a', task: 'third' });
  assert.equal(three.isError, true);
  assert.match(three.content[0].text, /maxSpawned 2/);
  assert.equal(launched.length, 2);
});

test('aw_stop ends only the caller\'s own workers, which frees a place under the cap', async () => {
  await hook(ev.start, OTHER, '%2', '/work/repo-a');
  const notMine = await tool('%2', 'aw_stop', { session: 'dddd' });
  assert.equal(notMine.isError, true);
  assert.match(notMine.content[0].text, /did not start that session/);
  assert.equal((await tool('%1', 'aw_stop', { session: OTHER })).isError, true, 'a lead cannot end a peer');
  assert.deepEqual(ended, []);

  const ok = await tool('%1', 'aw_stop', { session: 'dddd' });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.deepEqual(ended, ['%11']);
  assert.equal((await state()).sessions.some((x: any) => x.id === 'dddd4444-0000'), false);
  assert.ok((await tool('%1', 'aw_stop', { session: 'awtest-spawn-2' })).content[0].text.startsWith('Ended'), 'by the tmux session aw_spawn named');

  // With steps it starts a run on the lead's team
  const run = await tool('%1', 'aw_spawn', { folder: 'ops', task: 'plan it', steps: [{ kind: 'plan', agent: 'claude' }] });
  assert.equal(run.isError, undefined, run.content[0].text);
  const s = await state();
  assert.equal(s.runs.at(-1).parent, LEAD);
  assert.equal(s.runs.at(-1).worldId, 'web', 'the lead owns the run even when its worker is in Ops');
  assert.equal(s.sessions.find((x: any) => x.id === `starting:awtest-spawn-${launched.length}`).parent, LEAD);
});

test('a finished one-task worker reports its result, ends, and frees its place', async () => {
  const h = tmp('aw-spawn-retire-');
  writeFileSync(join(h, 'runs.json'), JSON.stringify([{
    id: 'old-run', task: 'old', worldId: 'w', repo: '/work/x', worktree: false, dir: '/work/x', handoff: null,
    steps: [{ kind: 'plan', agent: 'claude', checkpoint: false, status: 'handed', pane: '%61', direct: null, sessionId: 'old-run-worker', summary: 'done' }],
    current: 0, rounds: 0, earlier: [], status: 'done', note: null, startedAt: Date.now(),
  }, {
    id: 'live-run', task: 'live', worldId: 'w', repo: '/work/x', worktree: false, dir: '/work/x', handoff: null,
    steps: [{ kind: 'plan', agent: 'claude', checkpoint: false, status: 'running', pane: '%61', direct: null, sessionId: 'old-live-worker', summary: null }],
    current: 0, rounds: 0, earlier: [], status: 'waiting', note: 'waiting', startedAt: Date.now(),
  }]));
  const cfg = { ...parseConfig({ worlds: [{ id: 'w', name: 'W', repos: ['/work/x'], leadSpawn: true, maxSpawned: 1 }] }), port: 0 };
  const stopped: string[] = [], notices: [string, string][] = [];
  let launches = 0, failSecondEnd = false;
  const server = startServer(cfg, TOKEN, {
    home: h, spawnIdMs: 30,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => ({ tmuxSession: `awtest-retire-${++launches}`, dir: o.repo, branch: null, pane: `%${60 + launches}` })) as any,
    typeInto: async (pane, text) => { notices.push([pane, text]); return true; },
    endPane: async (pane) => {
      if (pane === '%62' && failSecondEnd) { failSecondEnd = false; return 'pane is busy'; }
      stopped.push(pane); return null;
    },
  });
  await server.listen();
  const url = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  const hk = (body: object, id: string, pane: string) => fetch(`${url}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id, cwd: '/work/x' }) });
  const call = async (pane: string, name: string, args: object = {}) => ((await (await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()) as any).result;
  try {
    await hk(ev.start, 'lead-1', '%59');
    const first = call('%59', 'aw_spawn', { folder: 'x', task: 'do one thing' });
    for (let i = 0; i < 40 && !launches; i++) await new Promise((r) => setTimeout(r, 5));
    await hk(ev.start, 'worker-1', '%61');
    assert.equal((await first).isError, undefined);

    const response = await hk({ ...ev.stop, last_assistant_message: 'Finished.\n\nThe detailed result is here.' }, 'worker-1', '%61');
    assert.equal(response.status, 204, 'the Stop hook receives its response before cleanup');
    for (let i = 0; i < 40 && !stopped.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(stopped, ['%61']);
    assert.equal(server.store.sessions.has('worker-1'), false);
    assert.equal(notices.at(-1)?.[0], '%59', 'the lead is woken for the result');
    const inbox = await call('%59', 'aw_inbox');
    assert.match(inbox.content[0].text, /finished its task[\s\S]*The detailed result is here/);

    const replacement = await call('%59', 'aw_spawn', { folder: 'x', task: 'the next thing' });
    for (let i = 0; i < 40 && launches < 2; i++) await new Promise((r) => setTimeout(r, 5));
    await hk(ev.start, 'worker-2', '%62');
    assert.equal((await replacement).isError, undefined);
    await call('%59', 'aw_send', { to: 'worker-2', text: 'Check one more thing' });
    await hk({ ...ev.stop, last_assistant_message: 'First result' }, 'worker-2', '%62');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(stopped, ['%61'], 'unread follow-up mail keeps the worker open');
    assert.match((await call('%62', 'aw_inbox')).content[0].text, /Check one more thing/);
    failSecondEnd = true;
    await hk(ev.prompt, 'worker-2', '%62');
    await hk({ ...ev.stop, last_assistant_message: 'Result after the follow-up' }, 'worker-2', '%62');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(stopped, ['%61'], 'a failed pane close leaves the worker open');
    await hk(ev.prompt, 'worker-2', '%62');
    await hk({ ...ev.stop, last_assistant_message: 'Newest result' }, 'worker-2', '%62');
    for (let i = 0; i < 40 && stopped.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(stopped, ['%61', '%62']);
    assert.match((await call('%59', 'aw_inbox')).content[0].text, /Result after the follow-up[\s\S]*Newest result/);

    const orphan = call('%59', 'aw_spawn', { folder: 'x', task: 'work after the lead exits' });
    for (let i = 0; i < 40 && launches < 3; i++) await new Promise((r) => setTimeout(r, 5));
    await hk(ev.start, 'worker-3', '%63');
    assert.equal((await orphan).isError, undefined);
    await hk({ ...ev.end, reason: 'prompt_input_exit' }, 'lead-1', '%59');
    await hk({ ...ev.stop, last_assistant_message: 'Result with no live lead' }, 'worker-3', '%63');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(stopped, ['%61', '%62'], 'without a live lead, the result stays on the worker card');
    assert.equal(server.store.sessions.get('worker-3')?.state, 'done');
  } finally { await server.close(); }
});

test('a child finishing while its parent retires keeps its result card', async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'w', name: 'W', repos: ['/work/x'], leadSpawn: true, maxSpawned: 3 }] }), port: 0 };
  let launches = 0, parentEnding = false, releaseParent!: () => void;
  const stopped: string[] = [];
  const server = startServer(cfg, TOKEN, {
    home: tmp('aw-spawn-nested-retire-'), spawnIdMs: 500,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => ({ tmuxSession: `awtest-nested-${++launches}`, dir: o.repo, branch: null, pane: `%${70 + launches}` })) as any,
    typeInto: async () => true,
    endPane: async (pane) => {
      if (pane === '%71') { parentEnding = true; await new Promise<void>((r) => { releaseParent = r; }); }
      stopped.push(pane); return null;
    },
  });
  await server.listen();
  const url = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
  const hk = (body: object, id: string, pane: string) => fetch(`${url}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id, cwd: '/work/x' }) });
  const call = async (pane: string, name: string, args: object = {}) => ((await (await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()) as any).result;
  try {
    await hk(ev.start, 'root-lead', '%69');
    const parent = call('%69', 'aw_spawn', { folder: 'x', task: 'parent work' });
    for (let i = 0; i < 40 && launches < 1; i++) await new Promise((r) => setTimeout(r, 5));
    await hk(ev.start, 'parent-worker', '%71');
    assert.equal((await parent).isError, undefined);
    const child = call('%71', 'aw_spawn', { folder: 'x', task: 'child work' });
    for (let i = 0; i < 40 && launches < 2; i++) await new Promise((r) => setTimeout(r, 5));
    await hk(ev.start, 'child-worker', '%72');
    assert.equal((await child).isError, undefined);

    await hk({ ...ev.stop, last_assistant_message: 'Parent result' }, 'parent-worker', '%71');
    for (let i = 0; i < 40 && !parentEnding; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(parentEnding, true);
    await hk({ ...ev.stop, last_assistant_message: 'Child result' }, 'child-worker', '%72');
    await new Promise((r) => setImmediate(r));
    assert.equal(server.store.sessions.get('child-worker')?.state, 'done');
    assert.doesNotMatch(stopped.join(','), /%72/, 'the child is not retired into a disappearing parent');
    releaseParent();
  } finally { await server.close(); }
});

test('a lead that /clears keeps its workers: it still lists and ends them', async () => {
  await hook(ev.start, 'eeee5555-0000', '%4', '/work/repo-a');
  const r = await tool('%4', 'aw_spawn', { folder: 'repo-b', task: 'worker of a lead that clears' });
  assert.equal(r.isError, undefined, r.content[0].text);
  await hook(ev.start, 'ffff6666-0000', `%${10 + launched.length}`, '/work/repo-b');
  // The lead's /clear: Claude ends the old conversation first, then starts a new id in the same pane
  await hook({ ...ev.end, reason: 'clear' }, 'eeee5555-0000', '%4', '/work/repo-a');
  await hook({ ...ev.start, source: 'clear' }, 'eeee5555-1111', '%4', '/work/repo-a');
  const peers = JSON.parse((await tool('%4', 'aw_agents')).content[0].text);
  assert.equal(peers.find((p: any) => p.id === 'ffff6666-0000')?.parent, 'eeee5555-1111');
  assert.equal(JSON.parse(readFileSync(join(home, 'parents.json'), 'utf8'))['ffff6666-0000'], 'eeee5555-1111');
  // A restart ends the worker's process and resumes the same id: still on the team
  await hook({ ...ev.end, reason: 'other' }, 'ffff6666-0000', `%${10 + launched.length}`, '/work/repo-b');
  await hook({ ...ev.start, source: 'resume' }, 'ffff6666-0000', `%${10 + launched.length}`, '/work/repo-b');
  assert.equal((await state()).sessions.find((x: any) => x.id === 'ffff6666-0000')?.parent, 'eeee5555-1111');
  const ok = await tool('%4', 'aw_stop', { session: 'ffff' });
  assert.equal(ok.isError, undefined, ok.content[0].text);
  assert.equal(JSON.parse(readFileSync(join(home, 'parents.json'), 'utf8'))['ffff6666-0000'], undefined, 'forgotten once it ended');
});

test('a run takes one place under maxSpawned however many step sessions it opens, and the cap still holds', async () => {
  // One place is taken already: the run started above
  const run = await tool('%1', 'aw_spawn', { folder: 'repo-a', task: 'two steps', steps: [{ kind: 'plan', agent: 'claude' }, { kind: 'build', agent: 'claude' }] });
  assert.equal(run.isError, undefined, run.content[0].text);
  const pane = `%${10 + launched.length}`;
  await hook(ev.start, '99997777-0000', pane, '/work/repo-a');
  const endedBefore = ended.length;
  await hook(ev.stop, '99997777-0000', pane, '/work/repo-a');
  await new Promise((r) => setImmediate(r));
  assert.equal(ended.length, endedBefore, 'a run step is not automatically retired');
  assert.ok((await state()).sessions.some((x: any) => x.id === '99997777-0000'));
  const h = await tool(pane, 'aw_handoff', { summary: 'planned' });
  assert.match(h.content[0].text, /next step has started/);
  const s = await state();
  assert.ok(s.sessions.filter((x: any) => x.parent === LEAD).length >= 3, 'three step sessions are open');
  const over = await tool('%1', 'aw_spawn', { folder: 'repo-b', task: 'one too many' });
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /2 sessions or runs.*maxSpawned 2/);
  // Ending its step while it still starts (no session id yet) stops the run too
  const runId = s.runs.at(-1).id;
  assert.equal((await tool('%1', 'aw_stop', { session: `awtest-spawn-${launched.length}` })).isError, undefined);
  assert.equal((await state()).runs.find((x: any) => x.id === runId).status, 'stopped');
});

test('config: leadSpawn and maxSpawned are checked, and kept only when set', () => {
  const w = (extra: object) => parseConfig({ worlds: [{ id: 'w', repos: [], ...extra }] }).worlds[0];
  assert.deepEqual(Object.keys(w({})), ['id', 'name', 'color', 'repos'], 'not written back to config.json unless set');
  assert.deepEqual([w({ leadSpawn: true, maxSpawned: 3 }).leadSpawn, w({ leadSpawn: true, maxSpawned: 3 }).maxSpawned], [true, 3]);
  assert.throws(() => w({ leadSpawn: 'yes' }), /leadSpawn must be true or false/);
  assert.throws(() => w({ maxSpawned: -1 }), /maxSpawned must be an integer/);
});

test('a worker still coming up takes one place under the cap, not two', async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'w', name: 'W', repos: ['/work/x'], leadSpawn: true, maxSpawned: 2 }] }), port: 0 };
  let n = 0;
  const two = startServer(cfg, TOKEN, {
    home: tmp('aw-spawn-cap-'), spawnIdMs: 600,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => ({ tmuxSession: `awtest-cap-${++n}`, dir: o.repo, branch: null, pane: `%${50 + n}` })) as any,
    typeInto: async () => true, endPane: async () => null,
  });
  await two.listen();
  const url = `http://127.0.0.1:${(two.server.address() as { port: number }).port}`;
  const call = async (name: string, args: object) => ((await (await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': '%49' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json()) as any).result;
  try {
    await fetch(`${url}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': '%49' }, body: JSON.stringify({ ...ev.start, session_id: 'lead-0000', cwd: '/work/x' }) });
    const first = call('aw_spawn', { folder: 'x', task: 'one' }); // its agent never comes up: it waits for its id
    for (let i = 0; i < 40 && n < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50)); // its card is in the store now
    const second = await call('aw_spawn', { folder: 'x', task: 'two' });
    assert.equal(second.isError, undefined, second.content[0].text);
    assert.match((await first).content[0].text, /not up yet.*aw_stop takes awtest-cap-1/);
    const third = await call('aw_spawn', { folder: 'x', task: 'three' });
    assert.equal(third.isError, true, 'the cap still holds');
  } finally { two.close(); }
});

test('a cross-world worker still counts against its origin after its lead exits and the server restarts', async () => {
  const h = tmp('aw-spawn-origin-');
  const cfg = { ...parseConfig({ worlds: [
    { id: 'web', name: 'Web', repos: ['/work/repo-a'], leadSpawn: true, maxSpawned: 1 },
    { id: 'ops', name: 'Ops', repos: ['/work/ops'] },
  ] }), port: 0 };
  let launches = 0;
  const boot = async () => {
    const server = startServer(cfg, TOKEN, {
      home: h, spawnIdMs: 20,
      deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
      createSession: (async (o: any) => ({ tmuxSession: `awtest-origin-${++launches}`, dir: o.repo, branch: null, pane: `%${50 + launches}` })) as any,
      typeInto: async () => true, endPane: async () => null,
    });
    await server.listen();
    const url = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
    const hk = (body: object, id: string, pane: string, cwd: string) => fetch(`${url}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id, cwd }) });
    const spawn = async (pane: string, folder: string) => {
      const r = await fetch(`${url}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_spawn', arguments: { folder, task: 'work' } } }) });
      return ((await r.json()) as any).result as { isError?: boolean; content: { text: string }[] };
    };
    return { server, hk, spawn };
  };
  const one = await boot();
  try {
    await one.hk(ev.start, 'lead-old', '%41', '/work/repo-a');
    assert.equal((await one.spawn('%41', 'ops')).isError, undefined);
    await one.hk(ev.start, 'worker-1', '%51', '/work/ops');
    assert.equal(JSON.parse(readFileSync(join(h, 'spawn-origins.json'), 'utf8'))['worker-1'], 'web');
    await one.hk({ ...ev.end, reason: 'prompt_input_exit' }, 'lead-old', '%41', '/work/repo-a');
  } finally { await one.server.close(); }
  const two = await boot();
  try {
    await two.hk(ev.start, 'worker-1', '%51', '/work/ops');
    await two.hk({ ...ev.end, reason: 'other' }, 'worker-1', '%51', '/work/ops'); // its CLI restarts, then resumes the same id
    await two.hk({ ...ev.start, source: 'resume' }, 'worker-1', '%51', '/work/ops');
    await two.hk(ev.start, 'lead-new', '%42', '/work/repo-a');
    const denied = await two.spawn('%42', 'repo-a');
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /maxSpawned 1/);
    assert.equal(launches, 1);
  } finally { await two.server.close(); }
});
