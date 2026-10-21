import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { riskOf, ruleFor, ruleText, addAllowRule, allowRules, removeAllowRule, Stats } from '../src/rules.ts';
import { computeConflicts, issueOf } from '../src/conflicts.ts';
import { readTail, readHead, contextOf, firstPrompt, excerpt } from '../src/transcript.ts';
import { reviewOf, testLine, TEST_RE } from '../src/review.ts';
import { Store } from '../src/store.ts';
import { Insights, runClaude } from '../src/insights.ts';
import { parseConfig } from '../src/config.ts';
import { createSession } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { ev, tmp } from './fixtures.ts';
import { createServer as createNetServer } from 'node:net';

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

test('saved allow rules can be listed and removed without changing other settings', () => {
  const file = join(tmp(), 'settings.json');
  assert.deepEqual(allowRules(file), []);
  assert.equal(removeAllowRule(file, 'Read'), false);
  writeFileSync(file, JSON.stringify({ theme: 'dark', permissions: { allow: ['Read', 'Bash(npm test)'], deny: ['Bash(rm *)'] } }));
  assert.deepEqual(allowRules(file), ['Read', 'Bash(npm test)']);
  assert.equal(removeAllowRule(file, 'Bash(npm test)'), true);
  assert.equal(removeAllowRule(file, 'Bash(npm test)'), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { theme: 'dark', permissions: { allow: ['Read'], deny: ['Bash(rm *)'] } });
  writeFileSync(file, '{broken');
  assert.throws(() => removeAllowRule(file, 'Read'), /not valid JSON/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('allow-rules API lists configured scopes and removes only the requested rule', async () => {
  const root = tmp();
  const a = join(root, 'a'), b = join(root, 'b'), past = join(root, 'past');
  const global = join(root, 'user-settings.json');
  const file = (repo: string) => join(repo, '.claude', 'settings.local.json');
  addAllowRule(global, 'WebFetch(domain:example.com)');
  for (const repo of [a, b]) { addAllowRule(file(repo), 'Bash(npm test)'); addAllowRule(file(repo), 'Read'); }
  addAllowRule(file(past), 'Bash(git status)');
  new Stats(join(root, 'stats.json')).rememberRepos([past]);
  const cfg = { ...parseConfig({ userSettingsPath: global, worlds: [{ id: 'web', name: 'Web', repos: [a, b] }] }), port: 0 };
  const app = startServer(cfg, 'a'.repeat(64), { home: root });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/allow-rules`;
  const headers = { 'x-aw-token': 'a'.repeat(64), 'content-type': 'application/json' };
  const del = (body: object) => fetch(base, { method: 'DELETE', headers, body: JSON.stringify(body) });
  try {
    const listed = await (await fetch(base, { headers })).json() as any;
    assert.deepEqual(listed.global, ['WebFetch(domain:example.com)']);
    assert.deepEqual(listed.worlds[0].repos.map((r: any) => r.rules), [['Bash(npm test)', 'Read'], ['Bash(npm test)', 'Read']]);
    assert.deepEqual(listed.other, [{ repo: past, rules: ['Bash(git status)'] }]);
    assert.equal((await del({ scope: 'repo', repo: '/not-listed', rule: 'Read' })).status, 400);
    assert.equal((await (await del({ scope: 'world', worldId: 'web', rule: 'Bash(npm test)' })).json() as any).removed, 2);
    assert.deepEqual(allowRules(file(a)), ['Read']);
    assert.deepEqual(allowRules(file(b)), ['Read']);
    assert.deepEqual(allowRules(global), ['WebFetch(domain:example.com)']);
    assert.equal((await (await del({ scope: 'repo', repo: past, rule: 'Bash(git status)' })).json() as any).removed, 1);
    assert.equal((await (await del({ scope: 'all', rule: 'WebFetch(domain:example.com)' })).json() as any).removed, 1);
  } finally { app.close(); }
});

test('Stats persist per repo and rule', () => {
  const d = tmp();
  const s = new Stats(join(d, 'stats.json'));
  assert.equal(s.inc('/r', 'Bash(x)'), 1);
  assert.equal(s.inc('/r', 'Bash(x)'), 2);
  assert.equal(new Stats(join(d, 'stats.json')).get('/r', 'Bash(x)'), 2);
  assert.equal(new Stats(join(d, 'missing', 'stats.json')).get('/r', 'Bash(x)'), 0);
});

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
  assert.ok(Object.hasOwn(new Stats(join(root, 'stats.json')).data, `${root}/repo-b`), 'world target remains discoverable after its session ends');

  writeFileSync(join(root, 'user-settings.json'), JSON.stringify({ theme: 'dark' }));
  store.handle(ev.permBash, null);
  await tick();
  assert.equal(card(store).everywhere, 'Not offered for shell commands.');
  assert.deepEqual(store.decide('sess-1', { requestId: card(store).requestId, decision: 'allow', scope: 'all' }), [400, 'Not offered for shell commands.']);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'user-settings.json'), 'utf8')), { theme: 'dark' }, 'shell commands never go to user settings');
  store.decide('sess-1', { requestId: card(store).requestId, decision: 'allow', scope: 'once' });

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
