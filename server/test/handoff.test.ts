import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHandoff } from '../src/handoff.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import type { Session } from '../src/store.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));

function fakeSession(over: Partial<Session>): Session {
  return {
    id: 'sess-1', agent: 'claude', repo: '/work/repo-a', branch: 'feat/x', worktree: false, cwd: '/work/repo-a',
    startedAt: 1760000000000, task: 'Add a filter', lastPrompt: null, log: [], transcriptPath: null, logPath: null,
    ...over,
  } as Session;
}

function gitRepo(): string {
  const dir = tmp();
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(join(dir, 'tracked.txt'), 'one\n');
  execFileSync('git', ['-C', dir, 'add', 'tracked.txt']);
  execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'start']);
  writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\n');
  writeFileSync(join(dir, 'new.txt'), 'new\n');
  return dir;
}

test('writeHandoff: task, steps and the working-tree state land in <home>/handoffs/<id>.md', async () => {
  const repo = gitRepo();
  const home = tmp();
  const file = await writeHandoff(fakeSession({
    repo, cwd: repo, task: 'Add a filter to the table',
    log: [{ t: 1760000001000, text: 'You: Add a filter' }, { t: 1760000002000, text: 'Edit: src/table.ts' }],
  }), home);
  assert.equal(file, join(home, 'handoffs', 'sess-1.md'));
  const md = readFileSync(file, 'utf8');
  assert.match(md, /# Handoff from Claude Code/);
  assert.match(md, /## Task\n\nAdd a filter to the table/);
  assert.match(md, /Edit: src\/table\.ts/);
  assert.match(md, /## Working tree/);
  assert.match(md, /M tracked\.txt/);
  assert.match(md, /\?\? new\.txt/);
  assert.match(md, /1 file changed, 1 insertion/);
});

test('writeHandoff: a non-git folder says so instead of failing', async () => {
  const dir = tmp();
  const md = readFileSync(await writeHandoff(fakeSession({ repo: dir, cwd: dir, branch: null }), tmp()), 'utf8');
  assert.match(md, /is not a git repo/);
});

test('writeHandoff: a Claude session includes an excerpt of its transcript', async () => {
  const dir = tmp();
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add a filter to the table' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I added the dropdown and wired it up.' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/repo-a/src/table.ts' } }] } }),
  ].join('\n'));
  const md = readFileSync(await writeHandoff(fakeSession({ transcriptPath: transcript }), tmp()), 'utf8');
  assert.match(md, /## Conversation/);
  assert.match(md, /USER: Add a filter to the table/);
  assert.match(md, /ASSISTANT: I added the dropdown and wired it up\./);
  assert.match(md, /TOOL Edit: \/work\/repo-a\/src\/table\.ts/);
});

test('writeHandoff: codex only names its transcript for the new agent to read', async () => {
  const md = readFileSync(await writeHandoff(fakeSession({ agent: 'codex', logPath: '/home/u/.codex/sessions/rollout-1.jsonl' }), tmp()), 'utf8');
  assert.match(md, /transcript is at \/home\/u\/\.codex\/sessions\/rollout-1\.jsonl\. Read the relevant parts yourself\./);
  assert.doesNotMatch(md, /## Conversation/);
});

test('writeHandoff: a found kimi wire log is named, a missing one points at the pattern', async () => {
  const home = tmp();
  const wire = join(home, 'kimi-home', 'sessions', 'wd_abc', 'session_k1', 'agents', 'main');
  execFileSync('mkdir', ['-p', wire]);
  writeFileSync(join(wire, 'wire.jsonl'), '{}\n');
  const found = readFileSync(await writeHandoff(fakeSession({ id: 'k1', agent: 'kimi' }), home), 'utf8');
  assert.match(found, new RegExp(`wire log is at ${join(wire, 'wire.jsonl').replace(/[/.]/g, '\\$&')}`));
  const missing = readFileSync(await writeHandoff(fakeSession({ id: 'k2', agent: 'kimi' }), home), 'utf8');
  assert.match(missing, /was not found; it lives under ~\/\.kimi-code\/sessions\/wd_\*\/session_k2\/agents\/main\/wire\.jsonl/);
  // Kimi's hooks name the session the way its folder is named: session_<uuid>, never session_session_<uuid>
  execFileSync('mkdir', ['-p', join(home, 'kimi-home', 'sessions', 'wd_abc', 'session_k3', 'agents', 'main')]);
  writeFileSync(join(home, 'kimi-home', 'sessions', 'wd_abc', 'session_k3', 'agents', 'main', 'wire.jsonl'), '{}\n');
  assert.match(readFileSync(await writeHandoff(fakeSession({ id: 'session_k3', agent: 'kimi' }), home), 'utf8'), /wire log is at .*session_k3\/agents\/main\/wire\.jsonl/);
});

test('writeHandoff: a very long session keeps its start and its end', async () => {
  const log = Array.from({ length: 20 }, (_, i) => ({ t: 1760000000000 + i, text: `step ${i}: ${'x'.repeat(2000)}` }));
  const md = readFileSync(await writeHandoff(fakeSession({ log }), tmp()), 'utf8');
  assert.match(md, /# Handoff from Claude Code/);
  assert.match(md, /\[\.\.\. middle omitted \.\.\.\]/);
  assert.match(md, /step 19/);
  assert.ok(md.length < 4096 + 12_288 + 200);
});

test('POST /api/sessions/:id/continue: 404/409/422, and a happy path in the same folder with the handoff as task', async () => {
  const home = tmp();
  const repo = gitRepo();
  const token = 'c'.repeat(64);
  const calls: any[] = [];
  const cfg = { ...parseConfig({}), port: 0 };
  const app = startServer(cfg, token, {
    home,
    createSession: async (o: any) => { calls.push(o); return { tmuxSession: 'aw-cont', dir: o.repo, branch: null }; },
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'feat/x', worktree: false, top: cwd }), branchOf: async () => 'feat/x', tmuxSessionOf: async () => null },
  });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const H = { 'x-aw-token': token, 'content-type': 'application/json' };
  const cont = (id: string, body: unknown) => fetch(`${base}/api/sessions/${id}/continue`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  try {
    // a kimi session, known to the store through its hooks
    await fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-agent': 'kimi' }, body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'k1', cwd: repo }) });
    assert.equal(app.store.sessions.get('k1')?.agent, 'kimi');

    assert.equal((await cont('nope', { agent: 'claude' })).status, 404);
    assert.equal((await cont('k1', { agent: 'gemini' })).status, 422);
    const same = await cont('k1', { agent: 'kimi' });
    assert.equal(same.status, 409);
    assert.match((await same.json() as any).error, /already runs Kimi Code/);

    const path = process.env.PATH;
    process.env.PATH = tmp(); // nothing installed
    try { assert.equal((await cont('k1', { agent: 'codex' })).status, 422, 'codex not on PATH'); }
    finally { process.env.PATH = path; }

    const r = await cont('k1', { agent: 'claude' });
    assert.equal(r.status, 201);
    const out = await r.json() as any;
    assert.equal(out.tmuxSession, 'aw-cont');
    assert.equal(out.handoff, join(home, 'handoffs', 'k1.md'));
    assert.ok(existsSync(out.handoff));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agent, 'claude');
    assert.equal(calls[0].repo, repo, 'same folder, no new worktree');
    assert.equal(calls[0].worktree, false);
    assert.equal(calls[0].task, `Read "${out.handoff}" and carry on from there.`);
    assert.ok(app.store.sessions.has('starting:aw-cont'));
    assert.match(readFileSync(out.handoff, 'utf8'), /# Handoff from Kimi Code/);

    // continuing a Claude session INTO kimi: the quoted handoff path is the task
    await fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'c1', cwd: repo }) });
    assert.equal(app.store.sessions.get('c1')?.agent, 'claude');
    const path2 = process.env.PATH;
    const bindir = tmp();
    writeFileSync(join(bindir, 'kimi'), '#!/bin/sh\n');
    chmodSync(join(bindir, 'kimi'), 0o755);
    process.env.PATH = `${bindir}:${path2}`;
    try {
      const r2 = await cont('c1', { agent: 'kimi' });
      assert.equal(r2.status, 201);
      const out2 = await r2.json() as any;
      assert.equal(calls.length, 2);
      assert.equal(calls[1].agent, 'kimi');
      assert.equal(calls[1].repo, repo);
      assert.equal(calls[1].task, `Read "${out2.handoff}" and carry on from there.`);
    } finally { process.env.PATH = path2; }
  } finally { await app.close(); }
});
