import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { history, scanClaude, projectDirName, findTranscript, newestTranscript } from '../src/history.ts';
import { startServer, spawnTmuxPty } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { createSession } from '../src/sys.ts';
import { awSessions, formatRows, pick } from '../src/cli.ts';
import { ev } from './fixtures.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));
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
    assert.deepEqual(calls[2], { repo, worktree: false, resume: b, claudeBin: 'claude', home: root, prefix: undefined });
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
