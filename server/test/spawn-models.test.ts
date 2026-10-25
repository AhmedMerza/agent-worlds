import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { launchArgs, parseSpawnAgents } from '../src/agents.ts';
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

test('the model flag goes on the CLIs that take one', () => {
  assert.deepEqual(launchArgs('claude', { task: 't', model: 'sonnet' }).args, ['--model', 'sonnet', '--', 't']);
  assert.deepEqual(launchArgs('codex', { task: 't', model: 'gpt-5-codex' }).args, ['-m', 'gpt-5-codex', '--', 't']);
  assert.deepEqual(launchArgs('kimi', { task: 't', model: 'k2' }).args, [], 'no known flag: nothing added');
  assert.throws(() => parseSpawnAgents({ kimi: ['k2'] }), /cannot pick a model for Kimi/);
  assert.throws(() => parseSpawnAgents({ nope: [] }), /unknown agent/);
});

test('with nothing configured, a lead may pick any agent and model', async () => {
  const r = await spawn({ agent: 'codex', model: 'gpt-5-codex' });
  assert.equal(launched.at(-1).model, 'gpt-5-codex', r.content[0].text);
  assert.match(r.content[0].text, /Codex \(gpt-5-codex\)/);
  assert.match((await spawn({ agent: 'kimi', model: 'k2' })).content[0].text, /cannot pick a model for Kimi/);
  assert.match((await spawn({ model: 'sonnet; rm -rf /' })).content[0].text, /must be a model id/);
});

test('the user\'s list turns agents off and limits their models', async () => {
  assert.equal((await allow({ claude: ['sonnet'], codex: [] })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).spawnAgents.claude[0], 'sonnet', 'saved');
  const n = launched.length;
  assert.match((await spawn({ agent: 'gemini' })).content[0].text, /not allowed leads to start Gemini CLI.*claude \(models sonnet\); codex \(any model\)/);
  assert.match((await spawn({ agent: 'claude', model: 'opus' })).content[0].text, /only on sonnet/);
  assert.match((await spawn({ steps: [{ kind: 'plan', agent: 'qwen' }] })).content[0].text, /not allowed leads to start Qwen/);
  assert.equal(launched.length, n, 'nothing refused was started');
  await spawn({ agent: 'claude', model: 'sonnet' });
  assert.equal(launched.at(-1).model, 'sonnet');
  const desc = (await rpc('tools/list')).tools.find((t: any) => t.name === 'aw_spawn').description;
  assert.match(desc, /The user allows: claude \(models sonnet\); codex \(any model\)/, 'the lead learns its choices up front');
  assert.equal((await allow({ claude: 'opus' })).status, 400);
  assert.equal((await allow(null)).status, 200);
  assert.equal((await (await fetch(`${base}/api/agents`, { headers: H })).json() as any).spawn, null, 'back to everything');
});

test('aw_agents lists the caller first with its model and context', async () => {
  const peers = JSON.parse((await rpc('tools/call', { name: 'aw_agents', arguments: {} })).content[0].text);
  assert.equal(peers[0].id, LEAD);
  assert.equal(peers[0].you, true);
  assert.equal(peers[0].model, 'claude-haiku');
  assert.ok('context' in peers[0]);
});
