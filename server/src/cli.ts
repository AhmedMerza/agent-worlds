import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { EXAMPLE_CONFIG, ensureToken, homeDir, loadConfig, writeEndpoint, type Config } from './config.ts';
import { startServer } from './server.ts';
import { hooksBlock, writeHooksFile } from './hooks.ts';
import { createSession } from './sys.ts';

const urlOf = (cfg: Config, token: string) => {
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}/?token=${token}`;
};

function die(msg: string): never {
  process.stderr.write(`agent-worlds: ${msg}\n`);
  process.exit(1);
}

type Row = { name: string; path: string; attached: number; state: string | null };

/** tmux sessions with our prefix, plus each one's state when the server answers. */
export async function awSessions(prefix = 'aw-', home = homeDir()): Promise<Row[]> {
  const out = await new Promise<string>((done) => execFile('tmux', ['list-sessions', '-F', '#{session_name}\t#{pane_current_path}\t#{session_attached}'], (e, o) => done(e ? '' : String(o))));
  const rows: Row[] = out.split('\n').filter(Boolean).map((l) => l.split('\t')).filter(([n]) => n.startsWith(prefix))
    .map(([name, path, att]) => ({ name, path, attached: Number(att) || 0, state: null }));
  try {
    const url = readFileSync(join(home, 'endpoint'), 'utf8').trim();
    const token = readFileSync(join(home, 'token'), 'utf8').trim();
    const st = await (await fetch(`${url}/api/state`, { headers: { 'x-aw-token': token }, signal: AbortSignal.timeout(1000) })).json() as { sessions: { state: string; tmux: { session: string } | null }[] };
    for (const r of rows) r.state = st.sessions.find((s) => s.tmux?.session === r.name)?.state ?? null;
  } catch { /* server not running: list without states */ }
  return rows;
}

export const formatRows = (rows: Row[]) => rows.map((r, i) =>
  `${String(i + 1).padStart(2)}  ${r.name.padEnd(28)} ${(r.state ?? '-').padEnd(8)} ${r.attached ? 'attached ' : '         '}${r.path}`).join('\n');

/** "2" or a session name → that row; anything else → null. */
export function pick(answer: string, rows: Row[]): Row | null {
  const a = answer.trim();
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= rows.length) return rows[n - 1];
  return rows.find((r) => r.name === a) ?? null;
}

function attachTo(name: string): never {
  // Inside tmux, attaching would nest; switch this client instead.
  const args = process.env.TMUX ? ['switch-client', '-t', '=' + name] : ['attach-session', '-t', '=' + name];
  const r = spawnSync('tmux', args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

/** Launch the platform opener detached; resolves false when it is missing or fails fast. */
function openBrowser(target: string): Promise<boolean> {
  const bin = process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((done) => {
    const p = spawn(bin, [target], { detached: true, stdio: 'ignore' });
    const t = setTimeout(() => { p.unref(); done(true); }, 1000); // still running: assume it took over
    p.on('error', () => { clearTimeout(t); done(false); });
    p.on('exit', (code) => { clearTimeout(t); done(code === 0); });
  });
}

const USAGE = `usage: agent-worlds <command>
  start                         run the server
  url                           print the URL to open (includes the token)
  open                          open that URL in your browser (prints it if no opener)
  hooks --print                 print the "hooks" block for ~/.claude/settings.json
  new <worldId> <repoPath> [task]  start claude in a new tmux session aw-<name>
  init [--force]                write a config with no worlds
  ls                            list Agent Worlds tmux sessions
  attach [name]                 attach this terminal to one (asks which when no name)
config dir: ${homeDir()} (override with AGENT_WORLDS_HOME)`;

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  const load = () => { try { return loadConfig(); } catch (e) { die((e as Error).message); } };
  switch (cmd) {
    case 'start': {
      const cfg = load();
      const token = ensureToken();
      const app = startServer(cfg, token);
      try { await app.listen(); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') die(`port ${cfg.port} is busy — another Agent Worlds? change "port" in ${join(homeDir(), 'config.json')}`);
        die(`cannot listen on ${cfg.host}:${cfg.port}: ${(e as Error).message}`);
      }
      writeEndpoint(cfg);
      writeHooksFile(homeDir());
      if (!existsSync(join(homeDir(), 'config.json'))) console.log(`no config yet: run \`agent-worlds init\` and edit ${join(homeDir(), 'config.json')}`);
      console.log(`agent-worlds listening on ${cfg.host}:${cfg.port}\nopen: ${urlOf(cfg, token)}`);
      const stop = () => app.close().then(() => process.exit(0));
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      return;
    }
    case 'url':
      return console.log(urlOf(load(), ensureToken()));
    case 'open': {
      const u = urlOf(load(), ensureToken());
      if (await openBrowser(u)) return;
      console.log(`${u}\n(could not launch a browser; open the URL above manually)`);
      return;
    }
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
      try {
        writeHooksFile(homeDir());
        const r = await createSession({ repo: dir, task: task.join(' '), worktree: false, claudeBin: cfg.claudeBin, home: homeDir() });
        console.log(r.tmuxSession);
      } catch (e) { die((e as Error).message); }
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
    case 'ls': {
      const rows = await awSessions();
      console.log(rows.length ? formatRows(rows) : 'no Agent Worlds sessions (tmux sessions named aw-*)');
      return;
    }
    case 'attach': {
      if (rest[0]) attachTo(rest[0]);
      const rows = await awSessions();
      if (!rows.length) die('no Agent Worlds sessions to attach to');
      console.log(formatRows(rows));
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((ok) => rl.question('attach to (number or name): ', ok));
      rl.close();
      const row = pick(answer, rows);
      if (!row) die(`no such session: ${answer.trim()}`);
      attachTo(row.name);
    }
    default:
      console.log(USAGE);
      if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
