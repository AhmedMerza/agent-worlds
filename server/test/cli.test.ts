import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hooksBlock, HOOK_EVENTS, writeHooksFile } from '../src/hooks.ts';
import { ensureToken, parseConfig, loadConfig, writeEndpoint, DEFAULTS } from '../src/config.ts';

const BIN = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../bin');
const tmp = () => mkdtempSync(join(tmpdir(), 'awtest-'));

function runHook(env: Record<string, string>, stdin: string, args: string[] = []): Promise<{ code: number; out: string; ms: number }> {
  const t = Date.now();
  return new Promise((ok) => {
    const p = execFile(join(BIN, 'aw-hook'), args, { env: { PATH: process.env.PATH!, HOME: '/nonexistent', ...env } }, (err, out) =>
      ok({ code: err ? (err.code as number) : 0, out: String(out), ms: Date.now() - t }));
    p.stdin!.end(stdin);
  });
}

test('aw-hook: silent exit 0 when disabled, unconfigured or the server is down', async () => {
  const home = tmp();
  assert.deepEqual((await runHook({ AGENT_WORLDS_HOME: home }, '{}')).out, '');
  writeFileSync(join(home, 'token'), 'x'.repeat(64));
  writeFileSync(join(home, 'endpoint'), 'http://127.0.0.1:1\n'); // nothing listens on port 1
  const down = await runHook({ AGENT_WORLDS_HOME: home }, '{"hook_event_name":"PermissionRequest"}');
  assert.equal(down.code, 0);
  assert.equal(down.out, '');
  assert.ok(down.ms < 3000, `took ${down.ms}ms`);
  // Gemini runs in yolo mode with this hook as its only gate: a tool it cannot ask about does not run
  const gate = await runHook({ AGENT_WORLDS_HOME: home }, '{"hook_event_name":"BeforeTool","tool_name":"write_file"}', ['gemini']);
  assert.deepEqual([gate.code, JSON.parse(gate.out).decision], [0, 'deny']);
  assert.equal(JSON.parse((await runHook({ AGENT_WORLDS_HOME: home, AGENT_WORLDS_DISABLE: '1' }, '{"hook_event_name":"BeforeTool"}', ['gemini'])).out).decision, 'deny');
  assert.equal((await runHook({ AGENT_WORLDS_HOME: home }, '{"hook_event_name":"AfterAgent"}', ['gemini'])).out, '', 'other events stay silent');
  const off = await runHook({ AGENT_WORLDS_HOME: home, AGENT_WORLDS_DISABLE: '1' }, '{}');
  assert.equal(off.code, 0);
});

test('aw-hook: posts payload with token + pane and prints the reply', async (t) => {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-aw-token'], pane: req.headers['x-aw-pane'], agent: req.headers['x-aw-agent'], body });
      if (body.includes('PermissionRequest')) { res.writeHead(200); res.end('{"hookSpecificOutput":{}}'); }
      else { res.writeHead(204); res.end(); }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const home = tmp();
  writeFileSync(join(home, 'token'), 'T'.repeat(64) + '\n');
  writeFileSync(join(home, 'endpoint'), `http://127.0.0.1:${(srv.address() as any).port}\n`);
  const payload = '{"session_id":"s","hook_event_name":"PermissionRequest","tool_input":{"command":"echo \'$(id)\'"}}';
  const r = await runHook({ AGENT_WORLDS_HOME: home, TMUX_PANE: '%3' }, payload);
  assert.equal(r.out, '{"hookSpecificOutput":{}}\n');
  assert.deepEqual(seen[0], { url: '/api/hook', token: 'T'.repeat(64), pane: '%3', agent: 'claude', body: payload });
  const quiet = await runHook({ AGENT_WORLDS_HOME: home, TMUX_PANE: 'bogus; rm -rf /' }, '{"hook_event_name":"Stop"}');
  assert.equal(quiet.out, '');
  assert.equal(seen[1].pane, undefined, 'an invalid TMUX_PANE is not sent');
  await runHook({ AGENT_WORLDS_HOME: home }, '{"hook_event_name":"Stop"}', ['codex']);
  assert.equal(seen[2].agent, 'codex', 'Codex names itself as the first argument');
  await runHook({ AGENT_WORLDS_HOME: home }, '{"hook_event_name":"Stop"}', ['Bad Name']);
  assert.equal(seen[3].agent, 'claude');

});

test('hooks --print wires every event to aw-hook with timeouts', () => {
  const { hooks } = hooksBlock('/opt/agent worlds/bin/aw-hook') as any;
  assert.deepEqual(Object.keys(hooks), HOOK_EVENTS);
  assert.equal(hooks.PermissionRequest[0].hooks[0].timeout, 3600);
  assert.equal(hooks.Stop[0].hooks[0].timeout, 10);
  assert.equal(hooks.Stop[0].hooks[0].command, `'/opt/agent worlds/bin/aw-hook'`);
  assert.equal((hooksBlock('/opt/aw/bin/aw-hook') as any).hooks.Stop[0].hooks[0].command, '/opt/aw/bin/aw-hook');
});

test('config: defaults, validation, token and endpoint files', () => {
  const home = tmp();
  assert.deepEqual(loadConfig(home), DEFAULTS);
  writeFileSync(join(home, 'config.json'), '{bad');
  assert.throws(() => loadConfig(home), /invalid JSON/);
  assert.throws(() => parseConfig({ port: 70000 }), /port/);
  assert.throws(() => parseConfig({ worlds: [{ id: 'Bad Id', repos: [] }] }), /world id/);
  assert.throws(() => parseConfig({ worlds: [{ id: 'a', repos: [] }, { id: 'a', repos: [] }] }), /duplicate/);
  assert.throws(() => parseConfig({ worlds: [{ id: 'a', repos: 'x' }] }), /repos/);
  assert.equal(parseConfig({ worlds: [{ id: 'a', repos: [], color: 'red' }] }).worlds[0].color, '#888888');

  const t = ensureToken(home);
  assert.equal(t.length, 64);
  assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);
  assert.equal(ensureToken(home), t, 'stable across calls');
  writeEndpoint({ ...DEFAULTS, port: 4321 }, home);
  assert.equal(readFileSync(join(home, 'endpoint'), 'utf8'), 'http://127.0.0.1:4321\n');
});

test('cli: init writes a generic example config, url prints the tokened URL', async () => {
  const home = tmp();
  const cli = (args: string[]) => new Promise<{ code: number; out: string }>((ok) =>
    execFile(join(BIN, 'agent-worlds'), args, { env: { ...process.env, AGENT_WORLDS_HOME: home } }, (err, out, errOut) =>
      ok({ code: err ? (err.code as number) : 0, out: String(out) + String(errOut) })));
  assert.equal((await cli(['init'])).code, 0);
  assert.ok(existsSync(join(home, 'config.json')));
  assert.equal((await cli(['init'])).code, 1, 'refuses to overwrite');
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.worlds, [], 'no example worlds: they are made in the GUI');
  const url = (await cli(['url'])).out.trim();
  assert.match(url, /^http:\/\/127\.0\.0\.1:4317\/\?token=[0-9a-f]{64}$/);
  const hooks = JSON.parse((await cli(['hooks', '--print'])).out);
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /\/bin\/aw-hook$/);
  assert.equal((await cli(['new', 'nope', '/tmp'])).code, 1);
  assert.equal((await cli(['bogus'])).code, 1);
});

test('cli: open runs the platform opener with the URL; prints it when there is none', async () => {
  const home = tmp(), bin = tmp(), log = join(tmp(), 'argv');
  const run = (path: string) => new Promise<{ code: number; out: string }>((ok) =>
    execFile(join(BIN, 'agent-worlds'), ['open'], { env: { ...process.env, AGENT_WORLDS_HOME: home, PATH: path } }, (err, out) =>
      ok({ code: err ? (err.code as number) : 0, out: String(out) })));
  const bare = tmp(); // only what bin/agent-worlds needs, so no real opener can be found
  for (const c of ['bash', 'readlink', 'dirname']) symlinkSync(`/usr/bin/${c}`, join(bare, c));
  symlinkSync(process.execPath, join(bare, 'node'));
  for (const name of ['xdg-open', 'open']) writeFileSync(join(bin, name), `#!/bin/sh\necho "$@" > ${log}\n`, { mode: 0o755 });
  const ok = await run(`${bin}:${bare}`);
  assert.equal(ok.code, 0);
  assert.match(readFileSync(log, 'utf8'), /^http:\/\/127\.0\.0\.1:4317\/\?token=[0-9a-f]{64}$/m);
  const none = await run(bare);
  assert.equal(none.code, 0);
  assert.match(none.out, /^http:\/\/127\.0\.0\.1:4317\/\?token=[0-9a-f]{64}\n/);
});
