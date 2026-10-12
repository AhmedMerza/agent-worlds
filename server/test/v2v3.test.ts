import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { riskOf, ruleFor, ruleText, addAllowRule, Stats } from '../src/rules.ts';
import { computeConflicts, issueOf } from '../src/conflicts.ts';
import { readTail, readHead, contextOf, firstPrompt, excerpt } from '../src/transcript.ts';
import { reviewOf, testLine, TEST_RE } from '../src/review.ts';
import { Store } from '../src/store.ts';
import { Insights, runClaude } from '../src/insights.ts';
import { parseConfig } from '../src/config.ts';
import { createSession } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { ev } from './fixtures.ts';
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

// ---------- rules ----------

test('risky: pushes, database changes, deploys, writes outside the project', () => {
  const r = (command: string) => riskOf('Bash', { command });
  assert.equal(r('git push'), 'pushes to a remote');
  assert.equal(r('git push origin feature'), 'pushes to a remote');
  for (const c of ['php artisan migrate', 'php artisan migrate:fresh --seed', 'php artisan db:wipe', 'php artisan db:seed', 'bin/shop setup:upgrade', 'npx prisma migrate dev', 'psql -c "DROP TABLE users"', 'mysql -e "truncate table x"']) {
    assert.equal(r(c), 'changes a database', c);
  }
  assert.equal(r('./scripts/deploy.sh --only=build'), 'runs a deploy');
  assert.equal(r('npm run deploy'), 'runs a deploy');
  assert.equal(r('npm test'), null);
  assert.equal(r('git status'), null);
  assert.equal(riskOf('Write', { file_path: '/etc/hosts' }, '/work/repo-a'), 'writes outside the project');
  assert.equal(riskOf('Edit', { file_path: '/work/repo-ab/x' }, '/work/repo-a'), 'writes outside the project', 'sibling prefix is outside');
  assert.equal(riskOf('Write', { file_path: '/work/repo-a/src/x.ts' }, '/work/repo-a'), null);
  assert.equal(riskOf('Write', { file_path: 'src/x.ts' }, '/work/repo-a'), null);
  assert.equal(riskOf('Read', { file_path: '/etc/hosts' }, '/work/repo-a'), null, 'reads are not writes');
});

test('ruleFor: prefers Claude\'s suggestion, else an exact rule in permission syntax', () => {
  const sugg = [{ type: 'addDirectories', directories: ['/x'] }, { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm run lint *' }], behavior: 'allow', destination: 'localSettings' }];
  assert.equal(ruleText(ruleFor('Bash', { command: 'npm run lint -- --fix' }, sugg)), 'Bash(npm run lint *)');
  assert.equal(ruleText(ruleFor('Bash', { command: 'touch a' }, [{ type: 'setMode', mode: 'acceptEdits' }])), 'Bash(touch a)');
  assert.equal(ruleText(ruleFor('Write', { file_path: '/w/repo/a.ts' }, undefined)), 'Edit(//w/repo/a.ts)');
  assert.equal(ruleText(ruleFor('Read', { file_path: '/w/repo/a.ts' }, undefined)), 'Read(//w/repo/a.ts)');
  assert.equal(ruleText(ruleFor('WebFetch', { url: 'https://docs.example.com/x' }, null)), 'WebFetch(domain:docs.example.com)');
  assert.equal(ruleText(ruleFor('WebSearch', { query: 'x' }, null)), 'WebSearch');
});

test('addAllowRule keeps other content, never duplicates, refuses invalid JSON', () => {
  const d = tmp();
  const f = join(d, '.claude', 'settings.local.json');
  addAllowRule(f, 'Bash(npm test)');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { permissions: { allow: ['Bash(npm test)'] } });

  writeFileSync(f, JSON.stringify({ model: 'x', hooks: { Stop: [] }, permissions: { allow: ['Read'], deny: ['Bash(rm *)'], defaultMode: 'default' } }));
  addAllowRule(f, 'Bash(npm test)');
  addAllowRule(f, 'Bash(npm test)');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { model: 'x', hooks: { Stop: [] }, permissions: { allow: ['Read', 'Bash(npm test)'], deny: ['Bash(rm *)'], defaultMode: 'default' } });
  assert.deepEqual(readdirSync(join(d, '.claude')), ['settings.local.json'], 'no temp file left behind');

  writeFileSync(f, '{ "permissions": { // a comment\n } }');
  assert.throws(() => addAllowRule(f, 'Bash(x)'), /not valid JSON/);
  assert.equal(readFileSync(f, 'utf8'), '{ "permissions": { // a comment\n } }', 'left untouched');
  writeFileSync(f, '{"permissions":{"allow":"Read"}}');
  assert.throws(() => addAllowRule(f, 'Bash(x)'), /not an array/);
});

test('Stats persist per repo and rule', () => {
  const d = tmp();
  const s = new Stats(join(d, 'stats.json'));
  assert.equal(s.inc('/r', 'Bash(x)'), 1);
  assert.equal(s.inc('/r', 'Bash(x)'), 2);
  assert.equal(new Stats(join(d, 'stats.json')).get('/r', 'Bash(x)'), 2);
  assert.equal(new Stats(join(d, 'missing', 'stats.json')).get('/r', 'Bash(x)'), 0);
});

// ---------- scopes ----------

test('scope repo / world / all write the right settings files and tell Claude for this session', async () => {
  const root = tmp();
  const { store } = setup(root);
  const decideWith = async (scope: string) => {
    const held = store.handle(ev.permBash, null);
    await tick();
    assert.equal(store.decide('sess-1', { requestId: card(store).requestId, decision: 'allow', scope }), null);
    return JSON.parse(await held).hookSpecificOutput.decision;
  };
  const d = await decideWith('repo');
  assert.deepEqual(d.updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch hello.txt' }], behavior: 'allow', destination: 'session' }]);
  const allow = (f: string) => JSON.parse(readFileSync(f, 'utf8')).permissions.allow;
  assert.deepEqual(allow(`${root}/repo-a/.claude/settings.local.json`), ['Bash(touch hello.txt)']);
  assert.equal(existsSync(`${root}/repo-b/.claude/settings.local.json`), false);

  await decideWith('world');
  assert.deepEqual(allow(`${root}/repo-b/.claude/settings.local.json`), ['Bash(touch hello.txt)']);
  assert.deepEqual(allow(`${root}/repo-a/.claude/settings.local.json`), ['Bash(touch hello.txt)'], 'no duplicate');

  writeFileSync(join(root, 'user-settings.json'), JSON.stringify({ theme: 'dark' }));
  await decideWith('all');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'user-settings.json'), 'utf8')), { theme: 'dark', permissions: { allow: ['Bash(touch hello.txt)'] } });

  // seenCount: times this rule was allowed in this repo, across sessions
  store.handle({ ...ev.permBash, session_id: 'sess-9' }, null);
  await tick();
  assert.equal(card(store, 'sess-9').seenCount, 3);
});

test('scope all is refused for risky requests; nothing written, request still pending', async () => {
  const root = tmp();
  const { store } = setup(root);
  const push = { ...ev.permBash, tool_input: { command: 'git push origin main' } };
  const held = store.handle(push, null);
  await tick();
  const c = card(store);
  assert.equal(c.risky, 'pushes to a remote');
  const err = store.decide('sess-1', { requestId: c.requestId, decision: 'allow', scope: 'all' });
  assert.equal(err?.[0], 400);
  assert.match(err![1], /pushes to a remote/);
  assert.equal(existsSync(join(root, 'user-settings.json')), false);
  assert.equal(card(store).live, true);
  assert.equal(store.decide('sess-1', { requestId: c.requestId, decision: 'allow', scope: 'once' }), null);
  await held;
});

test('a broken settings file fails the decision with 500 and keeps the request', async () => {
  const root = tmp();
  const { store } = setup(root);
  mkdirSync(`${root}/repo-a/.claude`, { recursive: true });
  writeFileSync(`${root}/repo-a/.claude/settings.local.json`, '{oops');
  store.handle(ev.permBash, null);
  await tick();
  const err = store.decide('sess-1', { requestId: card(store).requestId, decision: 'allow', scope: 'repo' });
  assert.equal(err?.[0], 500);
  assert.equal(card(store).kind, 'permission');
});

test('scope world needs a world', async () => {
  const root = tmp();
  const { store } = setup(root);
  store.handle({ ...ev.permBash, cwd: '/elsewhere' }, null);
  await tick();
  assert.equal(store.decide('sess-1', { requestId: card(store).requestId, decision: 'allow', scope: 'world' })?.[0], 400);
});

// ---------- conflicts ----------

test('conflict rules', () => {
  const base = { repo: '/r', worktree: false, testing: false };
  const c = computeConflicts([
    { id: 'a', cwd: '/r', branch: 'main', ...base },
    { id: 'b', cwd: '/r', branch: 'main', ...base },
    { id: 'c', cwd: '/r/sub', branch: 'main', ...base },
    { id: 'd', cwd: '/r-wt/x', branch: 'feat/53-login', ...base, worktree: true, testing: true },
    { id: 'e', cwd: '/r-wt/y', branch: 'fix-53-logout', ...base, worktree: true, testing: true },
    { id: 'f', cwd: '/q', branch: 'main', repo: '/q', worktree: false, testing: true },
  ]);
  assert.deepEqual(c.get('a'), [{ withId: 'b', reason: 'same folder' }, { withId: 'c', reason: 'same branch main' }]);
  assert.deepEqual(c.get('d'), [{ withId: 'e', reason: 'shared database: tests in both; same issue #53' }]);
  assert.deepEqual(c.get('f'), []);
  assert.equal(issueOf('feat/53-login'), '53');
  assert.equal(issueOf('fix-#120'), '120');
  assert.equal(issueOf('issue-7-x'), '7');
  assert.equal(issueOf('main'), null);
  assert.equal(issueOf('v2'), null);
  assert.equal(issueOf(null), null);
});

test('store recomputes conflicts and broadcasts both sides; removal clears them', async () => {
  const { store, emitted } = setup(tmp(), { clients: false });
  await store.handle(ev.start, null);
  await store.handle({ ...ev.start, session_id: 'sess-2' }, null);
  const view = (id: string) => store.list().find((s: any) => s.id === id) as any;
  assert.deepEqual(view('sess-1').conflicts, [{ withId: 'sess-2', reason: 'same folder' }]);
  assert.ok(emitted.some((e) => e.type === 'session' && e.session.id === 'sess-1' && e.session.conflicts.length === 1), 'the other side is broadcast too');

  // tests running in both at once
  await store.handle({ ...ev.preBash, tool_input: { command: 'npm test' }, tool_use_id: 't1' }, null);
  await store.handle({ ...ev.preBash, session_id: 'sess-2', tool_input: { command: 'php artisan test' }, tool_use_id: 't2' }, null);
  assert.equal(view('sess-1').conflicts[0].reason, 'same folder; shared database: tests in both');
  await store.handle({ ...ev.postBash, tool_input: { command: 'npm test' }, tool_use_id: 't1', tool_response: { stdout: 'Tests: 12 passed\nDone in 3s', stderr: '' } }, null);
  assert.equal(view('sess-1').conflicts[0].reason, 'same folder');

  await store.handle({ ...ev.end, session_id: 'sess-2' }, null);
  assert.deepEqual(view('sess-1').conflicts, []);
});

// ---------- transcript / context ----------

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
  assert.equal(excerpt(all), 'USER: Add a login page\nTOOL Bash: npm test\nASSISTANT: Added the page. Tests pass.\n');
  assert.ok(excerpt(all, 40).length <= 40, 'excerpt respects the cap, newest kept');
  const big = transcript(tmp(), { input_tokens: 1, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 });
  assert.deepEqual(contextOf(await readTail(big, 1 << 20), null, 200_000), { used: 300_001, limit: 1_000_000, pct: 30 }, 'usage past the configured window proves a bigger one');
  // a tail read that starts mid-line skips the cut line
  const tail = await readTail(f, 200);
  assert.ok(tail.length >= 1 && tail.every((e) => typeof e.type === 'string'));
  assert.deepEqual(contextOf([], null), null);
});

// ---------- review ----------

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

// ---------- catch-up ----------

function stubClaude(dir: string, body: string): string {
  const f = join(dir, 'claude-stub');
  writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

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
  const before = { ...s1.catchup! };
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
  const cfg = parseConfig({});
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

// ---------- new sessions ----------

test('createSession: worktree on a new branch, tmux session in it', async () => {
  const repo = gitRepo();
  const bin = stubClaude(tmp(), 'sleep 30');
  const r = await createSession({ repo, task: 'Fix the login bug!', worktree: true, claudeBin: bin, prefix: 'awtest-' });
  try {
    assert.match(r.branch!, /^aw\/fix-the-login-bug-[0-9a-f]{4}$/);
    assert.equal(r.dir, join(`${repo}-worktrees`, r.branch!.replace(/\//g, '-')));
    assert.equal(git(r.dir, 'branch', '--show-current').trim(), r.branch);
    assert.match(r.tmuxSession, /^awtest-awtest-[a-z0-9]+-[0-9a-f]{4}$/);
    assert.equal(execFileSync('tmux', ['display-message', '-p', '-t', '=' + r.tmuxSession + ':', '#{pane_current_path}']).toString().trim(), r.dir);
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', '=' + r.tmuxSession]); } catch { /* already gone */ }
  }
  await assert.rejects(createSession({ repo, task: '', worktree: true, branch: 'bad..name', prefix: 'awtest-' }), /invalid branch/);
  await assert.rejects(createSession({ repo, task: '', worktree: true, branch: r.branch!, prefix: 'awtest-' }), /worktree add failed/);
});

test('POST /api/sessions validates, PWA files are public, multiple listen addresses', async () => {
  const root = tmp();
  const dist = tmp();
  writeFileSync(join(dist, 'index.html'), 'app');
  writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"x"}');
  writeFileSync(join(dist, 'icon-192.png'), 'png');
  const calls: any[] = [];
  // a free port (the fixed test slot may be busy with another run)
  const port = await new Promise<number>((ok) => { const s = createNetServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });
  const cfg = { ...parseConfig({ listen: ['127.0.0.1', '127.0.0.2'], worlds: [{ id: 'web', name: 'Web', repos: [`${root}/repo-a`] }] }), port };
  const app = startServer(cfg, 'k'.repeat(64), {
    webDist: dist, home: root,
    createSession: async (o) => { calls.push(o); if (o.branch === 'boom') throw new Error('git worktree add failed: nope'); return { tmuxSession: 'aw-x-1', dir: o.repo, branch: null }; },
  });
  await app.listen();
  try {
    const H = { 'x-aw-token': 'k'.repeat(64), 'content-type': 'application/json' };
    const post = (b: unknown) => fetch(`http://127.0.0.1:${port}/api/sessions`, { method: 'POST', headers: H, body: JSON.stringify(b) });
    assert.equal((await post({ worldId: 'nope', repo: `${root}/repo-a` })).status, 400);
    assert.equal((await post({ worldId: 'web', repo: '/etc' })).status, 400);
    assert.equal((await post({ worldId: 'web', repo: `${root}/repo-a`, task: 5 })).status, 400);
    assert.equal((await post({ worldId: 'web', repo: `${root}/repo-a`, branch: 'x', worktree: false })).status, 400);
    const ok = await post({ worldId: 'web', repo: `${root}/repo-a`, task: 'do it', worktree: true });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { tmuxSession: 'aw-x-1' });
    assert.deepEqual(calls[0], { repo: `${root}/repo-a`, task: 'do it', worktree: true, branch: undefined, claudeBin: 'claude', home: root, prefix: undefined });
    const bad = await post({ worldId: 'web', repo: `${root}/repo-a`, worktree: true, branch: 'boom' });
    assert.equal(bad.status, 422);
    assert.match((await bad.json()).error, /worktree add failed/);
    const st = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: H })).json() as any;
    assert.deepEqual(st.worlds[0].repos, [`${root}/repo-a`]);

    const m = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    assert.equal(m.status, 200);
    assert.equal(m.headers.get('content-type'), 'application/manifest+json');
    assert.equal((await fetch(`http://127.0.0.1:${port}/icon-192.png`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/icon-512.png`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/index.html`)).status, 401, 'the app itself stays authed');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);

    assert.equal((await fetch(`http://127.0.0.2:${port}/api/state`, { headers: H })).status, 200, 'second listen address works');
    assert.equal((await fetch(`http://127.0.0.2:${port}/api/state`, { headers: { ...H, origin: `http://127.0.0.2:${port}` } })).status, 200, 'its origin is allowed');

    // catch-up endpoint
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/sessions/nope/catchup`, { method: 'POST', headers: H })).status, 404);
  } finally { await app.close(); }
});

test('config: listen, userSettingsPath, claudeBin', () => {
  assert.deepEqual(parseConfig({}).listen, ['127.0.0.1']);
  const c = parseConfig({ listen: ['127.0.0.1', '100.64.0.5'], userSettingsPath: '~/x/settings.json', claudeBin: '/opt/claude' });
  assert.equal(c.host, '127.0.0.1');
  assert.match(c.userSettingsPath, /^\/.*\/x\/settings\.json$/);
  assert.equal(c.claudeBin, '/opt/claude');
  assert.throws(() => parseConfig({ listen: [] }), /listen/);
  assert.throws(() => parseConfig({ claudeBin: 5 }), /claudeBin/);
  assert.equal(parseConfig({}).contextLimit, 1_000_000);
  assert.equal(parseConfig({ contextLimit: 200_000 }).contextLimit, 200_000);
  assert.throws(() => parseConfig({ contextLimit: 'big' }), /contextLimit/);
});
