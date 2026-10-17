import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchArgs, defaultAgent, installed, writeKimiHome, AGENTS } from '../src/agents.ts';

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

test('kimi gets a home of its own: the user\'s files linked, their config plus our hooks', () => {
  const home = mkdtempSync(join(tmpdir(), 'aw-agents-'));
  const real = mkdtempSync(join(tmpdir(), 'aw-kimi-'));
  mkdirSync(join(real, 'credentials'));
  writeFileSync(join(real, 'config.toml'), 'default_model = "k3"');
  const dir = writeKimiHome(home, real);
  assert.equal(readlinkSync(join(dir, 'credentials')), join(real, 'credentials'));
  const toml = readFileSync(join(dir, 'config.toml'), 'utf8');
  assert.ok(toml.startsWith('default_model = "k3"\n'), 'the user\'s config comes first');
  assert.match(toml, /\[\[hooks\]\]\nevent = "PermissionRequest"\ncommand = ".*\/bin\/aw-hook kimi"\ntimeout = 10\n/);
  assert.equal(readFileSync(join(real, 'config.toml'), 'utf8'), 'default_model = "k3"', 'the user\'s own config is untouched');
  writeFileSync(join(real, 'workspaces.json'), '{}');
  writeFileSync(join(dir, 'workspaces.json'), '{"mine":1}'); // Kimi replaced our link by renaming over it
  writeKimiHome(home, real); // a second start keeps good links and links the copy again
  assert.equal(readlinkSync(join(dir, 'credentials')), join(real, 'credentials'));
  assert.equal(readlinkSync(join(dir, 'workspaces.json')), join(real, 'workspaces.json'));
  assert.equal(readFileSync(join(dir, 'config.toml'), 'utf8').match(/^\[\[hooks\]\]$/gm)?.length, 14, 'hooks not doubled');
  process.env.KIMI_CODE_HOME = real; // never the user's real ~/.kimi-code
  const { args, env } = launchArgs('kimi', { home, task: 'fix it' });
  assert.deepEqual(args, [], 'kimi takes no starting prompt (the task becomes a -p/-c chain in createSession)');
  assert.equal(env.KIMI_CODE_HOME, dir);
  assert.equal(AGENTS.kimi.task, true, 'a task reaches kimi as `kimi -p … ; kimi -c`');
});

test('kimi home: a first-run user (no Kimi home, or no config.toml) gets only our hooks', () => {
  for (const real of [join(mkdtempSync(join(tmpdir(), 'aw-kimi-')), 'missing'), mkdtempSync(join(tmpdir(), 'aw-kimi-'))]) {
    const toml = readFileSync(join(writeKimiHome(mkdtempSync(join(tmpdir(), 'aw-agents-')), real), 'config.toml'), 'utf8');
    assert.ok(toml.startsWith('\n\n# Added by Agent Worlds'), 'nothing of the user\'s before our block');
    assert.equal(toml.match(/^\[\[hooks\]\]$/gm)?.length, 14);
  }
});

test('kimi home: the user\'s own [[hooks]] stay, ours follow after a blank line', () => {
  const real = mkdtempSync(join(tmpdir(), 'aw-kimi-'));
  const mine = '[[hooks]]\nevent = "Stop"\ncommand = "notify-send done"'; // no trailing newline
  writeFileSync(join(real, 'config.toml'), mine);
  const toml = readFileSync(join(writeKimiHome(mkdtempSync(join(tmpdir(), 'aw-agents-')), real), 'config.toml'), 'utf8');
  assert.ok(toml.startsWith(mine + '\n\n# Added by Agent Worlds'));
  assert.equal(toml.match(/^\[\[hooks\]\]$/gm)?.length, 15);
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
