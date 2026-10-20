import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, riskOf, oneLine, nextWake } from '../src/store.ts';
import { parseConfig } from '../src/config.ts';
import { ev, QUESTION, tmp } from './fixtures.ts';

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
  await store.handle({ ...ev.preAgent, tool_input: { ...ev.preAgent.tool_input, run_in_background: true } }, null);
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

test('only background work started since your prompt keeps a session at its desk', async () => {
  const { store, view } = setup();
  const server = { id: 'byqi1f1o8', type: 'shell', status: 'running', description: 'Serve the APK folder on port 8090 for the phone' };
  const watcher = { id: 'sa0lfcrfr', type: 'monitor', status: 'running', description: 'live updates for artifact' };
  // a long-runner from an earlier turn (or a finished helper Claude Code still lists): the turn is done and needs you
  await store.handle(ev.prompt, null);
  await store.handle({ ...ev.stop, background_tasks: [server, watcher] }, null);
  assert.equal(view().state, 'done');
  assert.equal(view().busy, null);
  // a helper sent off this turn (it reports async) brings Claude back
  await store.handle(ev.prompt, null);
  await store.handle(ev.preAgent, null);
  await store.handle({ ...ev.postAgent, tool_response: { isAsync: true, status: 'async_launched' } }, null);
  const agent = { id: 'a731c59366f2c0b1a', type: 'subagent', status: 'running', description: 'Find callers of foo' };
  await store.handle({ ...ev.stop, background_tasks: [server, watcher, agent] }, null);
  assert.equal(view().state, 'working');
  assert.equal(view().now, 'Waiting on 3 background tasks');
  // so does a background command, but a new prompt starts the count again
  await store.handle(ev.prompt, null);
  await store.handle({ ...ev.preBash, tool_input: { command: 'npm test', run_in_background: true } }, null);
  await store.handle({ ...ev.stop, background_tasks: [server] }, null);
  assert.equal(view().state, 'working');
  await store.handle(ev.prompt, null);
  await store.handle({ ...ev.stop, background_tasks: [server] }, null);
  assert.equal(view().state, 'done');
  assert.equal('launched' in view(), false, 'internal');
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

test('a helper backgrounded mid-run keeps the session working through idle_prompt', async () => {
  const { store, view } = setup();
  await store.handle(ev.prompt, '%5');
  await store.handle(ev.preAgent, '%5');
  await store.handle({ ...ev.postAgent, tool_response: { isAsync: true, status: 'async_launched' } }, '%5');
  assert.equal(view().helpers[0].state, 'working');
  await store.handle({ ...ev.notifyPerm, notification_type: 'idle_prompt' }, '%5');
  assert.equal(view().state, 'working', 'still waiting on its helper, not in the lounge');
  await store.handle(ev.subStop, '%5');
  await store.handle({ ...ev.notifyPerm, notification_type: 'idle_prompt' }, '%5');
  assert.equal(view().state, 'idle');
});

test('Esc mid-turn (no Stop hook) is read from the transcript; idle_prompt is the fallback', async () => {
  const { writeFileSync, appendFileSync } = await import('node:fs');
  const { store, view, cfg } = setup();
  cfg.claudeProjectsDir = tmp('awproj-');
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
  // as written in real transcripts: other lines follow the marker, and a hook (an interrupted tool's failure) may come after it
  await store.handle({ ...ev.prompt, transcript_path: tp }, '%5');
  appendFileSync(tp, JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() + 1500).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Working on it' }] } }) + '\n');
  await store.checkInterrupts();
  assert.equal(view().state, 'working', 'a reply after the old marker: still at work');
  appendFileSync(tp, line('[Request interrupted by user]', Date.now())
    + JSON.stringify({ type: 'system', subtype: 'informational' }) + '\n' + JSON.stringify({ type: 'last-prompt', lastPrompt: 'x' }) + '\n'
    + JSON.stringify({ type: 'file-history-snapshot' }) + '\n' + line('<task-notification>a helper finished</task-notification>', Date.now() + 2500));
  await new Promise((r) => setTimeout(r, 5)); // the hook lands after the marker was written
  await store.handle({ ...ev.prompt, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: {}, transcript_path: tp }, '%5');
  await store.checkInterrupts();
  assert.equal(view().state, 'idle', 'interrupted, whatever follows the marker');
  // no transcript marker at all: Claude's idle_prompt notification still ends 'working'
  await store.handle(ev.prompt, '%5');
  await store.handle({ ...ev.notifyPerm, notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, '%5');
  assert.equal(view().state, 'idle');
});

test('a Codex turn that ends without a hook is read from its rollout log', async () => {
  const { writeFileSync, appendFileSync } = await import('node:fs');
  let t = Date.parse('2026-10-18T10:00:00Z');
  const { store, view } = setup({ now: () => t });
  const log = `${tmp('awcodex-')}/rollout.jsonl`;
  const entry = (payload: object, at: number) => JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload }) + '\n';
  const prompt = async () => { await store.handle({ ...ev.prompt, transcript_path: log }, '%5', undefined, null, 'codex'); };
  // an earlier turn's ending is stale: the new prompt came after it
  writeFileSync(log, entry({ type: 'task_complete', last_agent_message: 'old' }, t - 60_000));
  await prompt();
  t += 10_000;
  await store.checkInterrupts();
  assert.equal(view().state, 'working');
  // a long tool run: started, quiet, still running
  appendFileSync(log, entry({ type: 'task_started' }, t));
  t += 60_000;
  await store.checkInterrupts();
  assert.equal(view().state, 'working');
  // a usage limit: task_complete carries the error, and no Stop ever comes
  appendFileSync(log, entry({ type: 'task_complete', last_agent_message: null, error: { message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' } }, t));
  await store.checkInterrupts();
  assert.equal(view().state, 'working', 'its Stop hook gets a moment first');
  t += 6_000;
  await store.checkInterrupts();
  assert.equal(view().state, 'error');
  assert.deepEqual(view().card, { kind: 'error', summary: "You've hit your usage limit." });
  // Esc: turn_aborted sends it to the lounge, not to an error card
  await prompt();
  appendFileSync(log, entry({ type: 'task_started' }, t) + entry({ type: 'turn_aborted', reason: 'interrupted' }, t + 1000));
  t += 7_000;
  await store.checkInterrupts();
  assert.equal(view().state, 'idle');
  assert.equal(view().now, 'Interrupted');
  // a finished turn whose Stop never arrived
  await prompt();
  appendFileSync(log, entry({ type: 'task_started' }, t) + entry({ type: 'task_complete', last_agent_message: 'All set.' }, t + 1000));
  t += 7_000;
  await store.checkInterrupts();
  assert.equal(view().state, 'done');
  assert.equal(view().card.summary, 'All set.');
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
  const { statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { Placements } = await import('../src/placements.ts');
  const file = join(tmp('aw-place-'), 'placements.json');
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

test('a Kimi session: block prompts, terminal-only permission cards, Esc back to idle', async () => {
  const { store, view } = setup({ clients: true });
  // Recorded from Kimi Code 2.1.1 (ids and paths genericised); no transcript_path.
  const km = { session_id: 'session_k1', cwd: '/work/repo-a', client_type: 'kimi_code_cli' };
  await store.handle({ ...km, hook_event_name: 'SessionStart', source: 'startup', model: 'kimi-code/k3', profile: 'agent' }, null, undefined, null, 'kimi');
  await store.handle({ ...km, hook_event_name: 'UserPromptSubmit', prompt: [{ type: 'text', text: 'touch a file' }], is_steer: false }, null, undefined, null, 'kimi');
  assert.equal(view().agent, 'kimi');
  assert.equal(view().task, 'touch a file', 'the prompt comes as content blocks');
  // Kimi does not wait on this hook, so it is answered at once and the card says to use the terminal
  const reply = store.handle({ ...km, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'touch a' } }, null, undefined, null, 'kimi');
  await tick();
  assert.equal(view().state, 'waiting');
  assert.equal(view().card.live, false);
  assert.equal(await reply, '{}');
  await store.handle({ ...km, hook_event_name: 'Interrupt', turn_id: 0, reason: 'cancelled' }, null, undefined, null, 'kimi');
  assert.equal(view().state, 'idle');
  assert.equal(view().card, null);
});

test('a Codex session is tagged codex and can only be allowed once from the inbox', async () => {
  const { store, view } = setup({ clients: true });
  // Recorded from Codex 0.156.1 (ids and paths genericised); Codex sends model on every event.
  const cx = { session_id: 'cx-1', transcript_path: '/home/u/.codex/sessions/2026/10/14/rollout-x-cx-1.jsonl', cwd: '/work/repo-a', model: 'gpt-5.6-terra', permission_mode: 'default' };
  await store.handle({ ...cx, hook_event_name: 'SessionStart', source: 'startup' }, null, undefined, null, 'codex');
  await store.handle({ ...cx, hook_event_name: 'UserPromptSubmit', turn_id: 't1', prompt: 'touch a file' }, null, undefined, null, 'codex');
  assert.equal(view().agent, 'codex');
  assert.equal(view().state, 'working');
  const held = store.handle({ ...cx, hook_event_name: 'PermissionRequest', turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'touch a', description: null } }, null, undefined, null, 'codex');
  await tick();
  const { requestId } = view().card;
  assert.match(store.decide('cx-1', { requestId, decision: 'allow', scope: 'repo' })?.[1] ?? '', /only be allowed once/);
  assert.equal(store.decide('cx-1', { requestId, decision: 'allow' }), null);
  assert.deepEqual(JSON.parse(await held), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
});
