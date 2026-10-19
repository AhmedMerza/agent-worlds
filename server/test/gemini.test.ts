import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, lstatSync, statSync, writeFileSync, chmodSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { launchArgs, writeGeminiHome } from '../src/agents.ts';
import { fromGemini, toGemini } from '../src/gemini.ts';
import { readKeys, saveKey, readServers, saveServer, serverUrl } from '../src/providers.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));
const TOKEN = 'g'.repeat(64);

test('Gemini payloads become Claude-shaped events; only tools it would ask about are held', () => {
  const base = { session_id: 's', cwd: '/r', transcript_path: '' };
  assert.equal(fromGemini({ ...base, hook_event_name: 'BeforeAgent', prompt: 'hi' })?.hook_event_name, 'UserPromptSubmit');
  const write = fromGemini({ ...base, hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/r/a', content: 'x' } });
  assert.deepEqual([write?.hook_event_name, write?.tool_name], ['PermissionRequest', 'Write']);
  assert.equal(fromGemini({ ...base, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'ls' } })?.hook_event_name, 'PermissionRequest');
  assert.equal(fromGemini({ ...base, hook_event_name: 'BeforeTool', tool_name: 'mcp_other__thing' })?.hook_event_name, 'PermissionRequest', 'an unknown tool asks');
  const read = fromGemini({ ...base, hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: '/r/a' } });
  assert.deepEqual([read?.hook_event_name, read?.tool_name], ['PreToolUse', 'Read']);
  for (const name of ['aw__aw_send', 'mcp_aw_aw_send']) assert.equal(fromGemini({ ...base, hook_event_name: 'BeforeTool', tool_name: name })?.hook_event_name, 'PreToolUse', `the mailbox runs freely (${name}: 0.29, 0.64 naming)`);
  assert.equal(fromGemini({ ...base, hook_event_name: 'AfterTool', tool_name: 'replace', tool_response: { error: 'no match' } })?.hook_event_name, 'PostToolUseFailure');
  const stop = fromGemini({ ...base, hook_event_name: 'AfterAgent', prompt: 'hi', prompt_response: 'All done.' });
  assert.deepEqual([stop?.hook_event_name, stop?.last_assistant_message], ['Stop', 'All done.']);
  assert.equal(fromGemini({ ...base, hook_event_name: 'Notification', notification_type: 'ToolPermission' }), null);
  assert.equal(fromGemini({ ...base, hook_event_name: 'BeforeModel' }), null);

  assert.equal(toGemini('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'), '');
  assert.deepEqual(JSON.parse(toGemini('{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"No."}}}')), { decision: 'deny', reason: 'No.' });
  for (const out of ['', '{}', 'garbage']) assert.equal(JSON.parse(toGemini(out)).decision, 'deny', `fails closed on ${JSON.stringify(out)}`);
});

test('Gemini starts in yolo mode only with our hooks in place, from a home of its own linked to the user\'s', () => {
  const home = tmp(), real = join(tmp(), '.gemini');
  mkdirSync(real);
  writeFileSync(join(real, 'oauth_creds.json'), '{}');
  writeFileSync(join(real, 'settings.json'), JSON.stringify({ general: { vimMode: true }, hooks: { BeforeTool: [{ hooks: [{ type: 'command', command: 'mine' }] }] }, mcpServers: { theirs: { command: 'x' } } }));
  const saved = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = join(real, '..'); // never the developer's own ~/.gemini
  let launched;
  try { launched = launchArgs('gemini', { home, task: 'fix it', dir: tmp() }); } finally { if (saved === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved; }
  assert.deepEqual(launched.args, ['--approval-mode', 'yolo', '-i', 'fix it']);
  const dir = join(launched.env.GEMINI_CLI_HOME, '.gemini');
  assert.equal(launched.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH, join(real, 'trustedFolders.json'), 'trust is saved to the user\'s own file');
  assert.equal(readlinkSync(join(dir, 'oauth_creds.json')), join(real, 'oauth_creds.json'), 'the login is the user\'s');
  assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  assert.equal(s.general.vimMode, true, 'their settings stay');
  assert.deepEqual(Object.keys(s.hooks).sort(), ['AfterAgent', 'AfterTool', 'BeforeAgent', 'BeforeTool', 'SessionEnd', 'SessionStart']);
  assert.equal(s.hooks.BeforeTool[0].hooks[0].command, 'mine', 'their hooks run too');
  assert.match(s.hooks.BeforeTool[1].hooks[0].command, /bin\/aw-hook gemini$/);
  assert.equal(s.hooks.BeforeTool[1].hooks[0].timeout, 3_600_000, 'milliseconds, held for an hour');
  assert.equal(s.hooks.AfterAgent[0].hooks[0].timeout, 10_000);
  assert.deepEqual(s.hooksConfig, { enabled: true, disabled: [] }, 'hooks forced on');
  assert.equal(s.security, undefined, 'folder trust left to Gemini');
  assert.deepEqual([s.mcpServers.aw.args, s.mcpServers.aw.trust, s.mcpServers.theirs.command], [['gemini'], true, 'x']);
  assert.ok(!lstatSync(join(real, 'settings.json')).isSymbolicLink() && !readFileSync(join(real, 'settings.json'), 'utf8').includes('aw-hook'), 'theirs is untouched');
  assert.deepEqual(launchArgs('gemini', { task: '' }), { args: [], env: {} }, 'no hooks, no yolo');
});

test('Gemini: no yolo in a repo with its own .gemini/settings.json; the user\'s hook switches are overridden; sign-in kept', () => {
  const home = tmp(), real = join(tmp(), '.gemini'), repo = tmp();
  mkdirSync(real);
  writeFileSync(join(real, 'settings.json'), JSON.stringify({ hooksConfig: { enabled: false, disabled: ['aw'] } }));
  mkdirSync(join(repo, '.gemini'));
  writeFileSync(join(repo, '.gemini', 'settings.json'), JSON.stringify({ hooksConfig: { enabled: false } }));
  const saved = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = join(real, '..');
  try {
    assert.deepEqual(launchArgs('gemini', { home, task: 'x', dir: repo }).args, ['-i', 'x'], 'the repo\'s settings outrank ours: Gemini asks itself');
    assert.deepEqual(launchArgs('gemini', { home, task: 'x' }).args, ['-i', 'x'], 'unknown folder: no yolo');
  } finally { if (saved === undefined) delete process.env.GEMINI_CLI_HOME; else process.env.GEMINI_CLI_HOME = saved; }
  const dir = join(writeGeminiHome(home, real).root, '.gemini');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooksConfig, { enabled: true, disabled: [] });
  // Gemini saves the sign-in choice into our copy; the next start keeps it
  const f = join(dir, 'settings.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), security: { auth: { selectedType: 'oauth-personal' } } }));
  writeGeminiHome(home, real);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).security.auth.selectedType, 'oauth-personal');
  // Started from inside a session (GEMINI_CLI_HOME is ours): falls back to ~/.gemini, never links onto itself
  const fake = tmp(), savedHome = process.env.HOME;
  mkdirSync(join(fake, '.gemini'));
  writeFileSync(join(fake, '.gemini', 'oauth_creds.json'), '{}');
  process.env.HOME = fake;
  try { assert.equal(writeGeminiHome(home, dir).real, join(fake, '.gemini')); } finally { process.env.HOME = savedHome; }
  assert.equal(readlinkSync(join(dir, 'oauth_creds.json')), join(fake, '.gemini', 'oauth_creds.json'));
});

test('a Qwen provider goes into its own 0600 settings file, the key never in argv or env', () => {
  const home = tmp();
  const key = 'sk-or-v1-' + 'a'.repeat(40);
  const { args, env } = launchArgs('qwen', { home, task: 'go', provider: { id: 'openrouter', auth: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', key } });
  assert.deepEqual(args, ['-i', 'go']);
  assert.deepEqual(Object.keys(env), ['QWEN_CODE_SYSTEM_SETTINGS_PATH']);
  assert.ok(!JSON.stringify({ args, env }).includes(key));
  const file = env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
  assert.match(file, /qwen-openrouter-[0-9a-f]{10}\.json$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(s.security.auth.selectedType, 'openai');
  assert.equal(s.model.name, 'qwen/qwen3-coder:free');
  assert.deepEqual(s.modelProviders.openai, [{ id: 'qwen/qwen3-coder:free', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'AGENT_WORLDS_PROVIDER_KEY' }]);
  assert.equal(s.env.AGENT_WORLDS_PROVIDER_KEY, key);
  assert.ok(s.hooks.PermissionRequest && s.mcpServers.aw, 'still reports and has the mailbox');
  const plain = launchArgs('qwen', { home, task: '' }).env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
  assert.ok(plain.endsWith('/qwen-settings.json') && !('modelProviders' in JSON.parse(readFileSync(plain, 'utf8'))));
  // A new key drops the files that carry the old one, not those of a server whose id starts the same
  const other = join(home, 'qwen-openrouter-box-0123456789.json');
  writeFileSync(other, '{}');
  saveKey(home, 'openrouter', 'sk-new-key-123');
  assert.ok(!existsSync(file));
  assert.ok(existsSync(other), 'another provider\'s settings stay');
  assert.deepEqual(readKeys(home), { openrouter: 'sk-new-key-123' });
  assert.equal(statSync(join(home, 'keys.json')).mode & 0o777, 0o600);
});

async function boot(holdMs?: number) {
  const repo = tmp(), home = tmp();
  const calls: any[] = [];
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [repo] }] }), port: 0 };
  const app = startServer(cfg, TOKEN, {
    home, procRoot: join(tmp(), 'none'), ...(holdMs ? { holdMs } : {}),
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' },
    createSession: async (o: any) => { calls.push(o); return { tmuxSession: 'aw-x-1', dir: o.repo, branch: null }; },
  } as any);
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  return { app, base, repo, home, calls };
}

test('a Gemini session: a held write waits for Allow or Deny (even with no page open), the turn end is done', async () => {
  const { app, base, repo } = await boot();
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json', 'x-aw-agent': 'gemini', 'x-aw-pane': '%9' };
  const hook = (b: object) => fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify({ session_id: 'gem-1', cwd: repo, transcript_path: '', ...b }) });
  const session = async () => ((await (await fetch(`${base}/api/state`, { headers: { 'x-aw-token': TOKEN } })).json()) as any).sessions.find((s: any) => s.id === 'gem-1');
  const decide = async (decision: string) => {
    for (let i = 0; i < 50 && (await session())?.card?.kind !== 'permission'; i++) await new Promise((r) => setTimeout(r, 10));
    const s = await session();
    return fetch(`${base}/api/sessions/gem-1/permission`, { method: 'POST', headers: H, body: JSON.stringify({ requestId: s.card.requestId, decision }) });
  };
  try {
    assert.equal((await hook({ hook_event_name: 'SessionStart', source: 'startup' })).status, 204);
    assert.equal((await hook({ hook_event_name: 'BeforeAgent', prompt: 'write a file' })).status, 204);
    assert.equal((await session()).agent, 'gemini');
    assert.equal((await hook({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: `${repo}/a` } })).status, 204, 'a read is not held');

    const held = hook({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: `${repo}/a`, content: 'x' } });
    assert.equal((await decide('allow')).status, 200);
    const allowed = await held;
    assert.deepEqual([allowed.status, await allowed.text()], [204, ''], 'allow = no objection');
    await hook({ hook_event_name: 'AfterTool', tool_name: 'write_file', tool_input: { file_path: `${repo}/a`, content: 'x' }, tool_response: {} });

    const held2 = hook({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: 'rm -rf build' } });
    assert.equal((await decide('deny')).status, 200);
    assert.equal((await (await held2).json()).decision, 'deny');

    await hook({ hook_event_name: 'AfterAgent', prompt: 'write a file', prompt_response: 'Wrote it.' });
    const s = await session();
    assert.deepEqual([s.state, s.card.kind, s.card.summary], ['done', 'done', 'Wrote it.']);
  } finally { await app.close(); }
});

test('providers: a key is saved but never read back; a Qwen session starts with it', async () => {
  const { app, base, repo, home, calls } = await boot();
  const bin = tmp();
  writeFileSync(join(bin, 'qwen'), '#!/bin/sh\n'); chmodSync(join(bin, 'qwen'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
  const put = (id: string, key: unknown) => fetch(`${base}/api/providers/${id}/key`, { method: 'PUT', headers: H, body: JSON.stringify({ key }) });
  const start = (b: object) => fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ worldId: 'web', repo, ...b }) });
  const key = 'sk-or-v1-' + 'b'.repeat(40);
  try {
    assert.equal((await start({ agent: 'qwen', provider: 'openrouter' })).status, 400, 'no key yet');
    assert.equal((await put('nope', key)).status, 404);
    assert.equal((await put('openrouter', 'has space in it')).status, 400);
    assert.equal((await put('openrouter', key)).status, 200);
    const list = await (await fetch(`${base}/api/providers`, { headers: H })).text();
    assert.ok(!list.includes(key), 'the key never comes back');
    assert.equal(JSON.parse(list).providers.find((p: any) => p.id === 'openrouter').hasKey, true);
    assert.equal((await start({ agent: 'claude', provider: 'openrouter' })).status, 400, 'Qwen only');
    assert.equal((await start({ agent: 'qwen', provider: 'openrouter', model: 'bad model; rm' })).status, 400);
    assert.equal((await start({ agent: 'qwen', provider: 'openrouter', model: 'qwen/qwen3-coder:free' })).status, 201);
    assert.deepEqual(calls.at(-1).provider, { id: 'openrouter', auth: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', key });
    const st = await (await fetch(`${base}/api/state`, { headers: H })).json() as any;
    assert.equal(st.sessions.find((x: any) => x.agent === 'qwen')?.via, 'OpenRouter · qwen/qwen3-coder:free', 'the session says what it runs on');
    assert.ok(!JSON.stringify(st).includes(key), 'the key is not in the state');
    assert.equal((await start({ agent: 'qwen' })).status, 201);
    assert.equal(calls.at(-1).provider, undefined, 'no provider: the user\'s own Qwen setup');
    assert.equal((await put('openrouter', null)).status, 200);
    assert.deepEqual(readKeys(home), {});
    assert.ok(!readdirSync(home).some((f) => f.startsWith('qwen-openrouter-')));
  } finally { process.env.PATH = path; await app.close(); }
});

test('a server of your own: added by address, its model asked for, no key needed, removable', async () => {
  const { app, base, repo, home, calls } = await boot();
  const llm = createServer((req, res) => {
    res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3.8-flash-next-iq3_s' }] }));
  });
  await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
  const llmUrl = `http://127.0.0.1:${(llm.address() as { port: number }).port}/v1/`;
  const bin = tmp();
  writeFileSync(join(bin, 'qwen'), '#!/bin/sh\n'); chmodSync(join(bin, 'qwen'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
  const add = (b: object) => fetch(`${base}/api/providers`, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const start = (b: object) => fetch(`${base}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify({ worldId: 'web', repo, agent: 'qwen', ...b }) });
  try {
    assert.equal((await add({ name: 'x', baseUrl: 'file:///etc/passwd' })).status, 400);
    assert.equal((await add({ name: 'x', baseUrl: 'http://u:p@host/v1' })).status, 400, 'no credentials in the address');
    assert.equal((await add({ name: 'OpenRouter', baseUrl: llmUrl })).status, 400, 'a built-in name');
    assert.equal((await add({ name: 'x', baseUrl: 'http://127.0.0.1:1/v1' })).status, 422, 'unreachable, no model typed');
    const r = await add({ name: "Sam's Qwen", baseUrl: llmUrl });
    assert.equal(r.status, 201);
    assert.deepEqual((await r.json() as any).provider, { id: 'sam-s-qwen', name: "Sam's Qwen", model: 'qwen3.8-flash-next-iq3_s', hasKey: false, custom: true, baseUrl: llmUrl.slice(0, -1) });
    const list = (await (await fetch(`${base}/api/providers`, { headers: H })).json() as any).providers;
    assert.ok(list.some((p: any) => p.id === 'openrouter') && list.some((p: any) => p.id === 'sam-s-qwen' && p.custom));
    assert.equal((await start({ provider: 'sam-s-qwen' })).status, 201, 'no key needed');
    assert.deepEqual(calls.at(-1).provider, { id: 'sam-s-qwen', auth: 'openai', baseUrl: llmUrl.slice(0, -1), model: 'qwen3.8-flash-next-iq3_s', key: 'no-key' });
    const st = await (await fetch(`${base}/api/state`, { headers: H })).json() as any;
    assert.ok(st.sessions.some((x: any) => x.via === "Sam's Qwen · qwen3.8-flash-next-iq3_s"));
    assert.equal((await start({ provider: 'constructor' })).status, 400, 'an inherited property is not a provider');
    // A key saved for the server is the one sessions send
    assert.equal((await fetch(`${base}/api/providers/sam-s-qwen/key`, { method: 'PUT', headers: H, body: JSON.stringify({ key: 'sk-sam-123456' }) })).status, 200);
    assert.equal((await start({ provider: 'sam-s-qwen' })).status, 201);
    assert.equal(calls.at(-1).provider.key, 'sk-sam-123456');
    // A key, and a typed model, skip nothing else
    assert.equal((await add({ name: 'Box', baseUrl: 'http://127.0.0.1:1/v1', model: 'llama-3', key: 'sk-local-123' })).status, 201);
    assert.equal(readKeys(home).box, 'sk-local-123');
    // Added again under its name, at another address and with no key: the old key does not follow it there
    const again = await add({ name: 'Box', baseUrl: 'http://127.0.0.2:1/v1', model: 'llama-3' });
    assert.equal((await again.json() as any).provider.hasKey, false);
    assert.equal(readKeys(home).box, undefined);
    assert.equal(readServers(home).box.baseUrl, 'http://127.0.0.2:1/v1');
    assert.equal((await fetch(`${base}/api/providers/openrouter`, { method: 'DELETE', headers: H })).status, 404, 'built-ins stay');
    assert.equal((await fetch(`${base}/api/providers/box`, { method: 'DELETE', headers: H })).status, 200);
    assert.deepEqual(Object.keys(readServers(home)), ['sam-s-qwen']);
    assert.equal(readKeys(home).box, undefined, 'its key goes with it');
    assert.equal((await start({ provider: 'box' })).status, 400);
  } finally { process.env.PATH = path; llm.close(); await app.close(); }
});

test('servers of your own: addresses, ids, and the Qwen settings they produce', () => {
  assert.equal(serverUrl(' http://h:8080/v1// '), 'http://h:8080/v1');
  for (const bad of ['ftp://h/v1', 'http://h/v1?x=1', 'http://h/v1#a', 'http://u@h/v1', 'h:8080/v1', 42, `http://h/${'a'.repeat(500)}`]) assert.equal(serverUrl(bad), null, String(bad));
  const home = tmp();
  writeFileSync(join(home, 'servers.json'), JSON.stringify({ openrouter: { name: 'x', baseUrl: 'http://h', model: 'm' }, 'Bad Id': { name: 'x', baseUrl: 'http://h', model: 'm' }, half: { name: 'x' }, ok: { name: 'Ok', baseUrl: 'http://h/v1', model: 'm' } }));
  assert.deepEqual(Object.keys(readServers(home)), ['ok'], 'built-in ids, bad ids and half entries are dropped');
  writeFileSync(join(home, 'servers.json'), '[]');
  assert.deepEqual(readServers(home), {});
  assert.equal(saveServer(home, { name: '!!!', baseUrl: 'http://h/v1', model: 'm' }), null);
  assert.equal(saveServer(home, { name: 'Gemini', baseUrl: 'http://h/v1', model: 'm' }), null, 'a built-in id');
  assert.equal(saveServer(home, { name: 'Sam', baseUrl: 'http://h/v1', model: 'm' }), 'sam');
  const { env } = launchArgs('qwen', { home, task: '', provider: { id: 'sam', auth: 'openai', baseUrl: 'http://h/v1', model: 'm', key: 'no-key' } });
  const file = env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
  const s = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual([s.security.auth.selectedType, s.modelProviders.openai, s.env.AGENT_WORLDS_PROVIDER_KEY], ['openai', [{ id: 'm', baseUrl: 'http://h/v1', envKey: 'AGENT_WORLDS_PROVIDER_KEY' }], 'no-key']);
  saveServer(home, { name: 'Sam', baseUrl: 'http://other/v1', model: 'm' });
  assert.ok(!existsSync(file), 'a new address drops the settings files that point at the old one');
  assert.equal(readServers(home).sam.baseUrl, 'http://other/v1');
});

test('a held Gemini tool is denied when nobody answers in time, or the session ends', async () => {
  const { app, base, repo } = await boot(150);
  const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json', 'x-aw-agent': 'gemini', 'x-aw-pane': '%8' };
  const hook = (b: object) => fetch(`${base}/api/hook`, { method: 'POST', headers: H, body: JSON.stringify({ session_id: 'gem-2', cwd: repo, transcript_path: '', ...b }) });
  const write = { hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: `${repo}/a`, content: 'x' } };
  try {
    await hook({ hook_event_name: 'BeforeAgent', prompt: 'go' });
    const timedOut = await hook(write);
    assert.deepEqual([timedOut.status, (await timedOut.json()).decision], [200, 'deny']);
    const s = ((await (await fetch(`${base}/api/state`, { headers: H })).json()) as any).sessions.find((x: any) => x.id === 'gem-2');
    assert.notEqual(s.card?.kind, 'permission', 'a timed-out request is gone, not left to answer');
    const held = hook({ ...write, tool_input: { file_path: `${repo}/b`, content: 'y' } });
    await new Promise((r) => setTimeout(r, 30));
    await hook({ hook_event_name: 'SessionEnd', reason: 'exit' });
    assert.equal((await (await held).json()).decision, 'deny');
  } finally { await app.close(); }
});
