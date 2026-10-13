import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, riskOf, oneLine, nextWake } from '../src/store.ts';
import { parseConfig } from '../src/config.ts';
import { ev, QUESTION } from './fixtures.ts';

const tick = () => new Promise((r) => setImmediate(r));

/** Fixtures use cwd /work/repo-a; `root` relocates that repo (and a sibling repo-b) for tests that write files. */
function setup(opts: { clients?: boolean; holdMs?: number; root?: string; userSettingsPath?: string; now?: () => number; placements?: Map<string, string> } = {}) {
  const emitted: any[] = [];
  const root = opts.root ?? '/work';
  const cfg = parseConfig({
    worlds: [{ id: 'web', name: 'Web', color: '#47b4a7', repos: [`${root}/repo-a`, `${root}/repo-b`] }, { id: 'pos', name: 'POS', color: '#cc8844', repos: [] }],
    userSettingsPath: opts.userSettingsPath ?? '/nonexistent/settings.json',
  });
  const st = { clients: opts.clients ?? false };
  const counts = new Map<string, number>();
  const store = new Store(cfg, {
    repoInfo: async (cwd) => {
      const m = cwd.match(/^\/work\/(repo-[ab])(\/.*)?$/);
      const repo = m ? `${root}/${m[1]}` : cwd;
      return { repo, branch: 'main', worktree: !!m?.[2], top: m ? repo + (m[2] ?? '') : cwd };
    },
    branchOf: async () => 'main',
    tmuxSessionOf: async () => 'aw-repo-a',
    clientsConnected: () => st.clients,
    holdMs: opts.holdMs ?? 10_000,
    now: opts.now,
    placements: opts.placements && { get: (id) => opts.placements!.get(id), set: (id, w) => { if (w) opts.placements!.set(id, w); else opts.placements!.delete(id); } },
    stats: {
      get: (r, k) => counts.get(r + '|' + k) ?? 0,
      inc: (r, k) => { const n = (counts.get(r + '|' + k) ?? 0) + 1; counts.set(r + '|' + k, n); return n; },
    },
  }, (e) => emitted.push(e));
  const view = () => store.list()[0] as any;
  return { store, emitted, view, st, cfg };
}

test('a session walks working -> waiting -> working -> done from recorded payloads', async () => {
  const { store, view } = setup();
  assert.equal(await store.handle(ev.start, '%5'), '');
  let s = view();
  assert.equal(s.state, 'idle');
  assert.equal(s.worldId, 'web');
  assert.equal(s.repoName, 'repo-a');
  assert.equal(s.worktree, false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(view().tmux, { session: 'aw-repo-a', pane: '%5' });

  await store.handle(ev.prompt, '%5');
  s = view();
  assert.equal(s.state, 'working');
  assert.equal(s.task, 'Run touch hello.txt');

  await store.handle(ev.preBash, '%5');
  assert.equal(view().now, 'Bash: touch hello.txt');

  // No GUI connected: answered "{}" at once, card shows but is terminal-only.
  assert.equal(await store.handle(ev.permBash, '%5'), '{}');
  s = view();
  assert.equal(s.state, 'waiting');
  assert.ok(s.waitingSince);
  assert.equal(s.card.kind, 'permission');
  assert.equal(s.card.live, false);
  assert.equal(s.card.command, 'touch hello.txt');
  assert.equal(s.card.seenCount, 0, 'never allowed before in this repo');
  assert.equal(s.card.rule, 'Bash(touch hello.txt)');

  await store.handle(ev.notifyPerm, '%5');
  assert.equal(view().state, 'waiting');

  await store.handle(ev.postBash, '%5');
  s = view();
  assert.equal(s.state, 'working');
  assert.equal(s.card, null);
  assert.equal(s.waitingSince, null);

  await store.handle(ev.stop, '%5');
  s = view();
  assert.equal(s.state, 'done');
  assert.deepEqual(s.card, { kind: 'done', summary: 'ok', review: null });
  assert.ok(s.log.length > 3 && s.log.length <= 20);
});

test('held permission resolves with the allow / deny hook output', async () => {
  const { store, view } = setup({ clients: true });
  await store.handle(ev.prompt, null);
  const held = store.handle(ev.permBash, null);
  await tick();
  const card = view().card;
  assert.equal(card.live, true);
  assert.equal(store.decide('sess-1', { requestId: card.requestId, decision: 'allow', scope: 'once' }), null);
  assert.deepEqual(JSON.parse(await held), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(view().state, 'working');

  const held2 = store.handle(ev.permBash, null);
  await tick();
  assert.equal(view().card.seenCount, 1, 'allowed once before');
  assert.equal(store.decide('sess-1', { requestId: view().card.requestId, decision: 'deny' }), null);
  const out = JSON.parse(await held2).hookSpecificOutput.decision;
  assert.equal(out.behavior, 'deny');
  assert.equal(typeof out.message, 'string');
});

test('decide validates input and rejects stale or unknown requests', async () => {
  const { store, view } = setup({ clients: true });
  const held = store.handle(ev.permBash, null);
  await tick();
  const { requestId } = view().card;
  assert.equal(store.decide('nope', { requestId, decision: 'allow' })?.[0], 404);
  assert.equal(store.decide('sess-1', { requestId, decision: 'maybe' })?.[0], 400);
  assert.equal(store.decide('sess-1', { requestId, decision: 'allow', scope: 'galaxy' })?.[0], 400);
  assert.equal(store.decide('sess-1', { requestId: 'x', decision: 'allow' })?.[0], 409);
  assert.equal(store.answer('sess-1', { requestId, answers: {} })?.[0], 409);
  assert.equal(store.decide('sess-1', { requestId, decision: 'allow' }), null);
  await held;
  assert.equal(store.decide('sess-1', { requestId, decision: 'allow' })?.[0], 409, 'second decision on the same request');
});

test('hold timeout answers "{}" and leaves a terminal-only card', async () => {
  const { store, view } = setup({ clients: true, holdMs: 20 });
  const t0 = Date.now();
  assert.equal(await store.handle(ev.permBash, null), '{}');
  assert.ok(Date.now() - t0 >= 15);
  const card = view().card;
  assert.equal(card.live, false);
  assert.equal(view().state, 'waiting');
  assert.equal(store.decide('sess-1', { requestId: card.requestId, decision: 'allow' })?.[0], 409);
  await store.handle(ev.postBash, null); // user answered in the terminal
  assert.equal(view().card, null);
});

test('answering in the terminal releases the held hook', async () => {
  const { store, view } = setup({ clients: true });
  const held = store.handle(ev.permBash, null);
  await tick();
  await store.handle(ev.postBash, null);
  assert.equal(await held, '{}');
  assert.equal(view().card, null);
  assert.equal(view().state, 'working');
});

test('Esc in the terminal (hook killed) drops the card and goes idle', async () => {
  const { store, view } = setup({ clients: true });
  await store.handle(ev.prompt, null);
  const ac = new AbortController();
  store.handle(ev.permBash, null, ac.signal);
  await tick();
  assert.equal(view().state, 'waiting');
  ac.abort();
  assert.equal(view().card, null);
  assert.equal(view().state, 'idle');
});

test('questions are answered through PermissionRequest updatedInput', async () => {
  const { store, view } = setup({ clients: true });
  await store.handle(ev.preAsk, null);
  const held = store.handle(ev.permAsk, null);
  await tick();
  const card = view().card;
  assert.equal(card.kind, 'question');
  assert.equal(card.questions[0].options[1].label, 'Blue');
  assert.equal(store.decide('sess-1', { requestId: card.requestId, decision: 'allow' })?.[0], 409);
  assert.equal(store.answer('sess-1', { requestId: card.requestId, answers: {} })?.[0], 400);
  assert.equal(store.answer('sess-1', { requestId: card.requestId, answers: 'Red' })?.[0], 400);
  assert.equal(store.answer('sess-1', { requestId: card.requestId, answers: { [QUESTION]: 'Red' } }), null);
  const d = JSON.parse(await held).hookSpecificOutput.decision;
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput.answers, { [QUESTION]: 'Red' });
  assert.equal(d.updatedInput.questions[0].question, QUESTION);
});

test('question answered in the terminal: PostToolUse with answers still matches', async () => {
  const { store, view } = setup({ clients: true });
  const held = store.handle(ev.permAsk, null);
  await tick();
  await store.handle(ev.postAsk, null);
  assert.equal(await held, '{}');
  assert.equal(view().card, null);
});

test('several pending requests queue; the card shows the oldest', async () => {
  const { store, view } = setup({ clients: true });
  const a = store.handle(ev.permBash, null);
  await tick();
  const b = store.handle(ev.permAsk, null);
  await tick();
  assert.equal(view().card.kind, 'permission');
  store.decide('sess-1', { requestId: view().card.requestId, decision: 'allow' });
  await a;
  assert.equal(view().card.kind, 'question');
  assert.equal(view().state, 'waiting');
  store.answer('sess-1', { requestId: view().card.requestId, answers: { [QUESTION]: 'Blue' } });
  await b;
  assert.equal(view().state, 'working');
});

test('Stop and SessionEnd release held hooks', async () => {
  const { store, emitted, view } = setup({ clients: true });
  const a = store.handle(ev.permBash, null);
  await tick();
  await store.handle(ev.stop, null);
  assert.equal(await a, '{}');
  assert.equal(view().state, 'done');
  const b = store.handle(ev.permBash, null);
  await tick();
  await store.handle(ev.end, null);
  assert.equal(await b, '{}');
  assert.equal(store.list().length, 0);
  assert.deepEqual(emitted.at(-1), { type: 'session-removed', id: 'sess-1' });
});

test('helpers: Agent tool spawns a helper, PostToolUse / SubagentStop finish it', async () => {
  const { store, view } = setup();
  await store.handle(ev.preAgent, null);
  await store.handle(ev.subStart, null);
  assert.deepEqual(view().helpers.map((h: any) => [h.id, h.task, h.state]), [['toolu_3', 'Find callers of foo', 'working']]);
  await store.handle(ev.postAgent, null);
  assert.equal(view().helpers[0].state, 'done');

  const bg = { ...ev.preAgent, tool_use_id: 'toolu_4', tool_input: { ...ev.preAgent.tool_input, run_in_background: true } };
  await store.handle(bg, null);
  await store.handle({ ...ev.subStart, agent_id: 'agent-10' }, null);
  await store.handle({ ...ev.postAgent, tool_use_id: 'toolu_4' }, null);
  assert.equal(view().helpers[1].state, 'working', 'background helper keeps running after PostToolUse');
  await store.handle({ ...ev.subStop, agent_id: 'agent-10' }, null);
  assert.equal(view().helpers[1].state, 'done');
  assert.equal('agentId' in view().helpers[1], false, 'internal fields are not exposed');
});

test('a background subagent working after the turn ended keeps the session where its card put it', async () => {
  const { store, view } = setup();
  const sub = { agent_id: 'agent-10', agent_type: 'Explore' };
  await store.handle({ ...ev.stop, last_assistant_message: 'Found it.\n\nShould I build that?' }, null);
  await store.handle({ ...ev.preBash, ...sub }, null);
  await store.handle({ ...ev.postBash, ...sub }, null);
  assert.equal(view().state, 'waiting');
  assert.deepEqual(view().card, { kind: 'asking', summary: 'Should I build that?' });

  // its permission prompt still needs you; once answered, the question is back
  const r = store.handle({ ...ev.permBash, ...sub }, null);
  await tick();
  assert.equal(view().card.kind, 'permission');
  await store.handle({ ...ev.postBash, ...sub }, null);
  assert.equal(await r, '{}');
  assert.equal(view().state, 'waiting');
  assert.equal(view().card.kind, 'asking');

  await store.handle(ev.stop, null);
  await store.handle({ ...ev.preBash, ...sub }, null);
  assert.equal(view().state, 'done');

  // the session's own tool calls still wake it
  await store.handle(ev.preBash, null);
  assert.equal(view().state, 'working');
  assert.equal(view().card, null);
});

test('a turn that ends with background work running stays at the desks until it is back, or gives up after 30 min', async () => {
  let t = 1_000_000;
  const { store, view } = setup({ now: () => t });
  const task = { id: 'b1', type: 'subagent', status: 'running', description: 'Trace the bug', agent_type: 'Explore' };
  await store.handle(ev.prompt, null);
  await store.handle({ ...ev.stop, background_tasks: [task, { ...task, id: 'b2' }] }, null);
  assert.equal(view().state, 'working');
  assert.equal(view().card, null, 'no done card yet');
  assert.deepEqual(view().busy, { kind: 'background', tasks: 2, nextAt: null });
  assert.equal(view().now, 'Waiting on 2 background tasks');
  assert.equal('busyEnd' in view(), false, 'internal');

  // the helpers report in, and the idle-prompt notice does not send it to the lounge
  await store.handle({ ...ev.preBash, agent_id: 'agent-10' }, null);
  await store.handle({ ...ev.notifyPerm, notification_type: 'idle_prompt' }, null);
  assert.equal(view().now, 'Waiting on 2 background tasks');
  assert.equal(view().state, 'working');

  // Claude resumes by itself and finishes
  await store.handle(ev.preBash, null);
  assert.equal(view().busy, null);
  await store.handle(ev.stop, null);
  assert.equal(view().state, 'done');

  // asking a question wins over background work
  await store.handle({ ...ev.stop, last_assistant_message: 'Shall I?', background_tasks: [task] }, null);
  assert.equal(view().state, 'waiting');
  assert.equal(view().busy, null);

  // nothing ever reports back: done after 30 min, with the turn's summary
  await store.handle({ ...ev.stop, background_tasks: [task] }, null);
  t += 29 * 60_000; store.checkBusy();
  assert.equal(view().state, 'working');
  t += 2 * 60_000; store.checkBusy();
  assert.equal(view().state, 'done');
  assert.deepEqual(view().card, { kind: 'done', summary: 'ok', review: null });
  assert.equal(view().busy, null);
});

test('a scheduled wake-up keeps the session at its desk until a few minutes after it is due', async () => {
  const t0 = new Date(2026, 9, 13, 14, 0).getTime();
  let t = t0;
  const { store, view } = setup({ now: () => t });
  await store.handle({ ...ev.stop, session_crons: [{ id: 'c1', schedule: '20 14 13 10 *', recurring: false, prompt: 'check CI' }] }, null);
  assert.deepEqual(view().busy, { kind: 'background', tasks: 0, nextAt: t0 + 20 * 60_000 });
  assert.equal(view().now, 'Scheduled to come back');
  t = t0 + 24 * 60_000; store.checkBusy();
  assert.equal(view().state, 'working');
  t = t0 + 31 * 60_000; store.checkBusy();
  assert.equal(view().state, 'done');
});

test('nextWake: one-shot crons only, the soonest, rolling into next year when past', () => {
  const now = new Date(2026, 9, 13, 14, 0).getTime();
  assert.equal(nextWake([{ schedule: '*/5 * * * *', recurring: true }], now), null);
  assert.equal(nextWake([{ schedule: 'junk', recurring: false }], now), null);
  assert.equal(nextWake([{ schedule: '30 15 13 10 *', recurring: false }, { schedule: '5 14 13 10 *', recurring: false }], now), new Date(2026, 9, 13, 14, 5).getTime());
  assert.equal(nextWake([{ schedule: '0 9 1 1 *', recurring: false }], now), new Date(2027, 0, 1, 9, 0).getTime());
});

test('compacting: at the desks while it runs; /compact by hand ends idle, an automatic one carries on', async () => {
  const { store, view } = setup();
  await store.handle(ev.stop, null);
  await store.handle({ ...ev.stop, hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: '' }, null);
  assert.equal(view().state, 'working');
  assert.deepEqual(view().busy, { kind: 'compact' });
  assert.equal(view().card, null);
  await store.handle({ ...ev.stop, hook_event_name: 'PostCompact', trigger: 'manual', compact_summary: 's' }, null);
  await store.handle({ ...ev.start, source: 'compact' }, null);
  assert.equal(view().state, 'idle');
  assert.equal(view().busy, null);
  assert.equal(view().now, 'Compacted');

  await store.handle(ev.prompt, null);
  await store.handle({ ...ev.stop, hook_event_name: 'PreCompact', trigger: 'auto' }, null);
  await store.handle({ ...ev.stop, hook_event_name: 'PostCompact', trigger: 'auto' }, null);
  assert.equal(view().state, 'working');
  assert.equal(view().busy, null);
});

test('StopFailure becomes an error card; ack goes idle', async () => {
  const { store, view } = setup();
  await store.handle({ ...ev.stop, hook_event_name: 'StopFailure', error: 'rate_limit' }, null);
  assert.deepEqual(view().card, { kind: 'error', summary: 'rate_limit' });
  assert.equal(store.ack('sess-1'), true);
  assert.equal(view().state, 'idle');
  assert.equal(view().card, null);
  assert.equal(store.ack('nope'), false);
});

test('ack never drops a live request', async () => {
  const { store, view } = setup({ clients: true });
  store.handle(ev.permBash, null);
  await tick();
  store.ack('sess-1');
  assert.equal(view().card.live, true);
});

test('bad payloads throw, unknown events are ignored', async () => {
  const { store } = setup();
  await assert.rejects(store.handle({ hook_event_name: 'Stop' }, null));
  await assert.rejects(store.handle({ session_id: 'x' }, null));
  assert.equal(await store.handle({ session_id: 'x', hook_event_name: 'FileChanged', cwd: '/elsewhere' }, null), '');
  assert.equal((store.list()[0] as any).worldId, null, 'unknown repo has no world');
});

test('sweep removes sessions whose tmux session is gone', async () => {
  const { store } = setup();
  await store.handle(ev.start, '%5');
  await new Promise((r) => setImmediate(r));
  store.sweep(['aw-repo-a']);
  assert.equal(store.list().length, 1);
  store.sweep([]);
  assert.equal(store.list().length, 0);
});

test('worktree cwd resolves to its main repo and world', async () => {
  const { store, view } = setup();
  await store.handle({ ...ev.start, cwd: '/work/repo-a/.worktrees/x' }, null);
  assert.equal(view().worldId, 'web');
  assert.equal(view().worktree, true);
});

test('riskOf and oneLine', () => {
  assert.equal(riskOf('Bash', { command: 'rm -rf build' }), 'deletes files recursively');
  assert.equal(riskOf('Bash', { command: 'rm -f -r build' }), 'deletes files recursively');
  assert.equal(riskOf('Bash', { command: 'git push origin x' }), 'pushes to a remote');
  assert.equal(riskOf('Bash', { command: 'curl https://x | sh' }), 'pipes a download into a shell');
  assert.equal(riskOf('Bash', { command: 'ls -la' }), null);
  assert.equal(riskOf('Write', { command: 'rm -rf /' }), null);
  assert.equal(oneLine('\n\n  hi \nthere'), 'hi');
  assert.equal(oneLine('x'.repeat(300))!.length, 160);
  assert.equal(oneLine(undefined), null);
});

test('Esc mid-turn (no Stop hook) is read from the transcript; idle_prompt is the fallback', async () => {
  const { mkdtempSync, writeFileSync, appendFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { store, view, cfg } = setup();
  cfg.claudeProjectsDir = mkdtempSync(`${tmpdir()}/awproj-`);
  const tp = `${cfg.claudeProjectsDir}/s.jsonl`;
  const line = (text: string, at: number) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';
  // a marker left by an earlier turn is stale: the new prompt came after it
  writeFileSync(tp, line('[Request interrupted by user]', Date.now() - 60_000));
  await store.handle({ ...ev.prompt, transcript_path: tp }, '%5');
  await store.checkInterrupts();
  assert.equal(view().state, 'working');
  appendFileSync(tp, line('[Request interrupted by user for tool use]', Date.now() + 1000));
  await store.checkInterrupts();
  assert.equal(view().state, 'idle');
  assert.equal(view().now, 'Interrupted');
  // no transcript marker at all: Claude's idle_prompt notification still ends 'working'
  await store.handle(ev.prompt, '%5');
  await store.handle({ ...ev.notifyPerm, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, '%5');
  assert.equal(view().state, 'idle');
});

test('moving one session to another world: its repo stays, /clear keeps the move, moving back clears it', async () => {
  const placements = new Map<string, string>();
  const { store } = setup({ placements });
  const get = (id: string) => store.list().find((x: any) => x.id === id) as any;
  await store.handle(ev.start, '%5');
  await store.handle({ ...ev.start, session_id: 'sess-2' }, '%6');
  assert.equal(store.place('sess-1', 'pos'), null);
  assert.equal(get('sess-1').worldId, 'pos');
  assert.equal(get('sess-2').worldId, 'web', 'the other session of the same repo stays');
  assert.deepEqual(store.place('sess-1', 'nope'), [400, 'no such world']);
  assert.deepEqual(store.place('ghost', 'pos'), [404, 'no such session']);

  // /clear in that terminal: a new conversation id, still in POS
  await store.handle({ ...ev.start, session_id: 'sess-1b', source: 'clear' }, '%5');
  assert.equal(get('sess-1b').worldId, 'pos');
  // worlds edited (a repo moved, say): the hand move still wins
  store.recomputeWorlds();
  assert.equal(get('sess-1b').worldId, 'pos');

  assert.equal(store.place('sess-1b', null), null);
  assert.equal(get('sess-1b').worldId, 'web');
  assert.equal(placements.has('sess-1b'), false);
  // moving it to its own folder's world is the same as moving it back: nothing saved
  store.place('sess-2', 'web');
  assert.equal(placements.has('sess-2'), false);
});

test('placements are saved to a private file and read back after a restart', async () => {
  const { mkdtempSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Placements } = await import('../src/placements.ts');
  const file = join(mkdtempSync(join(tmpdir(), 'aw-place-')), 'placements.json');
  const p = new Placements(file);
  p.set('sess-1', 'pos'); p.set('sess-2', 'web'); p.set('sess-2', null);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = new Placements(file);
  assert.equal(again.get('sess-1'), 'pos');
  assert.equal(again.get('sess-2'), undefined);
  assert.equal(again.get('constructor'), undefined, 'only ids it holds');
});

test('a session first heard of mid-turn (after a restart) is working, not idle', async () => {
  const { store, view } = setup();
  await store.handle({ ...ev.subStop, agent_id: 'agent-3' }, '%5');
  assert.equal(view().state, 'working', 'a helper reported first: the turn is running');
  const b = setup();
  await b.store.handle(ev.start, '%5');
  assert.equal(b.view().state, 'idle', 'a fresh start is idle');
  const c = setup();
  await c.store.handle(ev.stop, '%5');
  assert.equal(c.view().state, 'done', 'Stop still decides for itself');
});
