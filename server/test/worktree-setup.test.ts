import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { copySetupFiles, runSetup, setupCommands, setupOptions } from '../src/worktree-setup.ts';
import { createSession } from '../src/sys.ts';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { tmp } from './fixtures.ts';

function repo() {
  const dir = tmp();
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(dir, '.gitignore'), '.env*\nsecrets/\n');
  git('add', '.gitignore');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial');
  return { dir, git };
}
const wait = async (f: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (f()) return;
  assert.ok(f(), 'condition reached before deadline');
};

test('copies .env* without overwriting branch files or following destination symlinks', () => {
  const { dir } = repo(), dest = tmp(), outside = tmp();
  writeFileSync(join(dir, '.env'), 'private');
  writeFileSync(join(dir, '.env.local'), 'local');
  writeFileSync(join(dest, '.env.local'), 'branch-owned');
  assert.equal(copySetupFiles(dir, dest), 1);
  assert.equal(existsSync(join(dest, '.env')), true, 'main environment was copied');
  assert.equal(readFileSync(join(dest, '.env'), 'utf8'), 'private');
  assert.equal(readFileSync(join(dest, '.env.local'), 'utf8'), 'branch-owned');
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'key'), 'secret');
  writeFileSync(join(dir, '.worktreeinclude'), 'secrets/\n');
  symlinkSync(outside, join(dest, 'secrets'));
  assert.throws(() => copySetupFiles(dir, dest), /leaves the worktree/);
  assert.equal(existsSync(join(outside, 'key')), false);
});

test('.worktreeinclude replaces defaults, supports gitignore patterns and negation, ignores tracked files', () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, '.env'), 'private');
  mkdirSync(join(dir, 'secrets'));
  writeFileSync(join(dir, 'secrets', 'keep'), 'yes');
  writeFileSync(join(dir, 'secrets', 'skip'), 'no');
  writeFileSync(join(dir, 'tracked'), 'tracked');
  git('add', 'tracked');
  writeFileSync(join(dir, '.worktreeinclude'), '# selected files only\nsecrets/*\n!secrets/skip\ntracked\n');
  const dest = tmp();
  assert.equal(copySetupFiles(dir, dest), 1);
  assert.equal(existsSync(join(dest, '.env')), false, 'include list replaces automatic env copying');
  assert.equal(readFileSync(join(dest, 'secrets', 'keep'), 'utf8'), 'yes');
  assert.equal(existsSync(join(dest, 'tracked')), false);
  assert.equal(existsSync(join(dest, 'secrets', 'skip')), false);
  writeFileSync(join(dir, '.worktreeinclude'), '');
  assert.equal(copySetupFiles(dir, tmp()), 0);
});

test('detects dependencies in the new checkout; command override replaces both installers', () => {
  const dir = tmp();
  assert.deepEqual(setupCommands(dir, {}), []);
  writeFileSync(join(dir, 'composer.lock'), '{}');
  writeFileSync(join(dir, 'pubspec.yaml'), 'name: test');
  assert.deepEqual(setupCommands(dir, {}), ['composer install --no-interaction --prefer-dist --no-progress', 'flutter pub get']);
  assert.deepEqual(setupCommands(dir, { command: 'my-setup' }), ['my-setup']);
  assert.throws(() => setupOptions({ '/repo': { timeoutSeconds: 0 } }), /timeoutSeconds/);
  assert.throws(() => setupOptions({ '/repo': { enabled: 'no' } }), /enabled/);
});

test('failure and timeout persist actionable errors; timeout kills installer descendants', async () => {
  const { dir } = repo(), dest = tmp(), status = join(tmp(), 'status');
  const job = { repo: dir, dir: dest, name: 'test', task: '', agent: 'claude', options: { command: 'exit 7' } };
  assert.equal(await runSetup(job, status), false);
  assert.match(JSON.parse(readFileSync(status, 'utf8')).message, /exited 7.*Agent was not started/);
  const marker = join(dest, 'should-not-exist');
  assert.equal(await runSetup({ ...job, options: { command: `sleep 2; touch '${marker}'`, timeoutSeconds: 1 } }, status), false);
  assert.match(JSON.parse(readFileSync(status, 'utf8')).message, /timed out after 1s/);
  await new Promise((r) => setTimeout(r, 1250));
  assert.equal(existsSync(marker), false);
});

test('isolated terminal: setup is visible before agent, failures block launch, off switch skips setup; card survives restart', async () => {
  const { dir, git } = repo(), home = tmp(), bin = tmp();
  const socket = `aw-test-129-${process.pid}`;
  const tmuxBin = execFileSync('which', ['tmux']).toString().trim();
  const tmux = (...args: string[]) => execFileSync(tmuxBin, ['-L', socket, ...args], { env: { ...process.env, TMUX: '' } }).toString();
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nTMUX= exec '${tmuxBin}' -L '${socket}' "$@"\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  writeFileSync(join(dir, '.env'), 'copied');
  writeFileSync(join(dir, 'composer.lock'), 'branch-lock');
  writeFileSync(join(dir, 'pubspec.yaml'), 'name: setup_test');
  writeFileSync(join(dir, 'pubspec.lock'), 'flutter-branch-lock');
  git('add', 'pubspec.yaml', 'pubspec.lock');
  git('add', 'composer.lock'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'lock');
  writeFileSync(join(dir, 'composer.lock'), 'main-checkout-different');
  writeFileSync(join(dir, 'pubspec.lock'), 'flutter-main-different');
  writeFileSync(join(bin, 'composer'), '#!/bin/sh\necho INSTALLING\nsleep 1\ncat composer.lock > installed-lock\n');
  chmodSync(join(bin, 'composer'), 0o755);
  writeFileSync(join(bin, 'flutter'), '#!/bin/sh\necho FLUTTER-INSTALLING\nprintf \"%s\\n\" \"$*\" > flutter-args\ncat pubspec.lock > flutter-installed-lock\n');
  chmodSync(join(bin, 'flutter'), 0o755);
  const agent = join(bin, 'agent');
  writeFileSync(agent, '#!/bin/sh\necho NATIVE-AGENT-PROMPT\ntouch agent-started\nsleep 60\n'); chmodSync(agent, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = bin + ':' + savedPath;
  const token = '1'.repeat(64);
  const cfg = { ...parseConfig({ claudeBin: agent, worlds: [{ id: 'w', repos: [dir], worktreeSetup: { [dir]: { command: 'echo SETUP-FAIL; exit 9' } } }] }), port: 0 };
  let app: ReturnType<typeof startServer> | undefined;
  try {
    const good = await createSession({ repo: dir, home, claudeBin: agent, task: 'good', worktree: true });
    const creation = JSON.parse(readFileSync(join(home, 'worktrees', good.tmuxSession + '.json'), 'utf8'));
    assert.equal(creation.repo, dir);
    assert.equal(creation.dir, good.dir);
    assert.equal(creation.branch, good.branch);
    assert.equal(creation.baseSha, execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
    const screen = () => tmux('capture-pane', '-p', '-t', good.tmuxSession, '-S', '-100');
    await wait(() => screen().includes('INSTALLING'));
    assert.equal(existsSync(join(good.dir, 'agent-started')), false);
    await wait(() => existsSync(join(good.dir, 'agent-started')));
    assert.equal(readFileSync(join(good.dir, 'installed-lock'), 'utf8'), 'branch-lock');
    assert.equal(readFileSync(join(good.dir, '.env'), 'utf8'), 'copied');
    assert.equal(readFileSync(join(good.dir, 'flutter-args'), 'utf8').trim(), 'pub get');
    assert.equal(readFileSync(join(good.dir, 'flutter-installed-lock'), 'utf8'), 'flutter-branch-lock');
    assert.ok(screen().indexOf('INSTALLING') < screen().indexOf('NATIVE-AGENT-PROMPT'));
    const off = await createSession({ repo: dir, home, claudeBin: agent, worktree: true, setup: { enabled: false, command: 'exit 99' } });
    await wait(() => existsSync(join(off.dir, 'agent-started')));
    assert.equal(existsSync(join(off.dir, '.env')), false);

    app = startServer(cfg, token, { home }); await app.listen();
    const res = await fetch(`http://127.0.0.1:${(app.server.address() as any).port}/api/sessions`, { method: 'POST', headers: { 'x-aw-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ worldId: 'w', repo: dir, task: 'failure', worktree: true }) });
    assert.equal(res.status, 201);
    const made = await res.json() as any;
    await app.scan();
    await wait(() => [...app!.store.sessions.values()].some((s) => s.state === 'error'));
    const card = [...app.store.sessions.values()].find((s) => s.state === 'error')!;
    assert.match(card.now, /exit 9|exited 9/);
    const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${(app!.server.address() as any).port}${path}`, { method: 'POST', headers: { 'x-aw-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(`/api/sessions/${encodeURIComponent(card.id)}/input`, { text: 'continue' })).status, 409);
    assert.equal((await post(`/api/sessions/${encodeURIComponent(card.id)}/continue`, { agent: 'codex' })).status, 409);
    const runResponse = await post('/api/runs', { worldId: 'w', repo: dir, task: 'broken setup run', worktree: true, steps: [{ kind: 'build', agent: 'claude' }] });
    assert.ok([201, 422].includes(runResponse.status));
    const runId = (await runResponse.json() as any).run.id;
    await wait(() => [...app!.store.sessions.values()].filter((s) => s.state === 'error').length === 2);
    assert.equal((await post(`/api/runs/${runId}/next`, {})).status, 409, 'a failed setup cannot be skipped by advancing a run');
    assert.equal(existsSync(join(card.cwd, 'agent-started')), false);
    assert.match(tmux('capture-pane', '-p', '-t', made.tmuxSession), /SETUP-FAIL/);
    await app.close();
    app = startServer(cfg, token, { home }); await app.listen(); await app.scan();
    assert.ok([...app.store.sessions.values()].some((s) => s.state === 'error' && s.cwd === card.cwd));
  } finally {
    await app?.close();
    try { tmux('kill-server'); } catch { /* no test server */ }
    process.env.PATH = savedPath;
  }
});

test('world setup settings validate, persist, reload and reach the shared launcher', async () => {
  const { dir } = repo(), home = tmp();
  const cfg = { ...parseConfig({ worlds: [{ id: 'w', repos: [dir] }] }), port: 0 };
  const calls: any[] = [];
  const app = startServer(cfg, '2'.repeat(64), { home, procRoot: tmp(), createSession: async (o) => { calls.push(o); return { tmuxSession: 'settings-test', dir: o.repo, branch: null }; } });
  await app.listen();
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  const call = async (path: string, body: unknown, method = 'PATCH') => fetch(base + path, { method, headers: { 'x-aw-token': '2'.repeat(64), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const options of [{ enabled: false }, { command: 'custom install', timeoutSeconds: 37 }]) {
      assert.equal((await call('/api/worlds/w', { worktreeSetup: { [dir]: options } })).status, 200);
      assert.deepEqual(parseConfig(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).worlds[0].worktreeSetup?.[dir], options);
      assert.equal((await call('/api/sessions', { worldId: 'w', repo: dir, worktree: true }, 'POST')).status, 201);
      assert.deepEqual(calls.at(-1).setup, options);
    }
    const other = dir + '-second';
    assert.equal((await call('/api/worlds/w', { worktreeSetup: { [other]: { enabled: false } } })).status, 200);
    assert.equal((await call('/api/worlds/w', { worktreeSetup: { [dir]: { command: 'custom install', timeoutSeconds: 37 } } })).status, 200);
    assert.deepEqual(cfg.worlds[0].worktreeSetup?.[other], { enabled: false }, 'saving one repo preserves the others, including updates from another tab');
    for (const options of [{ timeoutSeconds: 0 }, { timeoutSeconds: 3601 }, { enabled: 'false' }, { command: 12 }]) {
      assert.equal((await call('/api/worlds/w', { worktreeSetup: { [dir]: options } })).status, 400);
    }
    assert.deepEqual(cfg.worlds[0].worktreeSetup?.[dir], { command: 'custom install', timeoutSeconds: 37 }, 'invalid updates preserve previous settings');
  } finally { await app.close(); }
});

test('timeout also bounds file discovery when there are no dependency installers', async () => {
  const { dir } = repo(), dest = tmp(), bin = tmp(), status = join(tmp(), 'status');
  writeFileSync(join(dir, '.worktreeinclude'), '.env\n');
  writeFileSync(join(dir, '.env'), 'secret');
  const gitBin = execFileSync('which', ['git']).toString().trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nsleep 2\nexec '${gitBin}' "$@"\n`); chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = bin + ':' + path;
  const started = Date.now();
  try {
    assert.equal(await runSetup({ repo: dir, dir: dest, name: 'copy-timeout', task: '', agent: 'claude', options: { timeoutSeconds: 1 } }, status), false);
    assert.ok(Date.now() - started < 2000, 'timeout stops blocked discovery before its first git call finishes');
    assert.match(JSON.parse(readFileSync(status, 'utf8')).message, /timed out after 1s/);
    assert.equal(existsSync(join(dest, '.env')), false);
  } finally { process.env.PATH = path; }
});

test('a completed setup never replaces a real idle conversation during restart adoption', async () => {
  const { dir } = repo(), home = tmp(), procRoot = tmp(), projects = tmp();
  const id = 'aaaaaaaa-1111-4111-8111-111111111111';
  const proc = join(procRoot, '1234'); mkdirSync(proc);
  writeFileSync(join(proc, 'cmdline'), `claude\0--resume\0${id}\0`);
  writeFileSync(join(proc, 'environ'), `AGENT_WORLDS_HOME=${home}\0TMUX_PANE=%91\0`);
  symlinkSync(dir, join(proc, 'cwd'));
  mkdirSync(join(home, 'worktree-setup'));
  writeFileSync(join(home, 'worktree-setup', 'aw-repo.json'), JSON.stringify({ repo: dir, dir, name: 'aw-repo', task: 'already done', agent: 'claude', options: {} }));
  writeFileSync(join(home, 'worktree-setup', 'aw-repo.json.status'), JSON.stringify({ state: 'ready', message: 'Worktree ready. Starting agent…' }));
  const app = startServer({ ...parseConfig({ claudeProjectsDir: projects, worlds: [{ id: 'w', repos: [dir] }] }), port: 0 }, '3'.repeat(64), { home, procRoot, tmuxPanes: async () => new Map([['%91', new Set(['aw-repo'])]]), deps: { tmuxSessionOf: async () => 'aw-repo' } });
  await app.listen();
  try {
    await app.scan();
    assert.ok(app.store.sessions.has(id), 'the live conversation is adopted without waiting for another hook');
    assert.equal(app.store.sessions.has('starting:aw-repo'), false);
    assert.equal(app.store.sessions.get(id)?.state, 'idle');
  } finally { await app.close(); }
});

test('a running setup is recovered after restart and still gates the agent until it finishes', async () => {
  const { dir } = repo(), home = tmp(), procRoot = tmp();
  mkdirSync(join(home, 'worktree-setup'));
  const file = join(home, 'worktree-setup', 'aw-pending.json');
  writeFileSync(file, JSON.stringify({ repo: dir, dir, name: 'aw-pending', task: 'pending setup', agent: 'codex', options: {} }));
  writeFileSync(file + '.status', JSON.stringify({ state: 'running', message: 'Running composer install' }));
  const app = startServer({ ...parseConfig({ worlds: [{ id: 'w', repos: [dir] }] }), port: 0 }, '4'.repeat(64), { home, procRoot, tmuxPanes: async () => new Map([['%92', new Set(['aw-pending'])]]) });
  await app.listen();
  try {
    await app.scan();
    const card = app.store.sessions.get('starting:aw-pending')!;
    assert.ok(card, 'the pending setup card is restored');
    assert.equal(card.setup?.state, 'running');
    assert.equal(card.now, 'Running composer install');
    writeFileSync(file + '.status', JSON.stringify({ state: 'error', message: 'Worktree setup failed: timed out after 1s. Agent was not started.' }));
    await app.scan();
    assert.equal(card.state, 'error');
    assert.match(card.card && 'summary' in card.card ? card.card.summary! : '', /timed out after 1s/);
  } finally { await app.close(); }
});
