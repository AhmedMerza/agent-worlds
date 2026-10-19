import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, lstatSync, statSync, writeFileSync, chmodSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { launchArgs, writeGeminiHome } from '../src/agents.ts';
import { fromGemini, toGemini } from '../src/gemini.ts';
import { readKeys, saveKey } from '../src/providers.ts';

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
  const { args, env } = launchArgs('gemini', { home, task: 'fix it' });
  assert.deepEqual(args, ['--approval-mode', 'yolo', '-i', 'fix it']);
  // launchArgs reads the real home from GEMINI_CLI_HOME (a temp dir under npm test); check the same with ours
  const dir = join(writeGeminiHome(home, real), '.gemini');
  assert.equal(join(env.GEMINI_CLI_HOME, '.gemini'), dir);
  assert.equal(readlinkSync(join(dir, 'oauth_creds.json')), join(real, 'oauth_creds.json'), 'the login is the user\'s');
  assert.equal(statSync(join(dir, 'settings.json')).mode & 0o777, 0o600);
  const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  assert.equal(s.general.vimMode, true, 'their settings stay');
  assert.deepEqual(Object.keys(s.hooks).sort(), ['AfterAgent', 'AfterTool', 'BeforeAgent', 'BeforeTool', 'SessionEnd', 'SessionStart']);
  assert.equal(s.hooks.BeforeTool[0].hooks[0].command, 'mine', 'their hooks run too');
  assert.match(s.hooks.BeforeTool[1].hooks[0].command, /bin\/aw-hook gemini$/);
  assert.equal(s.hooks.BeforeTool[1].hooks[0].timeout, 3_600_000, 'milliseconds, held for an hour');
  assert.equal(s.hooks.AfterAgent[0].hooks[0].timeout, 10_000);
  assert.equal(s.security.folderTrust.enabled, false);
  assert.deepEqual([s.mcpServers.aw.args, s.mcpServers.aw.trust, s.mcpServers.theirs.command], [['gemini'], true, 'x']);
  assert.ok(!lstatSync(join(real, 'settings.json')).isSymbolicLink() && !readFileSync(join(real, 'settings.json'), 'utf8').includes('aw-hook'), 'theirs is untouched');
  assert.deepEqual(launchArgs('gemini', { task: '' }), { args: [], env: {} }, 'no hooks, no yolo');
});

test('a Qwen provider goes into its own 0600 settings file, the key never in argv or env', () => {
  const home = tmp();
  const key = 'sk-or-v1-' + 'a'.repeat(40);
  const { args, env } = launchArgs('qwen', { home, task: 'go', provider: { id: 'openrouter', model: 'qwen/qwen3-coder:free', key } });
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
  // A new key drops the files that carry the old one
  saveKey(home, 'openrouter', 'sk-new-key-123');
  assert.ok(!existsSync(file));
  assert.deepEqual(readKeys(home), { openrouter: 'sk-new-key-123' });
  assert.equal(statSync(join(home, 'keys.json')).mode & 0o777, 0o600);
});

async function boot() {
  const repo = tmp(), home = tmp();
  const calls: any[] = [];
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [repo] }] }), port: 0 };
  const app = startServer(cfg, TOKEN, {
    home, procRoot: join(tmp(), 'none'),
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
    assert.deepEqual(calls.at(-1).provider, { id: 'openrouter', model: 'qwen/qwen3-coder:free', key });
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
