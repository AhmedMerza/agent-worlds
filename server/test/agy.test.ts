import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { launchArgs, writeAgyHooks } from '../src/agents.ts';
import { fromAgy, toAgy, lastStep, agyHooksDir } from '../src/agy.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'awtest-')));
const TOKEN = 'a'.repeat(64);
// agy's transcripts are only read under ~/.gemini/antigravity-cli: a home of our own holds the test's
process.env.HOME = tmp();

/** A transcript_full.jsonl under agy's folder in $HOME, as agy writes it. */
function transcript(steps: object[]): string {
  const dir = join(process.env.HOME!, '.gemini', 'antigravity-cli', 'brain', 'c1', '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript_full.jsonl');
  writeFileSync(file, steps.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return file;
}

test('agy payloads become Claude-shaped events, in the project rather than our hooks folder', () => {
  const hooks = '/h/agy-hooks';
  const base = { conversationId: 'c1', workspacePaths: [hooks, '/r'], transcriptPath: '', modelName: 'gemini-3.8-flash-high' };
  assert.deepEqual(fromAgy(base, 'SessionStart', hooks), { session_id: 'c1', cwd: '/r', transcript_path: '', model: 'gemini-3.8-flash-high', hook_event_name: 'SessionStart' });
  const run = fromAgy({ ...base, toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: '/r' } } }, 'PreToolUse', hooks);
  assert.deepEqual([run?.hook_event_name, run?.tool_name, run?.tool_input], ['PreToolUse', 'Bash', { command: 'npm test', cwd: '/r' }]);
  const edit = fromAgy({ ...base, toolCall: { name: 'replace_file_content', args: { TargetFile: '/r/a' } } }, 'PreToolUse', hooks);
  assert.deepEqual([edit?.tool_name, edit?.tool_input], ['Edit', { file_path: '/r/a' }]);
  assert.equal(fromAgy({ ...base, toolCall: { name: 'manage_task', args: { Action: 'list' } } }, 'PreToolUse', hooks)?.tool_name, 'manage_task', 'an unknown tool keeps its name');
  assert.equal(fromAgy({ ...base, error: '', toolCall: { name: 'view_file', args: {} } }, 'PostToolUse', hooks)?.hook_event_name, 'PostToolUse');
  assert.equal(fromAgy({ ...base, error: 'exit status 1', toolCall: { name: 'run_command', args: {} } }, 'PostToolUse', hooks)?.hook_event_name, 'PostToolUseFailure');
  assert.equal(fromAgy({ ...base, invocationNum: 1 }, 'PreInvocation', hooks), null, 'only the first model call of a turn is a prompt');
  assert.equal(fromAgy({ ...base, terminationReason: 'USER_CANCELED' }, 'Stop', hooks)?.hook_event_name, 'Interrupt');
  assert.deepEqual(fromAgy({ ...base, terminationReason: 'ERROR', error: 'quota' }, 'Stop', hooks)?.error, 'quota');
  assert.equal(fromAgy(base, 'PostInvocation', hooks), null);
  assert.equal(fromAgy(base, undefined, hooks), null, 'no event named');
  assert.equal(fromAgy({ ...base, modelName: 'auto' }, 'SessionStart', hooks)?.model, undefined);
  // In a folder it does not trust yet, agy starts with our folder alone: the project comes from aw-hook
  assert.equal(fromAgy({ ...base, workspacePaths: [hooks] }, 'SessionStart', hooks, '/r2')?.cwd, '/r2');
  assert.equal(fromAgy({ ...base, workspacePaths: [hooks] }, 'SessionStart', hooks, 'relative')?.cwd, undefined);

  const note = JSON.parse(toAgy({ hook_event_name: 'SessionStart', cwd: '/r' }, hooks)).injectSteps[0].systemMessage.systemMessage;
  assert.match(note, /project you are working on is \/r/);
  assert.match(note, /\/h\/agy-hooks belongs to Agent Worlds/);
  // agy takes anything but an empty reply to a tool event as a deny
  for (const ev of ['PreToolUse', 'PostToolUse', 'Stop']) assert.equal(toAgy({ hook_event_name: ev, cwd: '/r' }, hooks), '');
});

test('the prompt and the last answer come from agy\'s transcript, and only from its own folder', () => {
  const file = transcript([
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>\nFix the build\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\ntime\n</ADDITIONAL_METADATA>' },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: 'Looking.' },
    { step_index: 3, type: 'GENERIC' },
    { step_index: 4, type: 'PLANNER_RESPONSE', content: 'Fixed it.' },
  ]);
  const base = { conversationId: 'c1', workspacePaths: ['/r'], transcriptPath: file };
  assert.equal(fromAgy({ ...base, invocationNum: 0 }, 'PreInvocation', '/h')?.prompt, 'Fix the build');
  assert.equal(fromAgy({ ...base, terminationReason: 'NO_TOOL_CALL' }, 'Stop', '/h')?.last_assistant_message, 'Fixed it.');
  const elsewhere = join(tmp(), 'transcript_full.jsonl');
  writeFileSync(elsewhere, readFileSync(file));
  assert.equal(lastStep(elsewhere, 'PLANNER_RESPONSE'), '', 'a path outside ~/.gemini/antigravity-cli is not read');
  assert.equal(lastStep(join(process.env.HOME!, '.gemini', 'antigravity-cli', '..', 'x'), 'PLANNER_RESPONSE'), '');
});

test('agy sessions get our hooks folder added to the workspace, one hook per event naming it', () => {
  const home = tmp();
  const { args, env } = launchArgs('agy', { home, task: 'fix it', dir: '/r' });
  assert.deepEqual([args, env], [['--add-dir', agyHooksDir(home), '-i', 'fix it'], { AGENT_WORLDS_DIR: '/r' }]);
  assert.deepEqual(launchArgs('agy', { task: '' }).args, [], 'no home, no hooks');
  const { aw } = JSON.parse(readFileSync(join(writeAgyHooks(home), '.agents', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(aw), ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop']);
  assert.match(aw.SessionStart[0].command, /bin\/aw-hook agy SessionStart$/);
  assert.equal(aw.PreToolUse[0].matcher, '*');
  assert.match(aw.PreToolUse[0].hooks[0].command, /aw-hook agy PreToolUse$/);
  assert.equal(aw.Stop[0].timeout, 10, 'seconds');
});

test('an agy session: tool use shows on its card, the project note goes back, the turn end is done', async () => {
  const repo = tmp(), home = tmp();
  const cfg = { ...parseConfig({ worlds: [{ id: 'web', name: 'Web', repos: [repo] }] }), port: 0 };
  const app = startServer(cfg, TOKEN, {
    home, procRoot: join(tmp(), 'none'),
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' },
  } as any);
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const file = transcript([{ type: 'USER_INPUT', content: '<USER_REQUEST>\nlist files\n</USER_REQUEST>' }, { type: 'PLANNER_RESPONSE', content: 'MARKER_PROJ' }]);
  const hook = (event: string, b: object = {}) => fetch(`${base}/api/hook`, {
    method: 'POST',
    headers: { 'x-aw-token': TOKEN, 'content-type': 'application/json', 'x-aw-agent': 'agy', 'x-aw-event': event, 'x-aw-pane': '%7' },
    body: JSON.stringify({ conversationId: 'agy-1', workspacePaths: [agyHooksDir(home), repo], transcriptPath: file, ...b }),
  });
  const session = async () => ((await (await fetch(`${base}/api/state`, { headers: { 'x-aw-token': TOKEN } })).json()) as any).sessions.find((s: any) => s.id === 'agy-1');
  try {
    const start = await hook('SessionStart');
    assert.equal(start.status, 200);
    assert.match(JSON.stringify(await start.json()), new RegExp(`working on is ${repo}`));
    assert.deepEqual([(await session()).agent, (await session()).cwd], ['agy', repo]);
    assert.equal((await hook('PreInvocation', { invocationNum: 0 })).status, 204);
    assert.equal((await session()).task, 'list files');
    const pre = await hook('PreToolUse', { toolCall: { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } } });
    assert.deepEqual([pre.status, await pre.text()], [204, ''], 'no answer: agy decides');
    assert.deepEqual([(await session()).state, (await session()).now], ['working', 'Bash: ls']);
    await hook('PostToolUse', { error: '', toolCall: { name: 'run_command', args: { CommandLine: 'ls', Cwd: repo } } });
    assert.equal((await hook('Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true })).status, 204);
    const s = await session();
    assert.deepEqual([s.state, s.card.kind, s.card.summary], ['done', 'done', 'MARKER_PROJ']);
  } finally { await app.close(); }
});
