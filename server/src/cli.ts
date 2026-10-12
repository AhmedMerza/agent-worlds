import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLE_CONFIG, ensureToken, homeDir, loadConfig, writeEndpoint, type Config } from './config.ts';
import { startServer } from './server.ts';

const HOOK = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../bin/aw-hook');

/** Hook timeouts (seconds). PermissionRequest is held by the server for up to HOLD_MS (3540 s), so its hook gets 3600 s. */
const HOLD_TIMEOUT = 3600;
const FAST_TIMEOUT = 10;
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd'];

export function hooksBlock(hookPath = HOOK) {
  const command = /^[\w./-]+$/.test(hookPath) ? hookPath : `'${hookPath.replace(/'/g, `'\\''`)}'`;
  const hooks: Record<string, unknown> = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command, timeout: ev === 'PermissionRequest' ? HOLD_TIMEOUT : FAST_TIMEOUT }] }];
  }
  return { hooks };
}

const urlOf = (cfg: Config, token: string) => {
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}/?token=${token}`;
};

function die(msg: string): never {
  process.stderr.write(`agent-worlds: ${msg}\n`);
  process.exit(1);
}

const USAGE = `usage: agent-worlds <command>
  start                         run the server
  url                           print the URL to open (includes the token)
  hooks --print                 print the "hooks" block for ~/.claude/settings.json
  new <worldId> <repoPath> [task]  start claude in a new tmux session aw-<name>
  init [--force]                write an example config
config dir: ${homeDir()} (override with AGENT_WORLDS_HOME)`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const load = () => { try { return loadConfig(); } catch (e) { die((e as Error).message); } };
  switch (cmd) {
    case 'start': {
      const cfg = load();
      const token = ensureToken();
      const app = startServer(cfg, token);
      try { await app.listen(); } catch (e) { die(`cannot listen on ${cfg.host}:${cfg.port}: ${(e as Error).message}`); }
      writeEndpoint(cfg);
      if (!existsSync(join(homeDir(), 'config.json'))) console.log(`no config yet: run \`agent-worlds init\` and edit ${join(homeDir(), 'config.json')}`);
      console.log(`agent-worlds listening on ${cfg.host}:${cfg.port}\nopen: ${urlOf(cfg, token)}`);
      const stop = () => app.close().then(() => process.exit(0));
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      return;
    }
    case 'url':
      return console.log(urlOf(load(), ensureToken()));
    case 'hooks':
      if (rest[0] !== '--print') die('usage: agent-worlds hooks --print');
      return console.log(JSON.stringify(hooksBlock(), null, 2));
    case 'new': {
      const [worldId, repoPath, ...task] = rest;
      if (!worldId || !repoPath) die('usage: agent-worlds new <worldId> <repoPath> [task]');
      const cfg = load();
      if (!cfg.worlds.some((w) => w.id === worldId)) die(`unknown world "${worldId}" (known: ${cfg.worlds.map((w) => w.id).join(', ') || 'none'})`);
      const dir = resolve(repoPath);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`not a directory: ${dir}`);
      const name = `aw-${basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 24)}-${randomBytes(2).toString('hex')}`;
      const prompt = task.join(' ').trim();
      const args = ['new-session', '-d', '-s', name, '-c', dir, 'claude', ...(prompt ? [prompt] : [])];
      execFile('tmux', args, (err, _o, stderr) => {
        if (err) die(`tmux failed: ${String(stderr).trim() || err.message}`);
        console.log(name);
      });
      return;
    }
    case 'init': {
      const file = join(homeDir(), 'config.json');
      if (existsSync(file) && rest[0] !== '--force') die(`${file} exists (use --force to overwrite)`);
      mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', { mode: 0o600 });
      ensureToken();
      return console.log(`wrote ${file}: edit the worlds and repo paths, then run \`agent-worlds start\``);
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
