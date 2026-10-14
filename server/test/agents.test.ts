import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchArgs, defaultAgent, installed } from '../src/agents.ts';

test('codex gets its hooks as -c overrides, the permission hook held for an hour', () => {
  const { args, env } = launchArgs('codex', { home: '/h', task: 'fix it' });
  assert.deepEqual(env, {});
  assert.deepEqual(args.slice(-2), ['--', 'fix it']);
  const perm = args.find((a) => a.startsWith('hooks.PermissionRequest='));
  assert.match(perm!, /^hooks\.PermissionRequest=\[\{hooks=\[\{type="command",command=".*\/bin\/aw-hook codex",timeout=3600\}\]\}\]$/);
  assert.ok(args.includes('-c'));
  assert.ok(!args.some((a) => a.startsWith('hooks.Notification=')), 'Codex has no Notification event');
  assert.deepEqual(launchArgs('codex', { task: '' }).args, [], 'no home, no hooks');
});

test('qwen reads the hooks from a settings file named in its env', () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-agents-'));
  const { args, env } = launchArgs('qwen', { home, task: 'fix it' });
  assert.deepEqual(args, ['-i', 'fix it']);
  const hooks = JSON.parse(readFileSync(env.QWEN_CODE_SYSTEM_SETTINGS_PATH, 'utf8')).hooks;
  assert.match(hooks.Stop[0].hooks[0].command, /aw-hook qwen$/);
  assert.equal(hooks.PermissionRequest[0].hooks[0].timeout, 3600);
});

test('claude keeps its own flags', () => {
  assert.deepEqual(launchArgs('claude', { home: '/h', resume: 'abc', permissionMode: 'plan', task: 'x' }).args,
    ['--resume', 'abc', '--permission-mode', 'plan', '--settings', '/h/hooks.json', '--', 'x']);
});

test('the default falls back to claude when unset, unknown or not installed', () => {
  assert.equal(defaultAgent(undefined, () => true), 'claude');
  assert.equal(defaultAgent('gemini', () => true), 'claude');
  assert.equal(defaultAgent('codex', () => false), 'claude');
  assert.equal(defaultAgent('codex', () => true), 'codex');
  assert.equal(installed('sh', '/nope:/bin'), true);
  assert.equal(installed('definitely-not-a-cli', '/bin'), false);
});
