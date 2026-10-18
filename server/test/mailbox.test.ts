import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { Mailbox, PING_PONG } from '../src/mailbox.ts';
import { ev } from './fixtures.ts';

const TOKEN = 'b'.repeat(64);
const typed: [string, string][] = [];
let typeOk = true;
let app: ReturnType<typeof startServer>;
let base = '';
const home = mkdtempSync(join(tmpdir(), 'aw-mail-home-'));

before(async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'] }] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    home,
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
  assert.deepEqual((await rpc('%1', 'tools/list')).result.tools.map((t: any) => t.name), ['aw_agents', 'aw_send', 'aw_inbox']);
  assert.equal((await rpc('%1', 'resources/list')).error.code, -32601);
  assert.equal((await tool('%1', 'aw_agents')).isError, true, 'no session in that pane yet');

  await hook(ev.start, A, '%1');
  await hook(ev.start, B, '%2');
  await hook(ev.start, 'cccc3333-0000', '%3'); // a plain `claude` reporting through global hooks: no mailbox tools
  await rpc('%2', 'initialize', {}); // B's CLI connected to the mailbox
  await hook(ev.prompt, B, '%2'); // B is mid-turn
  const peers = JSON.parse((await tool('%1', 'aw_agents')).content[0].text);
  assert.deepEqual(peers.map((p: any) => p.id), [B], 'only sessions that reached the mailbox');
  assert.match((await tool('%1', 'aw_send', { to: 'cccc', text: 'x' })).content[0].text, /no session "cccc"/);
  assert.match((await tool('%1', 'aw_send', { to: 'nope', text: 'x' })).content[0].text, /no session "nope"/);
  assert.match((await tool('%1', 'aw_send', { to: 'bbbb', text: 'step 3 misses the auth check' })).content[0].text, /working now/);
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
  const home = mkdtempSync(join(tmpdir(), 'aw-mcp-'));
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
  await hook(ev.end, D, '%4');
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
