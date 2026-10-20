import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, utimesSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { history, inRepo, scanClaude, scanAgents, projectDirName, findTranscript, newestTranscript } from '../src/history.ts';
import { startServer, spawnTmuxPty } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { midTurn } from '../src/transcript.ts';
import { createSession, keptFlags } from '../src/sys.ts';
import { awSessions, formatRows, pick } from '../src/cli.ts';
import { ev, tmp } from './fixtures.ts';

const line = (o: unknown) => JSON.stringify(o) + '\n';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A projects dir shaped like ~/.claude/projects (fields as recorded from Claude Code 2.1.296, paths generic). */
function projects(root: string, repo: string) {
  const dir = join(root, 'projects');
  const p = join(dir, projectDirName(repo));
  mkdirSync(join(p, 'aaaaaaaa-1111-4111-8111-111111111111', 'subagents'), { recursive: true });
  const user = (sid: string, text: string, ts: string) => line({ isSidechain: false, type: 'user', timestamp: ts, userType: 'external', entrypoint: 'cli', cwd: repo, sessionId: sid, version: '2.1.296', gitBranch: 'main', message: { role: 'user', content: text } });
  const a = 'aaaaaaaa-1111-4111-8111-111111111111';
  const b = 'bbbbbbbb-2222-4222-8222-222222222222';
  writeFileSync(join(p, `${a}.jsonl`),
    line({ type: 'permission-mode', permissionMode: 'default', sessionId: a }) +
    user(a, 'first question', '2026-10-01T10:00:00.000Z') +
    line({ type: 'last-prompt', lastPrompt: 'first question', leafUuid: 'x', sessionId: a }) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }) +
    user(a, 'second question\nwith more lines', '2026-10-01T10:05:00.000Z') +
    line({ type: 'last-prompt', lastPrompt: 'second question\nwith more lines', leafUuid: 'y', sessionId: a }) +
    line({ type: 'ai-title', aiTitle: 'Questions', sessionId: a }) +
    user(a, 'third question, before its last-prompt line is written', '2026-10-01T10:06:00.000Z') +
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } }) +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } }));
  // older session whose tail has no cwd (long assistant output at the end)
  writeFileSync(join(p, `${b}.jsonl`),
    user(b, 'make a page', '2026-09-30T09:00:00.000Z') +
    line({ type: 'last-prompt', lastPrompt: 'make a page', sessionId: b }) +
    line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(80_000) }] } }));
  writeFileSync(join(p, 'aaaaaaaa-1111-4111-8111-111111111111', 'subagents', 'agent-1.jsonl'), user('sub', 'sidechain', '2026-10-01T11:00:00.000Z'));
  writeFileSync(join(p, 'agent-deadbeef.jsonl'), user('agent', 'sidechain', '2026-10-01T11:00:00.000Z'));
  writeFileSync(join(p, 'notes.txt'), 'not a transcript');
  utimesSync(join(p, `${b}.jsonl`), new Date('2026-09-30T09:00:00Z'), new Date('2026-09-30T09:00:00Z'));
  utimesSync(join(p, `${a}.jsonl`), new Date('2026-10-01T10:05:00Z'), new Date('2026-10-01T10:05:00Z'));
  return { dir, a, b };
}

test('history: newest first, last prompt one line, cwd from head when the tail lacks it, sidechains skipped', async () => {
  const root = tmp();
  const { dir, a, b } = projects(root, '/work/repo-a');
  const h = await history(dir, 50);
  assert.deepEqual(h.map((x) => x.sessionId), [a, b]);
  assert.deepEqual(h[0], { sessionId: a, cwd: '/work/repo-a', lastPrompt: 'third question, before its last-prompt line is written', lastActivity: Date.parse('2026-10-01T10:05:00Z') });
  assert.equal(h[1].cwd, '/work/repo-a');
  assert.equal(h[1].lastPrompt, 'make a page', 'from the head when the tail is one long reply');
  assert.equal((await history(dir, 1)).length, 1);
  assert.deepEqual(await history(join(root, 'missing'), 5), []);
  assert.equal(findTranscript(dir, a), join(dir, projectDirName('/work/repo-a'), `${a}.jsonl`));
  assert.equal(findTranscript(dir, '../etc/passwd'), null);
  assert.equal(newestTranscript(dir, '/work/repo-a'), a);
  assert.equal(projectDirName('/tmp/x.y/repo_a'), '-tmp-x-y-repo-a');
});

/** A fake /proc with one entry per process. */
function fakeProc(root: string, procs: { pid: number; argv: string[]; env: Record<string, string>; cwd: string }[]) {
  const proc = join(root, 'proc');
  for (const p of procs) {
    const d = join(proc, String(p.pid));
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'cmdline'), p.argv.join('\0') + '\0');
    writeFileSync(join(d, 'environ'), Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0');
    symlinkSync(p.cwd, join(d, 'cwd'));
  }
  mkdirSync(join(proc, 'self'), { recursive: true });
  return proc;
}

test('process scan: interactive claude only, session from --resume or newest transcript, tmux pane, marker', () => {
  const root = tmp();
  const repo = join(root, 'repo-a');
  mkdirSync(repo);
  const { dir, a } = projects(root, repo);
  const proc = fakeProc(root, [
    { pid: 101, argv: ['claude'], env: { TMUX_PANE: '%4' }, cwd: repo },
    { pid: 102, argv: ['/home/u/.local/bin/claude', '--resume', 'cccccccc-3333-4333-8333-333333333333', '--model', 'haiku'], env: { AGENT_WORLDS_HOME: '/h' }, cwd: repo },
    { pid: 103, argv: ['claude', '-p', '--model', 'haiku'], env: {}, cwd: repo },
    { pid: 104, argv: ['claude'], env: { AGENT_WORLDS_DISABLE: '1' }, cwd: repo },
    { pid: 105, argv: ['node', 'claude.js'], env: {}, cwd: repo },
    { pid: 106, argv: ['claude'], env: { TMUX_PANE: 'bogus' }, cwd: join(root) },
  ]);
  const got = scanClaude(proc, dir);
  assert.deepEqual(got.map((p) => [p.pid, p.sessionId, p.pane, p.managedHome]), [
    [101, a, '%4', null],
    [102, 'cccccccc-3333-4333-8333-333333333333', null, '/h'],
    [106, null, null, null],
  ]);
  assert.ok(got.every((p) => p.since > 0));
  assert.deepEqual(scanClaude(join(root, 'no-proc'), dir), [], 'no /proc (not Linux): nothing');
});

/**
 * Fake on-disk homes for the non-Claude agents, all naming sessions in `repo`:
 * Kimi's session folder (+wire log), Qwen's per-pid file, a Codex rollout, a Gemini chat, agy's history.
 */
function agentHomes(root: string, repo: string, pid: number) {
  const kimiId = 'session_11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const kimiDir = join(root, 'kimi-home', 'sessions', 'wd_x_1a2b3c4d5e6f', kimiId);
  mkdirSync(join(kimiDir, 'agents', 'main'), { recursive: true });
  writeFileSync(join(kimiDir, 'state.json'), JSON.stringify({ cwd: repo, updatedAt: 1000 }));
  writeFileSync(join(kimiDir, 'agents', 'main', 'wire.jsonl'), line({ type: 'turn.prompt', origin: { kind: 'user' }, input: [{ text: 'fix the tests' }] }));
  const qwenId = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const qwen = join(root, 'qwen');
  mkdirSync(join(qwen, 'sessions'), { recursive: true });
  writeFileSync(join(qwen, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: qwenId, cwd: repo }));
  const codexId = '33333333-cccc-4ccc-8ccc-cccccccccccc';
  const codex = join(root, 'codex');
  const rolloutDir = join(codex, 'sessions', '2026', '10', '20');
  mkdirSync(rolloutDir, { recursive: true });
  const rollout = join(rolloutDir, `rollout-2026-10-20T10-00-00-${codexId}.jsonl`);
  writeFileSync(rollout,
    line({ timestamp: '2026-10-20T10:00:00.000Z', type: 'session_meta', payload: { id: codexId, cwd: repo } }) +
    line({ timestamp: '2026-10-20T10:01:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'check the diff' } }) +
    line({ timestamp: '2026-10-20T10:01:01.000Z', type: 'event_msg', payload: { type: 'task_started' } }));
  const geminiId = '44444444-dddd-4ddd-8ddd-dddddddddddd';
  const gemini = join(root, 'gemini');
  const chatDir = join(gemini, 'tmp', 'repo-a', 'chats');
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(gemini, 'tmp', 'repo-a', '.project_root'), repo);
  writeFileSync(join(chatDir, 'session-2026-10-20T10-00-abc12345.json'), JSON.stringify({ sessionId: geminiId, messages: [{ type: 'user', content: 'build the page' }] }));
  const agyId = '55555555-eeee-4eee-8eee-eeeeeeeeeeee';
  const agy = join(root, 'agy');
  mkdirSync(agy, { recursive: true });
  writeFileSync(join(agy, 'history.jsonl'),
    line({ display: '/exit', workspace: repo, conversationId: agyId, type: 'slash_command' }) +
    line({ display: 'write the docs', workspace: repo, conversationId: agyId }));
  return { kimiId, kimiDir, qwenId, codexId, rollout, geminiId, agyId, homes: { qwen, codex, gemini, agy } };
}

test('process scan: codex, qwen, kimi, gemini and agy too, each session from its own files', () => {
  const root = tmp();
  const repo = join(root, 'repo-a');
  mkdirSync(repo);
  const { dir } = projects(root, repo);
  const f = agentHomes(root, repo, 402);
  const proc = fakeProc(root, [
    { pid: 401, argv: ['kimi-co'], env: { TMUX_PANE: '%21' }, cwd: repo },                                     // kimi renames its process
    { pid: 402, argv: ['node', '/home/u/.npm-global/bin/qwen', '-i', 'a task'], env: {}, cwd: repo },          // qwen runs as a node script
    { pid: 403, argv: ['/home/u/.local/bin/codex'], env: {}, cwd: repo },
    { pid: 404, argv: ['node', '/home/u/.npm-global/bin/gemini'], env: {}, cwd: repo },
    { pid: 405, argv: ['/home/u/.local/bin/agy'], env: {}, cwd: repo },
    { pid: 406, argv: ['kimi', '--session', 'session_99999999-ffff-4fff-8fff-ffffffffffff'], env: {}, cwd: repo }, // resumed: its flag names it
    { pid: 407, argv: ['kimi', '-p', 'one shot'], env: {}, cwd: repo },                                        // print mode: skipped
    { pid: 408, argv: ['codex', 'exec', 'one shot'], env: {}, cwd: repo },                                     // one-shot: skipped
    { pid: 409, argv: ['qwen'], env: { AGENT_WORLDS_DISABLE: '1' }, cwd: repo },                               // our own run: skipped
  ]);
  const got = scanAgents(proc, dir, { home: root, homes: f.homes });
  assert.deepEqual(got.map((p) => [p.pid, p.agent, p.sessionId]), [
    [401, 'kimi', f.kimiId],
    [402, 'qwen', f.qwenId],
    [403, 'codex', f.codexId],
    [404, 'gemini', f.geminiId],
    [405, 'agy', f.agyId],
    [406, 'kimi', 'session_99999999-ffff-4fff-8fff-ffffffffffff'],
  ]);
  assert.equal(got[0].log, f.kimiDir, 'kimi: its session folder, for the last prompt');
  assert.equal(got[2].log, f.rollout, 'codex: its rollout log, so turn checks keep working');
  assert.ok(got[3].log?.endsWith('.json'), 'gemini: its chat file');
  assert.equal(got[4].prompt, 'write the docs', 'agy: its last prompt from history.jsonl');
  assert.ok(scanClaude(proc, dir).every((p) => p.agent === 'claude'), 'scanClaude stays Claude-only');
});

test('server restart: sessions of every agent are taken back, with state and last prompt where the logs allow', async () => {
  const root = tmp();
  const repo = join(root, 'repo-a');
  mkdirSync(repo);
  const { dir } = projects(root, repo);
  const f = agentHomes(root, repo, 502);
  const proc = fakeProc(root, [
    { pid: 501, argv: ['kimi-co'], env: { AGENT_WORLDS_HOME: root, TMUX_PANE: '%21' }, cwd: repo },
    { pid: 502, argv: ['node', '/u/bin/qwen'], env: { AGENT_WORLDS_HOME: root, TMUX_PANE: '%22' }, cwd: repo },
    { pid: 503, argv: ['codex'], env: { AGENT_WORLDS_HOME: root, TMUX_PANE: '%23' }, cwd: repo },
    { pid: 504, argv: ['node', '/u/bin/gemini'], env: { AGENT_WORLDS_HOME: root, TMUX_PANE: '%24' }, cwd: repo },
    { pid: 505, argv: ['agy'], env: { AGENT_WORLDS_HOME: root, TMUX_PANE: '%25' }, cwd: repo },
    { pid: 506, argv: ['qwen'], env: { TMUX_PANE: '%26' }, cwd: repo }, // not ours: no qwen ghost either
  ]);
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [repo] }], claudeProjectsDir: dir }), port: 0 };
  const app = startServer(cfg, 'i'.repeat(64), {
    home: root, procRoot: proc, homes: f.homes,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-repo-a-1' },
  });
  await app.listen();
  try {
    await app.scan();
    const s = (id: string) => app.store.sessions.get(id)!;
    assert.equal(s(f.kimiId).agent, 'kimi');
    assert.equal(s(f.kimiId).lastPrompt, 'fix the tests');
    assert.equal(s(f.qwenId).agent, 'qwen');
    assert.equal(s(f.qwenId).state, 'idle', 'qwen has no readable turn state: idle');
    assert.equal(s(f.codexId).agent, 'codex');
    assert.equal(s(f.codexId).logPath, f.rollout, 'codex turn checks read the rollout again');
    assert.equal(s(f.codexId).lastPrompt, 'check the diff');
    assert.equal(s(f.codexId).state, 'working', 'the rollout ends on task_started: mid-turn');
    assert.equal(s(f.geminiId).agent, 'gemini');
    assert.equal(s(f.geminiId).lastPrompt, 'build the page');
    assert.equal(s(f.agyId).agent, 'agy');
    assert.equal(s(f.agyId).lastPrompt, 'write the docs');
    for (const id of [f.kimiId, f.qwenId, f.codexId, f.geminiId, f.agyId]) {
      assert.equal(s(id).now, 'Picked up again after a server restart');
      assert.equal(s(id).worldId, 'web');
    }
    assert.equal(app.store.sessions.size, 5, 'the qwen that is not ours stays invisible');
    const st = await (await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/state`, { headers: { 'x-aw-token': 'i'.repeat(64) } })).json() as any;
    assert.deepEqual(st.unmanaged, [], 'non-Claude agents never show as plain-terminal ghosts');
    await app.scan();
    assert.equal(app.store.sessions.size, 5, 'a second scan adopts nothing twice');
  } finally { await app.close(); }
});

test('server: unmanaged list, history flags, resume conflict / force / validation', async () => {
  const root = tmp();
  const repo = join(root, 'repo-a');
  mkdirSync(repo);
  const { dir, a, b } = projects(root, repo);
  const proc = fakeProc(root, [
    { pid: 201, argv: ['claude'], env: {}, cwd: repo },                     // unmanaged, guessed as session a
    { pid: 202, argv: ['claude'], env: { TMUX_PANE: '%7' }, cwd: root },    // managed: its pane belongs to a hook session
  ]);
  const calls: any[] = [];
  const stopped: number[] = [];
  let quits = false;
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [repo] }], claudeProjectsDir: dir }), port: 0 };
  const app = startServer(cfg, 'i'.repeat(64), {
    home: root, procRoot: proc,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => null },
    createSession: async (o) => { calls.push(o); return { tmuxSession: 'aw-repo-a-1', dir: o.repo, branch: null }; },
    stopProcess: async (pid) => { stopped.push(pid); return quits; },
  });
  await app.store.handle({ ...ev.start, session_id: 'managed-1', cwd: root }, '%7');
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const H = { 'x-aw-token': 'i'.repeat(64), 'content-type': 'application/json' };
  const get = async (p: string) => (await fetch(base + p, { headers: H })).json() as any;
  const post = async (p: string, b: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
  try {
    await app.scan();
    const st = await get('/api/state');
    assert.equal(st.unmanaged.length, 1);
    assert.deepEqual({ ...st.unmanaged[0], since: 0, lastActivity: 0 }, { pid: 201, cwd: repo, repo, worldId: 'web', sessionId: a, inTmux: false, since: 0, lastPrompt: st.unmanaged[0].lastPrompt, lastActivity: 0 });
    assert.equal(typeof st.unmanaged[0].lastActivity, 'number', 'when its transcript last changed');
    assert.ok(st.unmanaged[0].lastPrompt, 'what it was last asked');

    const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { 'x-aw-token': 'i'.repeat(64) } });
    const snap = await new Promise<any>((r) => ws.once('message', (m) => r(JSON.parse(m.toString()))));
    assert.equal(snap.unmanaged[0].pid, 201);
    ws.close();

    const h = (await get('/api/history?limit=10')).sessions;
    assert.deepEqual(h.map((x: any) => [x.sessionId, x.running, x.managed, x.worldId, x.repo]), [[a, true, false, 'web', repo], [b, false, false, 'web', repo]]);
    assert.equal((await get('/api/history?limit=1')).sessions.length, 1);

    assert.equal((await post('/api/sessions/resume', {})).status, 400);
    assert.equal((await post('/api/sessions/resume', { sessionId: '../../x' })).status, 400);
    assert.equal((await post('/api/sessions/resume', { sessionId: 'dddddddd-4444-4444-8444-444444444444' })).status, 404);
    assert.equal((await post('/api/sessions/resume', { sessionId: b, worldId: 'nope' })).status, 400);
    assert.equal((await post('/api/sessions/resume', { sessionId: b, worktree: true })).status, 400);
    const busy = await post('/api/sessions/resume', { sessionId: a });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.pid, 201);
    assert.equal(calls.length, 0);
    const stuck = await post('/api/sessions/resume', { sessionId: a, stop: true });
    assert.equal(stuck.status, 409, 'it would not quit: nothing resumed');
    assert.match(stuck.body.error, /did not quit \(pid 201\)/);
    assert.equal(calls.length, 0);
    quits = true;
    assert.equal((await post('/api/sessions/resume', { sessionId: a, stop: true })).status, 201, 'stopped, then resumed');
    assert.deepEqual(stopped, [201, 201]);
    const forced = await post('/api/sessions/resume', { sessionId: a, force: true });
    assert.equal(forced.status, 201);
    const ok = await post('/api/sessions/resume', { sessionId: b });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body, { tmuxSession: 'aw-repo-a-1' });
    assert.deepEqual({ ...calls[2], spawnDirect: undefined }, { spawnDirect: undefined, repo, worktree: false, resume: b, claudeBin: 'claude', home: root, prefix: undefined });
  } finally { await app.close(); }
});

test('a hook session outside tmux is view-only but its cards still work', async () => {
  const cfg = { ...parseConfig({}), port: 0 };
  const app = startServer(cfg, 'n'.repeat(64), {
    home: tmp(), procRoot: join(tmp(), 'none'),
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: null, worktree: false, top: cwd }), branchOf: async () => null, tmuxSessionOf: async () => null },
  });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const H = { 'x-aw-token': 'n'.repeat(64), 'content-type': 'application/json' };
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { 'x-aw-token': 'n'.repeat(64) } });
  await new Promise((r) => ws.once('open', r));
  try {
    const held = fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify(ev.permBash) }); // no X-AW-Pane
    let s: any;
    for (let i = 0; i < 40 && !s?.card; i++) { await sleep(25); s = ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).sessions[0]; }
    assert.equal(s.tmux, null);
    assert.equal(s.card.live, true);
    assert.equal((await fetch(`${base}/api/sessions/${s.id}/input`, { method: 'POST', headers: H, body: '{"text":"hi"}' })).status, 409);
    const pty = new WebSocket(`${base.replace('http', 'ws')}/pty?session=${s.id}`, { headers: { 'x-aw-token': 'n'.repeat(64) } });
    assert.match(await new Promise<string>((r) => pty.once('unexpected-response', (_q, res) => r(String(res.statusCode)))), /404/);
    assert.equal((await fetch(`${base}/api/sessions/${s.id}/permission`, { method: 'POST', headers: H, body: JSON.stringify({ requestId: s.card.requestId, decision: 'allow' }) })).status, 200);
    assert.equal(JSON.parse(await (await held).text()).hookSpecificOutput.decision.behavior, 'allow');
  } finally { ws.close(); await app.close(); }
});

test('our tmux sessions follow the latest client size (terminal + browser attached together)', async () => {
  const bin = join(tmp(), 'claude-stub');
  writeFileSync(bin, '#!/usr/bin/env bash\nsleep 60\n');
  chmodSync(bin, 0o755);
  const r = await createSession({ repo: tmp(), worktree: false, claudeBin: bin, prefix: 'awtest-' });
  const size = () => execFileSync('tmux', ['display-message', '-p', '-t', `=${r.tmuxSession}:`, '#{window_width}x#{window_height}']).toString().trim();
  const opt = (args: string[]) => execFileSync('tmux', args).toString().trim();
  const small = await spawnTmuxPty(r.tmuxSession, 80, 24);
  const big = await spawnTmuxPty(r.tmuxSession, 150, 40);
  try {
    assert.equal(opt(['show-options', '-w', '-v', '-t', `=${r.tmuxSession}:`, 'window-size']), 'latest');
    assert.equal(opt(['show-options', '-w', '-v', '-t', `=${r.tmuxSession}:`, 'aggressive-resize']), 'on');
    await sleep(500);
    big.write(' ');
    await sleep(400);
    assert.equal(size(), '150x39', 'the big client (latest) sets the size; one row is the status line');
    small.write(' ');
    await sleep(400);
    assert.equal(size(), '80x23', 'typing in the small client takes it over');
  } finally {
    small.kill(); big.kill();
    try { execFileSync('tmux', ['kill-session', '-t', '=' + r.tmuxSession]); } catch { /* gone */ }
  }
});

test('attach listing: our prefix only, number or name picks, server state when reachable', async () => {
  const bin = join(tmp(), 'claude-stub');
  writeFileSync(bin, '#!/usr/bin/env bash\nsleep 60\n');
  chmodSync(bin, 0o755);
  const repo = tmp();
  const r = await createSession({ repo, worktree: false, claudeBin: bin, prefix: 'awtest-ls-' });
  try {
    const rows = await awSessions('awtest-ls-', tmp());
    assert.deepEqual(rows.map((x) => [x.name, x.path, x.state]), [[r.tmuxSession, repo, null]]);
    assert.match(formatRows(rows), new RegExp(`^ 1  ${r.tmuxSession}\\s+-\\s+${repo.replace(/[/.]/g, '\\$&')}$`));
    assert.equal(pick('1', rows)?.name, r.tmuxSession);
    assert.equal(pick(` ${r.tmuxSession} `, rows)?.name, r.tmuxSession);
    assert.equal(pick('2', rows), null);
    assert.equal(pick('x', rows), null);
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', '=' + r.tmuxSession]); } catch { /* gone */ }
  }
});

test('server restart: our own sessions in tmux are taken back, not shown as ghosts', async () => {
  const root = tmp();
  const repo = join(root, 'repo-a');
  mkdirSync(repo);
  const { dir, a, b } = projects(root, repo);
  const proc = fakeProc(root, [
    { pid: 301, argv: ['claude', '--resume', a], env: { AGENT_WORLDS_HOME: root, TMUX_PANE: '%9' }, cwd: repo }, // ours
    { pid: 302, argv: ['claude', '--resume', b], env: { TMUX_PANE: '%10' }, cwd: repo },                          // someone's own tmux
  ]);
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [repo] }], claudeProjectsDir: dir }), port: 0 };
  const app = startServer(cfg, 'i'.repeat(64), {
    home: root, procRoot: proc,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-repo-a-1' },
  });
  await app.listen();
  try {
    await app.scan();
    const s = app.store.sessions.get(a)!;
    assert.ok(s, 'taken back');
    assert.equal(s.tmux?.pane, '%9');
    assert.equal(s.worldId, 'web');
    assert.ok(s.transcriptPath, 'catch-up and scroll back work again');
    assert.ok(s.lastPrompt, 'shows what it was last asked');
    assert.equal(s.state, 'working', 'its transcript ends on a tool result: still mid-turn');
    assert.equal(app.store.sessions.has(b), false, 'not ours: stays a ghost');
    const st = await (await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/state`, { headers: { 'x-aw-token': 'i'.repeat(64) } })).json() as any;
    assert.deepEqual(st.unmanaged.map((u: any) => u.pid), [302]);
  } finally { await app.close(); }
});

test('midTurn: an unanswered prompt or tool result, or a running tool call, is mid-turn; an answer or Esc is not', () => {
  const u = (content: unknown, extra = {}) => ({ type: 'user', ...extra, message: { role: 'user', content } });
  const a = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });
  const tail = { type: 'last-prompt', lastPrompt: 'x' };
  assert.equal(midTurn([u('run the tests'), tail]), true);
  assert.equal(midTurn([u('run'), a([{ type: 'tool_use', name: 'Bash', input: {} }])]), true, 'a long Bash still running');
  assert.equal(midTurn([a([{ type: 'tool_use' }]), u([{ type: 'tool_result', content: 'ok' }])]), true);
  assert.equal(midTurn([u('run'), a([{ type: 'text', text: 'Done.' }]), tail]), false);
  assert.equal(midTurn([a([{ type: 'tool_use' }]), u([{ type: 'text', text: '[Request interrupted by user for tool use]' }])]), false);
  assert.equal(midTurn([u('<local-command-stdout></local-command-stdout>')]), false);
  assert.equal(midTurn([u('<command-name>/ship-check</command-name>'), u('Base directory for this skill: …', { isMeta: true })]), true, 'a skill just started');
  assert.equal(midTurn([u('<local-command-caveat>Caveat…</local-command-caveat>', { isMeta: true })]), false);
  assert.equal(midTurn([u('go'), a([{ type: 'thinking', thinking: '' }])]), true, 'still thinking');
  assert.equal(midTurn([]), false);
});

test('history for one repo: its folder, folders inside it and its worktrees; not a look-alike repo', async () => {
  const dir = join(tmp(), 'projects');
  const put = (cwd: string, id: string, mtime: number) => {
    const p = join(dir, projectDirName(cwd));
    mkdirSync(p, { recursive: true });
    const f = join(p, `${id}.jsonl`);
    writeFileSync(f, line({ type: 'user', cwd, sessionId: id, message: { role: 'user', content: `in ${cwd}` } }));
    utimesSync(f, mtime, mtime);
  };
  put('/r/oreem', 'aaaaaaaa-0001', 1000);
  put('/r/oreem/worktrees/aw-x', 'aaaaaaaa-0002', 3000);
  put('/r/oreem-worktrees/feat', 'aaaaaaaa-0003', 2000);
  put('/r/oreem-admin', 'aaaaaaaa-0004', 4000);
  put('/r/other', 'aaaaaaaa-0005', 5000);
  assert.deepEqual((await history(dir, 10, '/r/oreem')).map((h) => h.cwd), ['/r/oreem/worktrees/aw-x', '/r/oreem-worktrees/feat', '/r/oreem']);
  assert.deepEqual((await history(dir, 2, '/r/oreem')).map((h) => h.sessionId), ['aaaaaaaa-0002', 'aaaaaaaa-0003']);
  assert.equal((await history(dir, 10)).length, 5);
  assert.equal(inRepo('/r/oreem-admin', '/r/oreem'), false);
});

test('keptFlags keeps settings, permission mode and model, never the first prompt or session', () => {
  assert.deepEqual(keptFlags(['claude', '--resume', 'x', '--permission-mode', 'auto', '--settings=/h/hooks.json', '--model', 'opus', '--', 'Fix the bug']),
    ['--permission-mode', 'auto', '--settings=/h/hooks.json', '--model', 'opus']);
  assert.deepEqual(keptFlags(['claude', '--dangerously-skip-permissions', 'do it']), ['--dangerously-skip-permissions']);
  assert.deepEqual(keptFlags(['claude', '--settings', '/h/hooks.json', '--mcp-config', '/h/claude-mcp.json', '--', 'x']),
    ['--settings', '/h/hooks.json', '--mcp-config', '/h/claude-mcp.json'], 'a restarted session keeps the mailbox');
});

test('restart: resumes the same session in its pane with its own flags; asks before cutting a turn short', async () => {
  const root = tmp();
  const proc = fakeProc(root, [
    { pid: 301, argv: ['/bin/claude', '--permission-mode', 'auto', '--settings', '/h/hooks.json', '--', 'Fix the bug'], env: { TMUX_PANE: '%9', AGENT_WORLDS_HOME: '/h' }, cwd: root },
    { pid: 302, argv: ['/bin/claude'], env: { TMUX_PANE: '%8' }, cwd: root }, // someone ran claude in the Codex session's pane
  ]);
  const calls: unknown[][] = [];
  const cfg = { ...parseConfig({}), port: 0 };
  const app = startServer(cfg, 'i'.repeat(64), {
    home: root, procRoot: proc,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' },
    restartClaude: async (...a) => { calls.push(a); return null; },
  });
  await app.store.handle({ ...ev.start, session_id: 's-9', cwd: root }, '%9');
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = async (b: unknown) => { const r = await fetch(`${base}/api/sessions/s-9/restart`, { method: 'POST', headers: { 'x-aw-token': 'i'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
  try {
    await app.store.handle({ ...ev.prompt, session_id: 's-9', cwd: root }, '%9');
    const busy = await post({});
    assert.equal(busy.status, 409);
    assert.equal(busy.body.working, true);
    assert.equal(calls.length, 0, 'nothing restarted without a yes');
    assert.equal((await post({ force: true })).status, 200);
    assert.deepEqual(calls, [['%9', 's-9', root, ['/bin/claude', '--permission-mode', 'auto', '--settings', '/h/hooks.json', '--', 'Fix the bug'], '/h']]);
    // Codex and Qwen have no `--resume <id>` restart: refused, never respawned as claude
    await app.store.handle({ ...ev.start, session_id: 'cx-9', cwd: root }, '%8', undefined, null, 'codex');
    const cx = await fetch(`${base}/api/sessions/cx-9/restart`, { method: 'POST', headers: { 'x-aw-token': 'i'.repeat(64), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cx.status, 409);
    assert.equal(calls.length, 1);
  } finally { await app.close(); }
});

test('kimi: recent sessions list Kimi sessions with their last prompt; resume starts kimi --session in their folder', async () => {
  const root = tmp();
  const repo = join(root, 'repo-k');
  mkdirSync(repo);
  const id = 'session_dfcc5aab-c009-48c6-98c6-92c3f528d709';
  // Agent Worlds' Kimi home (its sessions folder is yours, linked)
  const sdir = join(root, 'kimi-home', 'sessions', 'wd_repo-k_abc', id);
  mkdirSync(join(sdir, 'agents', 'main'), { recursive: true });
  writeFileSync(join(sdir, 'state.json'), JSON.stringify({ id, cwd: repo, updatedAt: Date.now(), archived: false }));
  writeFileSync(join(sdir, 'agents', 'main', 'wire.jsonl'), [
    { type: 'turn.prompt', input: [{ type: 'text', text: 'walk the personas' }], origin: { kind: 'user' } },
    { type: 'turn.prompt', input: [{ type: 'text', text: 'mail notice' }], origin: { kind: 'system' } },
    { type: 'agent.message.appended' },
  ].map(line).join(''));
  const old = join(root, 'kimi-home', 'sessions', 'wd_repo-k_abc', 'session_aaaaaaaa-0000-4000-8000-000000000000');
  mkdirSync(old);
  writeFileSync(join(old, 'state.json'), JSON.stringify({ cwd: repo, updatedAt: 1, archived: true }));
  const calls: any[] = [];
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [repo] }], claudeProjectsDir: join(root, 'none') }), port: 0 };
  const app = startServer(cfg, 'i'.repeat(64), {
    home: root,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => null },
    createSession: async (o) => { calls.push(o); return { tmuxSession: 'aw-repo-k-1', dir: o.repo, branch: null, pane: '%40' }; },
  });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const H = { 'x-aw-token': 'i'.repeat(64), 'content-type': 'application/json' };
  const resume = async (b: object) => { const r = await fetch(`${base}/api/sessions/resume`, { method: 'POST', headers: H, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
  try {
    const items = ((await (await fetch(`${base}/api/history?repo=${encodeURIComponent(repo)}`, { headers: H })).json()) as any).sessions;
    assert.deepEqual(items.map((h: any) => [h.sessionId, h.agent, h.lastPrompt, h.worldId]), [[id, 'kimi', 'walk the personas', 'web']], 'archived sessions are left out');
    assert.equal((await resume({ sessionId: id, agent: 'cursor' })).status, 400);
    assert.equal((await resume({ sessionId: id, agent: 'kimi', permissionMode: 'plan' })).status, 400, 'modes are Claude-only');
    assert.equal((await resume({ sessionId: 'session_nope0000', agent: 'kimi' })).status, 404);
    assert.equal((await resume({ sessionId: id, agent: 'kimi' })).status, 201);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent, 'kimi');
    assert.equal(calls[0].resume, id);
    assert.equal(calls[0].repo, repo);
    assert.equal(app.store.sessions.get('starting:aw-repo-k-1')?.agent, 'kimi', 'its starting card is a Kimi one');
    await app.store.handle({ hook_event_name: 'SessionStart', session_id: id, cwd: repo }, '%40', undefined, null, 'kimi');
    assert.equal((await resume({ sessionId: id, agent: 'kimi' })).status, 409, 'already running here');
  } finally { await app.close(); }
});

test('end: closes the pane after a yes mid-turn, and drops the card; label: names it on its tag, kept across a restart', async () => {
  const root = tmp();
  const ended: string[] = [];
  const cfg = { ...parseConfig({}), port: 0 };
  const opts = {
    home: root,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' },
    endPane: async (pane: string) => { ended.push(pane); return null; },
  };
  let app = startServer(cfg, 'i'.repeat(64), opts);
  await app.store.handle({ ...ev.start, session_id: 's-7', cwd: root }, '%7');
  await app.listen();
  let base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const post = async (path: string, b: unknown) => { const r = await fetch(`${base}/api/sessions/${path}`, { method: 'POST', headers: { 'x-aw-token': 'i'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.json() as any }; };
  try {
    assert.equal((await post('s-7/label', { label: 'x'.repeat(41) })).status, 400);
    assert.equal((await post('s-7/label', { label: 42 })).status, 400);
    assert.equal((await post('s-7/label', { label: '  CSV export  ' })).status, 200);
    assert.equal(app.store.sessions.get('s-7')!.label, 'CSV export');
    await app.close();
    app = startServer(cfg, 'i'.repeat(64), opts); // a new server start: the label comes back with the session
    await app.store.handle({ ...ev.start, session_id: 's-7', cwd: root }, '%7');
    await app.listen();
    base = `http://127.0.0.1:${(app.server.address() as any).port}`;
    assert.equal(app.store.sessions.get('s-7')!.label, 'CSV export');
    assert.equal((await post('s-7/label', { label: ' ' })).status, 200);
    assert.equal(app.store.sessions.get('s-7')!.label, null, 'blank: back to the repo name');

    await app.store.handle({ ...ev.prompt, session_id: 's-7', cwd: root }, '%7');
    const busy = await post('s-7/end', {});
    assert.equal(busy.status, 409);
    assert.equal(busy.body.working, true);
    assert.deepEqual(ended, [], 'nothing ended without a yes');
    assert.equal((await post('s-7/end', { force: true })).status, 200);
    assert.deepEqual(ended, ['%7']);
    assert.equal(app.store.sessions.has('s-7'), false, 'the card is gone');
    assert.equal((await post('s-7/end', {})).status, 404);
  } finally { await app.close(); }
});
