import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { launchArgs, parseSpawnAgents, isModelId } from '../src/agents.ts';
import { ev, tmp } from './fixtures.ts';

const TOKEN = 'e'.repeat(64);
const launched: any[] = [];
let app: ReturnType<typeof startServer>;
let base = '';
const home = tmp('aw-spawn-models-');

before(async () => {
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: ['/work/repo-a'], leadSpawn: true, maxSpawned: 20 }] }), port: 0 };
  app = startServer(cfg, TOKEN, {
    home, spawnIdMs: 50, installed: () => true,
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false }), branchOf: async () => 'main', tmuxSessionOf: async () => 'awtest-fake' },
    createSession: (async (o: any) => {
      launched.push(o);
      return { tmuxSession: `awtest-models-${launched.length}`, dir: o.repo, branch: null, pane: `%${100 + launched.length}` };
    }) as any,
    typeInto: async () => true, endPane: async () => null,
  });
  await app.listen();
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  await fetch(`${base}/api/hook`, { method: 'POST', headers: { ...H, 'x-aw-pane': '%1' }, body: JSON.stringify({ ...ev.start, session_id: LEAD, cwd: '/work/repo-a' }) });
});
after(() => app.close());

const H = { 'x-aw-token': TOKEN, 'content-type': 'application/json' };
const LEAD = 'aaaa1111-0000';
const rpc = async (method: string, params: object = {}) => ((await (await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, 'x-aw-pane': '%1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as any).result;
const spawn = (args: object) => rpc('tools/call', { name: 'aw_spawn', arguments: { folder: 'repo-a', task: 'x', ...args } }) as Promise<{ content: { text: string }[]; isError?: boolean }>;
const allow = (spawn: unknown) => fetch(`${base}/api/agents/spawn`, { method: 'POST', headers: H, body: JSON.stringify({ spawn }) });

const setDefault = (agent: string) => fetch(`${base}/api/agents/default`, { method: 'POST', headers: H, body: JSON.stringify({ agent }) });
// Each test starts with no rules and Claude as the default, whatever the one before it left
beforeEach(async () => { await allow(null); await setDefault('claude'); });

test('the model goes in as one --model=<id> argument, on the CLIs that take one', () => {
  assert.deepEqual(launchArgs('claude', { task: 't', model: 'sonnet' }).args, ['--model=sonnet', '--', 't']);
  assert.deepEqual(launchArgs('codex', { task: 't', model: 'gpt-5-codex' }).args.slice(-3), ['--model=gpt-5-codex', '--', 't']);
  const home = tmp('aw-gemini-home-'), dir = tmp('aw-gemini-dir-');
  const g = launchArgs('gemini', { home, dir, task: 't', model: 'gemini-2.5-pro' }).args;
  assert.deepEqual(g.slice(-3), ['--model=gemini-2.5-pro', '-i', 't'], 'Gemini reads a separate value starting with - as a flag');
  assert.deepEqual(launchArgs('kimi', { task: 't', model: 'k2' }).args, ['--model=k2']);
  assert.deepEqual(launchArgs('qwen', { task: 't', model: 'x' }).args, ['-i', 't'], 'Qwen takes its model from its provider');
});

test('model ids: never one a CLI could read as a flag', () => {
  assert.equal(isModelId('claude-haiku-5-5'), true);
  for (const bad of ['--yolo', '-m', '', 'a b', 'x;y']) assert.equal(isModelId(bad), false, bad);
  assert.throws(() => parseSpawnAgents({ gemini: ['--yolo'] }), /list of model ids/);
  assert.deepEqual(parseSpawnAgents({ kimi: ['k2'] }), { kimi: ['k2'] });
  assert.throws(() => parseSpawnAgents({ nope: [] }), /unknown agent/);
  assert.throws(() => parseSpawnAgents(['claude']), /must be an object/);
});

test('config.json: saved rules load in their order; null or absent is no rules; a bad list is refused', () => {
  assert.deepEqual(Object.keys(parseConfig({ spawnAgents: { codex: [], claude: ['haiku'] } }).spawnAgents!), ['codex', 'claude']);
  assert.equal(parseConfig({ spawnAgents: null }).spawnAgents, undefined);
  assert.equal(parseConfig({}).spawnAgents, undefined);
  assert.throws(() => parseConfig({ spawnAgents: { claude: [7] } }), /list of model ids/);
});

test('with nothing configured, a lead may pick any agent and model, and omitted agents are spread', async () => {
  const r = await spawn({ agent: 'codex', model: 'gpt-5-codex' });
  assert.equal(launched.at(-1).model, 'gpt-5-codex', r.content[0].text);
  assert.equal(launched.at(-1).codexUnrestricted, undefined, 'lead-started Codex workers do not opt in to unrestricted access');
  assert.match(r.content[0].text, /Codex \(gpt-5-codex\)/);
  await spawn({ agent: 'kimi', model: 'k2' });
  assert.deepEqual([launched.at(-1).agent, launched.at(-1).model], ['kimi', 'k2']);
  assert.match((await spawn({ model: 'sonnet; rm -rf /' })).content[0].text, /must be a model id/);
  const n = launched.length;
  assert.match((await spawn({ agent: 'gemini', model: '--yolo' })).content[0].text, /must be a model id/, 'not a flag in disguise');
  assert.equal(launched.length, n);
  await setDefault('codex');
  await spawn({});
  assert.equal(launched.at(-1).agent, 'claude', 'codex already has a worker, so the next available CLI is used');
  assert.equal(launched.at(-1).model, undefined, 'no list: the CLI\'s own model');
  const desc = (await rpc('tools/list')).tools.find((t: any) => t.name === 'aw_spawn').description;
  assert.match(desc, /in preference order: codex \(any model\); claude/, 'the user default breaks ties');
});

test('the user\'s list turns agents off, orders them, and holds their models even when the lead names none', async () => {
  assert.equal((await allow({ codex: [], claude: ['sonnet', 'opus'] })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).spawnAgents.claude[0], 'sonnet', 'saved');
  const n = launched.length;
  assert.match((await spawn({ agent: 'gemini' })).content[0].text, /not allowed leads to start Gemini CLI.*in preference order: codex \(any model\); claude \(models sonnet, opus\)/);
  assert.match((await spawn({ agent: 'claude', model: 'haiku' })).content[0].text, /only on sonnet, opus/);
  assert.match((await spawn({ steps: [{ kind: 'plan', agent: 'qwen' }] })).content[0].text, /not allowed leads to start Qwen/);
  assert.match((await spawn({ steps: [{ kind: 'plan', agent: 'claude' }, { kind: 'build', agent: 'qwen' }] })).content[0].text, /not allowed leads to start Qwen/, 'one step off blocks the run');
  assert.match((await spawn({ agent: 'claude', model: 'opus', steps: [{ kind: 'plan', agent: 'claude' }] })).content[0].text, /not a run/);
  assert.equal(launched.length, n, 'nothing refused was started');
  await spawn({ agent: 'claude', model: 'opus' });
  assert.equal(launched.at(-1).model, 'opus');
  const prior = launched.length;
  assert.match((await spawn({ agent: 'claude' })).content[0].text, /choose a model for this task on Claude Code: sonnet, opus/);
  assert.equal(launched.length, prior, 'no worker starts until the lead chooses among allowed models');
  await spawn({});
  assert.equal(launched.at(-1).agent, 'codex', 'no agent named: the first the user allows, not their default (claude)');
  const run = await spawn({ steps: [{ kind: 'plan', agent: 'claude' }] });
  assert.equal(run.isError, undefined, run.content[0].text);
  assert.deepEqual([launched.at(-1).agent, launched.at(-1).model], ['claude', 'sonnet'], 'a lead\'s run keeps to the named models too');
});

test('a sole allowed model is selected without asking', async () => {
  await allow({ kimi: ['k2'] });
  await spawn({ agent: 'kimi' });
  assert.deepEqual([launched.at(-1).agent, launched.at(-1).model], ['kimi', 'k2']);
});

test('an omitted agent shares comparable work across the allowed CLIs', async () => {
  await allow({ codex: [], kimi: [] });
  const before = launched.length;
  await Promise.all([spawn({}), spawn({})]);
  assert.deepEqual(launched.slice(before).map((x) => x.agent).sort(), ['codex', 'kimi']);
});

test('POST /api/agents/spawn refuses bad lists and saves built on rules another window changed', async () => {
  for (const bad of [{ claude: 'opus' }, { nope: [] }, { qwen: ['k2'] }, { gemini: ['--yolo'] }, ['claude']]) assert.equal((await allow(bad)).status, 400, JSON.stringify(bad));
  const post = (spawn: unknown, builtOn: unknown) => fetch(`${base}/api/agents/spawn`, { method: 'POST', headers: H, body: JSON.stringify({ spawn, base: builtOn }) });
  assert.equal((await post({ codex: [] }, null)).status, 200);
  const stale = await post({ claude: [] }, null); // built on "no rules", but codex-only was saved since
  assert.equal(stale.status, 409);
  assert.deepEqual(((await stale.json()) as any).spawn, { codex: [] }, 'the saved rules come back to be shown');
  assert.equal((await post({ codex: [], claude: [] }, { codex: [] })).status, 200);
  assert.equal((await post({}, { codex: [], claude: [] })).status, 200, 'all off is a valid choice');
  assert.match((await spawn({})).content[0].text, /allowed no agents|not allowed leads to start/);
  assert.equal((await allow(null)).status, 200);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).spawnAgents, undefined, 'null removes the key');
});

test('aw_agents lists the caller first, marked you, with its model and context', async () => {
  const peers = JSON.parse((await rpc('tools/call', { name: 'aw_agents', arguments: {} })).content[0].text);
  assert.equal(peers[0].id, LEAD);
  assert.equal(peers[0].you, true);
  assert.equal(peers[0].model, 'claude-haiku');
  assert.ok(peers.slice(1).length > 0 && peers.slice(1).every((p: any) => !('you' in p) && 'model' in p && 'context' in p), 'others: no you, model and context present');
});
