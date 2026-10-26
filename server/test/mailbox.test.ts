import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { Mailbox, PING_PONG } from '../src/mailbox.ts';
import { ev, tmp } from './fixtures.ts';

const TOKEN = 'b'.repeat(64);
const typed: [string, string][] = [];
let typeOk = true;
let app: ReturnType<typeof startServer>;
let base = '';
const home = tmp('aw-mail-home-');

before(async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'], leadSpawn: true }] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    home,
    createSession: (async (o: any) => ({ tmuxSession: 'awtest-mail-new', dir: o.repo, branch: null, pane: '%9' })) as any,
    typeInto: async (pane, text) => { typed.push([pane, text]); return typeOk; },
  });
  await app.listen();
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
after(() => app.close());

const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
const A = 'aaaa1111-0000', B = 'bbbb2222-0000';
const hook = (body: object, id: string, pane: string) => fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id }) });
let rpcId = 0;
const rpc = async (pane: string, method: string, params?: object) =>
  (await (await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) })).json()) as any;
const tool = async (pane: string, name: string, args: object = {}) => (await rpc(pane, 'tools/call', { name, arguments: args })).result;

test('Mailbox: read once, a long exchange with no human prompt is refused, a prompt resets it', () => {
  const box = new Mailbox();
  for (let i = 0; i < PING_PONG; i++) assert.equal(typeof box.send(i % 2 ? 'a' : 'b', i % 2 ? 'b' : 'a', `m${i}`), 'object');
  assert.match(box.send('a', 'b', 'one more') as string, /ask the user/);
  assert.equal(typeof box.send('a', 'c', 'another pair is fine'), 'object');
  box.prompted('b');
  assert.equal(typeof box.send('a', 'b', 'after a prompt'), 'object');
  assert.equal(box.take('b').length, PING_PONG / 2 + 1);
  assert.deepEqual(box.take('b'), []);
  assert.deepEqual([...box.waiting()].sort(), ['a', 'c']);
  box.forget('a');
  assert.deepEqual([...box.waiting()], ['c']);
});

test('/mcp: sessions find each other, mail waits until the recipient is free, then it is told once', async () => {
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/mcp`, { headers: H })).status, 405);
  const init = await rpc('%1', 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: H, body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' })).status, 202);
  assert.deepEqual((await rpc('%1', 'tools/list')).result.tools.map((t: any) => t.name), ['aw_agents', 'aw_send', 'aw_inbox', 'aw_handoff', 'aw_spawn', 'aw_stop']);
  assert.equal((await rpc('%1', 'resources/list')).error.code, -32601);
  assert.equal((await tool('%1', 'aw_agents')).isError, true, 'no session in that pane yet');
  await rpc('%5', 'initialize', {}); // a CLI whose MCP handshake beats its first hook
  await hook(ev.start, 'eeee5555-0000', '%5');

  await hook(ev.start, A, '%1');
  await hook(ev.start, B, '%2');
  await hook(ev.start, 'cccc3333-0000', '%3'); // a plain `claude` reporting through global hooks: no mailbox tools
  await rpc('%2', 'initialize', {}); // B's CLI connected to the mailbox
  await hook(ev.prompt, B, '%2'); // B is mid-turn
  const peers = JSON.parse((await tool('%1', 'aw_agents')).content[0].text);
  assert.deepEqual(peers[0], { ...peers[0], id: A, you: true }, 'the caller comes first, marked you');
  assert.deepEqual(peers.slice(1).map((p: any) => p.id).sort(), [B, 'eeee5555-0000'], 'only sessions that reached the mailbox, early ones too');
  assert.match((await tool('%1', 'aw_send', { to: 'cccc', text: 'x' })).content[0].text, /no session "cccc"/);
  assert.match((await tool('%1', 'aw_send', { to: 'nope', text: 'x' })).content[0].text, /no session "nope"/);
  assert.match((await tool('%1', 'aw_send', { to: 'bbbb', text: 'step 3 misses the auth check' })).content[0].text, /busy now/);
  await app.deliverMail();
  assert.deepEqual(typed, [], 'not typed into a session mid-turn');

  await hook(ev.stop, B, '%2'); // B's turn ends
  await app.deliverMail();
  assert.equal(typed.length, 1);
  assert.equal(typed[0][0], '%2');
  assert.match(typed[0][1], /^\[Agent Worlds\] A new message from Claude Code aaaa1111: call the aw_inbox tool/);
  assert.doesNotMatch(typed[0][1], /repo|main/, 'no repo or branch name is typed into the terminal');
  await app.deliverMail();
  assert.equal(typed.length, 1, 'told once');

  assert.match((await tool('%2', 'aw_inbox')).content[0].text, /From Claude Code aaaa1111[^\n]*\nstep 3 misses the auth check/);
  assert.equal((await tool('%2', 'aw_inbox')).content[0].text, 'No new messages.');
  const state = (await (await fetch(`${base}/api/state`, { headers: H })).json()) as any;
  assert.ok(state.sessions.find((s: any) => s.id === B).log.some((l: any) => l.text.startsWith('Message from Claude Code aaaa1111')));
});

test('/mcp: our own mail notice is not a human prompt, so it does not reset a long exchange', async () => {
  for (let i = 1; i < PING_PONG; i++) await tool(i % 2 ? '%2' : '%1', 'aw_send', { to: i % 2 ? 'aaaa' : 'bbbb', text: `m${i}` });
  await hook({ ...ev.prompt, prompt: '[Agent Worlds] A new message from …' }, A, '%1');
  assert.equal((await tool('%1', 'aw_send', { to: 'bbbb', text: 'again' })).isError, true);
  await hook({ ...ev.prompt, prompt: 'keep going, you two' }, A, '%1');
  assert.equal((await tool('%1', 'aw_send', { to: 'bbbb', text: 'again' })).isError, undefined);
});

test('/mcp: a session at its prompt with background work or a wake-up still pending is told at once', async () => {
  const D = 'dddd4444-0000', E = 'eeee6666-0000', F = 'ffff7777-0000';
  await hook(ev.start, D, '%6');
  for (const [id, pane] of [[E, '%7'], [F, '%8']]) { await hook(ev.start, id, pane); await rpc(pane, 'initialize', {}); await hook(ev.prompt, id, pane); }
  const task = { id: 'b1', type: 'subagent', status: 'running', description: 'Trace the bug', agent_type: 'Explore' };
  await hook({ ...ev.preAgent, tool_input: { ...ev.preAgent.tool_input, run_in_background: true } }, E, '%7');
  await hook({ ...ev.stop, background_tasks: [task] }, E, '%7'); // E's turn ended, its helper runs on
  await hook({ ...ev.stop, session_crons: [{ id: 'c1', schedule: '*/10 * * * *', recurring: true, prompt: 'check CI' }] }, F, '%8'); // F is on /loop
  typed.length = 0;
  for (const [to, pane] of [['eeee6666', '%7'], ['ffff', '%8']]) {
    assert.match((await tool('%6', 'aw_send', { to, text: 'your review is ready' })).content[0].text, /being told now/);
    await app.deliverMail();
    assert.equal(typed.at(-1)?.[0], pane, `${to} is told while it waits at its prompt`);
  }
  assert.deepEqual(typed.map(([p]) => p).filter((p) => p === '%7' || p === '%8'), ['%7', '%8'], 'each told once');
});

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../bin');
const bridge = (env: Record<string, string>, stdin: string) => new Promise<string>((ok) => {
  const p = execFile(join(BIN, 'aw-mcp'), ['codex'], { env: { PATH: process.env.PATH!, HOME: '/nonexistent', ...env } }, (_e, out) => ok(String(out)));
  p.stdin!.end(stdin);
});

test('aw-mcp: forwards each line with token, pane and agent; prints replies; errors when the server is down', async (t) => {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-aw-token'], pane: req.headers['x-aw-pane'], agent: req.headers['x-aw-agent'], body });
      if (body.includes('"id"')) { res.writeHead(200); res.end('{"jsonrpc":"2.0","id":1,"result":{}}'); } else { res.writeHead(202); res.end(); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const home = tmp('aw-mcp-');
  writeFileSync(join(home, 'token'), 'T'.repeat(64) + '\n');
  writeFileSync(join(home, 'endpoint'), `http://127.0.0.1:${(srv.address() as any).port}\n`);
  const out = await bridge({ AGENT_WORLDS_HOME: home, TMUX_PANE: '%4' }, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal(out, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.deepEqual(seen.map((s) => [s.url, s.token, s.pane, s.agent]), [['/mcp', 'T'.repeat(64), '%4', 'codex'], ['/mcp', 'T'.repeat(64), '%4', 'codex']]);
  writeFileSync(join(home, 'endpoint'), 'http://127.0.0.1:9\n');
  const down = await bridge({ AGENT_WORLDS_HOME: home }, '{"jsonrpc":"2.0","id":"x-7","method":"tools/list"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal(down, '{"jsonrpc":"2.0","id":"x-7","error":{"code":-32000,"message":"Agent Worlds is not running"}}\n');
});

test('/mcp: argument errors are tool errors, a failed notice is retried, a removed session is forgotten', async () => {
  const D = 'dddd4444-0000';
  await hook(ev.start, D, '%4');
  await rpc('%4', 'initialize', {});
  assert.equal((await tool('%1', 'nope')).isError, true);
  assert.equal((await tool('%1', 'aw_send', { to: 'dddd' })).isError, true);
  assert.equal((await tool('%1', 'aw_send', { to: 'dddd', text: '   ' })).isError, true);
  assert.equal((await tool('%1', 'aw_send', { to: 'dddd', text: 'x'.repeat(10001) })).isError, true);
  assert.equal((await tool('%1', 'aw_send', { to: 'aaaa', text: 'me?' })).isError, true, 'not to yourself');
  await hook({ ...ev.prompt, prompt: 'go on' }, A, '%1'); // a fresh streak
  assert.equal((await tool('%1', 'aw_send', { to: 'dddd', text: 'x'.repeat(10000) })).isError, undefined);
  const toD = () => typed.filter(([pane]) => pane === '%4').length;
  typeOk = false;
  await app.deliverMail();
  typeOk = true;
  await app.deliverMail();
  assert.equal(toD(), 2, 'typed again after a failed attempt');
  await tool('%1', 'aw_send', { to: 'dddd', text: 'unread when it goes' });
  await hook({ ...ev.end, reason: 'prompt_input_exit' }, D, '%4');
  assert.equal((await tool('%1', 'aw_send', { to: 'dddd', text: 'gone' })).isError, true);
  assert.ok(!JSON.parse(readFileSync(join(home, 'mailboxed.json'), 'utf8')).includes(D));
});

test('mailboxed.json brings the mailbox back after a server restart', async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  const again = startServer(cfg, TOKEN, {
    home,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    typeInto: async () => true,
  });
  await again.listen();
  try {
    const b2 = `http://127.0.0.1:${(again.server.address() as { port: number }).port}`;
    const h2 = (body: object, id: string, pane: string) => fetch(`${b2}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id }) });
    await h2(ev.prompt, A, '%1');
    await h2(ev.prompt, B, '%2'); // B never calls /mcp again: its CLI connected before the restart
    const r = await fetch(`${b2}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': '%1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aw_agents', arguments: {} } }) });
    assert.ok(JSON.parse(((await r.json()) as any).result.content[0].text).some((p: any) => p.id === B));
  } finally { await again.close(); }
});

test('Mailbox with a file: unread messages come back after a restart, read and forgotten ones do not', () => {
  const file = join(tmp('aw-mailfile-'), 'mailbox.json');
  const box = new Mailbox(Date.now, file);
  box.send('a', 'b', 'read it'); box.take('b');
  const told = box.send('a', 'b', 'told') as any; box.markNotified([told]);
  box.send('a', 'b', 'not yet'); box.send('a', 'c', 'c leaves');
  box.forget('c');
  const again = new Mailbox(Date.now, file);
  assert.deepEqual([...again.waiting()], ['b']);
  assert.deepEqual(again.unnotified('b').map((m) => m.text), ['not yet']);
  assert.deepEqual(again.take('b').map((m) => m.text), ['told', 'not yet']);
  assert.ok((again.send('a', 'b', 'next') as any).id > told.id, 'ids go on from the saved ones');
  writeFileSync(file, '{not json');
  assert.deepEqual([...new Mailbox(Date.now, file).waiting()], [], 'a corrupt file is ignored');
});

test('mail not yet delivered when the server restarts is delivered once its recipient is back', async () => {
  const h2 = tmp('aw-mail-restart-');
  const got: [string, string][] = [];
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  const boot = async () => {
    const s = startServer(cfg, TOKEN, {
      home: h2,
      deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
      typeInto: async (pane, text) => { got.push([pane, text]); return true; },
    });
    await s.listen();
    const b = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`;
    const hk = (body: object, id: string, pane: string) => fetch(`${b}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ ...body, session_id: id }) });
    const call = async (pane: string, method: string, params?: object) => (await (await fetch(`${b}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': pane }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any;
    return { s, hk, call };
  };
  const one = await boot();
  try {
    await one.hk(ev.start, A, '%1'); await one.hk(ev.start, B, '%2');
    await one.call('%1', 'initialize', {}); await one.call('%2', 'initialize', {});
    await one.hk(ev.prompt, B, '%2'); // B is busy: nothing is delivered before the restart
    assert.equal((await one.call('%1', 'tools/call', { name: 'aw_send', arguments: { to: 'bbbb', text: 'survive this' } })).result.isError, undefined);
    await one.s.deliverMail();
    assert.equal(got.length, 0);
  } finally { await one.s.close(); }
  const two = await boot();
  try {
    await two.s.deliverMail(); // B has not come back yet: its mail waits rather than being dropped
    assert.equal(got.length, 0);
    await two.hk(ev.prompt, B, '%2'); await two.hk(ev.stop, B, '%2');
    await two.s.deliverMail();
    assert.deepEqual(got.map(([p]) => p), ['%2']);
    const inbox = await two.call('%2', 'tools/call', { name: 'aw_inbox', arguments: {} });
    assert.match(inbox.result.content[0].text, /survive this/);
  } finally { await two.s.close(); }
});

test('a new worker receives mail after its launch task reaches the agent, even after a CLI restart', async () => {
  const worker = '99990000-0000', pane = '%9';
  const started = tool('%1', 'aw_spawn', { folder: '/work/repo-a', task: 'Handle the first task', agent: 'claude', worktree: false });
  for (let i = 0; i < 40 && !app.store.sessions.has('starting:awtest-mail-new'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(app.store.sessions.has('starting:awtest-mail-new'));
  await hook(ev.start, worker, pane);
  assert.equal((await started).isError, undefined);
  const sent = await tool('%1', 'aw_send', { to: '9999', text: 'Check the gateway too' });
  assert.equal(sent.isError, undefined, sent.content[0].text);
  assert.match(sent.content[0].text, /tools are ready/);
  const before = typed.length;
  await app.deliverMail();
  assert.equal(typed.length, before, 'mail waits for the worker to connect to its tools');
  await hook({ ...ev.end, reason: 'other' }, worker, pane); // CLI restarts before its MCP handshake
  await app.deliverMail();
  await hook({ ...ev.start, source: 'resume' }, worker, pane);
  await rpc(pane, 'initialize', {});
  await app.deliverMail();
  assert.equal(typed.length, before, 'a startup hook alone does not mean the task is ready for another prompt');
  await hook(ev.prompt, worker, pane);
  await app.deliverMail();
  assert.equal(typed.length, before, 'the worker is busy with its launch task');
  await hook(ev.stop, worker, pane);
  await app.deliverMail();
  assert.equal(typed.at(-1)?.[0], pane, 'the worker is notified after its first turn');
  assert.match((await tool(pane, 'aw_inbox')).content[0].text, /Check the gateway too/);
});
