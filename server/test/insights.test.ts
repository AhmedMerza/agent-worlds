import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { riskOf, ruleFor, ruleText, addAllowRule, Stats } from '../src/rules.ts';
import { computeConflicts, issueOf } from '../src/conflicts.ts';
import { readTail, readHead, contextOf, firstPrompt, excerpt, slashCommand, conversation } from '../src/transcript.ts';
import { reviewOf, testLine, TEST_RE } from '../src/review.ts';
import { Store } from '../src/store.ts';
import { Insights, runClaude } from '../src/insights.ts';
import { parseConfig } from '../src/config.ts';
import { createSession } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { ev, stubClaude } from './fixtures.ts';
import { createServer as createNetServer } from 'node:net';

const tmp = (p = 'awtest-') => realpathSync(mkdtempSync(join(tmpdir(), p)));
const tick = () => new Promise((r) => setImmediate(r));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString();
function gitRepo(): string {
  const d = tmp();
  git(d, 'init', '-q', '-b', 'main');
  git(d, 'config', 'user.email', 't@example.com');
  git(d, 'config', 'user.name', 'T');
  writeFileSync(join(d, 'a.txt'), 'one\ntwo\n');
  git(d, 'add', '.');
  git(d, 'commit', '-q', '-m', 'init');
  return d;
}

function setup(root: string, opts: { clients?: boolean; userSettingsPath?: string } = {}) {
  const emitted: any[] = [];
  const cfg = parseConfig({
    worlds: [{ id: 'web', name: 'Web', repos: [`${root}/repo-a`, `${root}/repo-b`] }],
    userSettingsPath: opts.userSettingsPath ?? join(root, 'user-settings.json'),
    claudeProjectsDir: realpathSync(tmpdir()),
  });
  const stats = new Stats(join(root, 'stats.json'));
  const store = new Store(cfg, {
    repoInfo: async (cwd) => {
      const m = cwd.match(/^\/work\/(repo-[ab])(\/.*)?$/);
      const repo = m ? `${root}/${m[1]}` : cwd;
      return { repo, branch: 'main', worktree: false, top: repo };
    },
    branchOf: async () => 'main',
    tmuxSessionOf: async () => null,
    clientsConnected: () => opts.clients ?? true,
    holdMs: 10_000,
    stats,
  }, (e) => emitted.push(e));
  return { store, emitted, cfg, stats };
}
const card = (store: Store, id = 'sess-1') => (store.list().find((s: any) => s.id === id) as any).card;

const line = (o: unknown) => JSON.stringify(o) + '\n';
function transcript(dir: string, usage = { input_tokens: 10, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000 }) {
  const f = join(dir, 't.jsonl');
  writeFileSync(f,
    line({ type: 'mode' }) +
    line({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } }) +
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } }) +
    line({ type: 'user', message: { role: 'user', content: 'Add a login page' } }) +
    line({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 } } }) +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }) +
    line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'side' }], usage: { input_tokens: 999_999 } } }) +
    line({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku', content: [{ type: 'text', text: 'Added the page. Tests pass.' }], usage } }) +
    line({ type: 'system', subtype: 'turn_duration' }));
  return f;
}

test('transcript: first real prompt, context from the last usage, excerpt', async () => {
  const f = transcript(tmp());
  const all = await readTail(f, 1 << 20);
  assert.equal(firstPrompt(await readHead(f, 1 << 20)), 'Add a login page');
  assert.deepEqual(contextOf(all, 'claude-haiku'), { used: 50_010, limit: 1_000_000, pct: 5 }, 'default window is 1M');
  assert.deepEqual(contextOf(all, 'claude-haiku', 200_000), { used: 50_010, limit: 200_000, pct: 25 }, 'configured window');
  assert.equal(contextOf(all, 'claude-opus[1m]', 200_000)!.limit, 1_000_000, '[1m] model id proves a 1M window');
  assert.equal(excerpt(all), 'USER: /clear\nUSER: Add a login page\nTOOL Bash: npm test\nASSISTANT: Added the page. Tests pass.\n', 'a slash command you typed is a turn of yours');
  const cmd = (content: string) => ({ type: 'user', message: { role: 'user', content } }) as any;
  assert.equal(slashCommand(cmd('<command-name>/root-cause</command-name>\n<command-message>root-cause</command-message>\n<command-args>checkout totals drift</command-args>')), '/root-cause checkout totals drift');
  assert.equal(slashCommand(cmd('<command-name>/commit</command-name><command-args></command-args>')), '/commit');
  assert.equal(slashCommand(cmd('<local-command-stdout>ok</local-command-stdout>')), null, 'command output is not a command');
  assert.equal(slashCommand(cmd('<command-message>ship-check is running…</command-message>\n<command-name>/ship-check</command-name>\n<command-args>--deep</command-args>')), '/ship-check --deep', 'skills write the message first');
  assert.equal(slashCommand({ ...cmd('<command-name>/x</command-name>'), isMeta: true }), null, 'meta entries are not yours');
  assert.equal(slashCommand(cmd('see <command-name>/x</command-name>')), null, 'only an entry that is the command, not text quoting one');
  assert.deepEqual(conversation([cmd('<command-message>c</command-message><command-name>/commit</command-name>')]), [{ who: 'you', text: '/commit' }], 'the chat shows it as your turn');
  assert.ok(excerpt(all, 40).length <= 40, 'excerpt respects the cap, newest kept');
  const big = transcript(tmp(), { input_tokens: 1, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 });
  assert.deepEqual(contextOf(await readTail(big, 1 << 20), null, 200_000), { used: 300_001, limit: 1_000_000, pct: 30 }, 'usage past the configured window proves a bigger one');
  // a tail read that starts mid-line skips the cut line
  const tail = await readTail(f, 200);
  assert.ok(tail.length >= 1 && tail.every((e) => typeof e.type === 'string'));
  assert.deepEqual(contextOf([], null), null);
});

test('review: commits ahead of main + uncommitted + untracked, capped diff, tests line', async () => {
  const d = gitRepo();
  git(d, 'checkout', '-q', '-b', 'feat');
  writeFileSync(join(d, 'b.txt'), 'b1\nb2\nb3\n');
  git(d, 'add', 'b.txt');
  git(d, 'commit', '-q', '-m', 'b');
  writeFileSync(join(d, 'a.txt'), 'one\nTWO\n');           // uncommitted change
  writeFileSync(join(d, 'new.txt'), 'n\n');                 // untracked
  const tests = { command: 'npm test', ok: true, line: 'Tests: 3 passed' };
  const r = (await reviewOf(d, tests))!;
  const byPath = Object.fromEntries(r.files.map((f) => [f.path, [f.added, f.deleted]]));
  assert.deepEqual(byPath, { 'a.txt': [1, 1], 'b.txt': [3, 0], 'new.txt': [1, 0] });
  assert.match(r.diff, /\+TWO/);
  assert.match(r.diff, /\+b3/);
  assert.match(r.diff, /\+n/);
  assert.deepEqual(r.tests, tests);

  writeFileSync(join(d, 'huge.txt'), 'x'.repeat(100) + '\n'.repeat(1) + ('y'.repeat(99) + '\n').repeat(3000));
  const big = (await reviewOf(d, null))!;
  assert.ok(big.diff.length <= 200 * 1024 + 100);
  assert.match(big.diff, /truncated/);

  assert.equal(await reviewOf(tmp(), null), null, 'not a git repo');
});

test('test commands are recognised and summarised', async () => {
  for (const c of ['php artisan test --filter=X', 'vendor/bin/phpunit', 'npx vitest run', 'npm test', 'npm run test', 'pytest -q', 'go test ./...', 'flutter test', 'cargo test', 'node --test']) assert.ok(TEST_RE.test(c), c);
  for (const c of ['npm install', 'git status', 'ls tests/']) assert.ok(!TEST_RE.test(c), c);
  assert.equal(testLine('\x1b[32mrunning\x1b[0m\nTests:  2 failed, 10 passed\nTime: 3s\n'), 'Tests:  2 failed, 10 passed');
  assert.equal(testLine('ℹ tests 5\nℹ pass 2\nℹ fail 1\nℹ duration_ms 50'), 'pass 2, fail 1', 'node --test: pass/fail, not the subtest count');
  assert.equal(testLine('Test Files  1 passed (1)\n     Tests  4 passed (4)'), '     Tests  4 passed (4)'.trim());

  const { store } = setup(tmp(), { clients: false });
  await store.handle({ ...ev.postBash, hook_event_name: 'PostToolUseFailure', tool_input: { command: 'npm test' }, error: 'Exit code 1\nFAIL 1 failed', tool_response: undefined }, null);
  assert.deepEqual(store.sessions.get('sess-1')!.tests, { command: 'npm test', ok: false, line: 'FAIL 1 failed' });
});

test('runClaude: passes AGENT_WORLDS_DISABLE=1, the schema flags and the transcript; reads structured_output', async () => {
  const d = tmp();
  const bin = stubClaude(d, `in=$(cat); printf '{"type":"result","is_error":false,"structured_output":{"did":"%s|%s","needs":""}}' "$AGENT_WORLDS_DISABLE" "$(printf '%s' "$*" | grep -o -- '--json-schema' | head -1)"; printf '%s' "$in" > ${d}/stdin`);
  assert.deepEqual(await runClaude(bin, 'USER: hi'), { did: '1|--json-schema', needs: '' });
  assert.match(readFileSync(join(d, 'stdin'), 'utf8'), /USER: hi/);
  await assert.rejects(runClaude(stubClaude(d, 'echo nope >&2; exit 3'), 'x'), /exited 3/);
  await assert.rejects(runClaude(stubClaude(d, 'echo "{\\"is_error\\":true}"'), 'x'), /unreadable/);
  await assert.rejects(runClaude(join(d, 'missing'), 'x'));
});

test('catch-up: manual, one at a time per session, max 2 concurrent, failures keep the old one', async () => {
  const root = tmp();
  const { store } = setup(root, { clients: false });
  const f = transcript(root);
  let active = 0, peak = 0, calls = 0, fail = false;
  const gate: (() => void)[] = [];
  const ins = new Insights(store, 'unused', {
    summarise: async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise<void>((r) => gate.push(r));
      active--;
      if (fail) throw new Error('model down');
      return { did: 'Added the page.', needs: '' };
    },
  });
  for (const id of ['s1', 's2', 's3']) await store.handle({ ...ev.stop, session_id: id, transcript_path: f }, null);
  const s1 = store.sessions.get('s1')!;
  assert.equal(s1.catchup, null, 'nothing runs automatically');

  assert.equal(ins.requestCatchup(s1), 'started');
  assert.equal(s1.catchupRunning, true);
  assert.equal(ins.requestCatchup(s1), 'busy');
  ins.requestCatchup(store.sessions.get('s2')!);
  ins.requestCatchup(store.sessions.get('s3')!);
  for (let i = 0; i < 20 && gate.length < 2; i++) await tick();
  assert.equal(peak, 2);
  while (calls < 3 || gate.length) { gate.shift()?.(); await tick(); }
  for (let i = 0; i < 20 && s1.catchupRunning; i++) await tick();
  assert.equal(peak, 2, 'never more than 2 at once');
  assert.deepEqual(s1.catchup, { asked: 'Add a login page', did: 'Added the page.', needs: '' });
  assert.ok(s1.catchupAt! > 0);
  assert.equal(s1.catchupRunning, false);

  fail = true;
  const before = { ...(s1.catchup as object) };
  ins.requestCatchup(s1);
  for (let i = 0; i < 20 && !gate.length; i++) await tick();
  gate.shift()!();
  for (let i = 0; i < 20 && s1.catchupRunning; i++) await tick();
  assert.deepEqual(s1.catchup, before);
  assert.equal(s1.catchupRunning, false);

  const noTranscript = await store.handle({ ...ev.stop, session_id: 's4', transcript_path: undefined }, null);
  void noTranscript;
  assert.equal(ins.requestCatchup(store.sessions.get('s4')!), 'no-transcript');
});

test('context and review are filled on Stop', async () => {
  const d = gitRepo();
  writeFileSync(join(d, 'a.txt'), 'changed\n');
  const cfg = parseConfig({ claudeProjectsDir: realpathSync(tmpdir()) });
  const store = new Store(cfg, {
    repoInfo: async () => ({ repo: d, branch: 'main', worktree: false, top: d }),
    branchOf: async () => 'main', tmuxSessionOf: async () => null, clientsConnected: () => false, holdMs: 1000,
    stats: { get: () => 0, inc: () => 1 },
    onEvent: (s, e) => ins.onEvent(s, e),
  }, () => {});
  const ins = new Insights(store, 'unused', { summarise: async () => ({ did: '', needs: '' }) });
  await store.handle({ ...ev.stop, cwd: d, transcript_path: transcript(tmp()) }, null);
  const s = store.sessions.get('sess-1')!;
  for (let i = 0; i < 100 && !(s.card as any).review; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(s.context, { used: 50_010, limit: 1_000_000, pct: 5 });
  assert.deepEqual((s.card as any).review.files, [{ path: 'a.txt', added: 1, deleted: 2 }]);
});

test('transcript_path outside claudeProjectsDir is ignored (the summariser reads it)', async () => {
  const { store } = setup(tmp());
  await store.handle({ ...ev.stop, transcript_path: '/etc/passwd' }, null);
  assert.ok(!store.sessions.get('sess-1')!.transcriptPath);
  await store.handle({ ...ev.stop, transcript_path: join(realpathSync(tmpdir()), 'x', '..', '..', 'etc', 'a.jsonl') }, null);
  assert.ok(!store.sessions.get('sess-1')!.transcriptPath);
});
