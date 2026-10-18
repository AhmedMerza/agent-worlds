import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { homeDir, type Config } from './config.ts';
import { Store } from './store.ts';
import { AGENTS, defaultAgent, installed as onPath, isAgent, type AgentId } from './agents.ts';
import { Stats } from './rules.ts';
import { Placements } from './placements.ts';
import { Insights, type Summarise } from './insights.ts';
import * as sys from './sys.ts';
import { Worlds, saveConfigKey } from './worlds.ts';
import { phoneAddresses, Pairing, detectFirewall, type Address } from './phone.ts';
import { Password, LoginLimiter, Tunnel, AccessLog, findCloudflared, installCloudflared, cloudflaredAsset } from './remote.ts';
import { history, findTranscript, scanClaude, transcriptSummary, SESSION_ID_RE, type ClaudeProc } from './history.ts';
import { writeHandoff } from './handoff.ts';
import { readHead, readTail, conversation, midTurn } from './transcript.ts';
import { readFileSync } from 'node:fs';
import { watchCode, prepareRestart } from './update.ts';
import { Direct, type PtyLike } from './direct.ts';
import { Mailbox } from './mailbox.ts';
import { handleMcp, type Peer } from './mcp.ts';
import { newRun, stepPrompt, excludeRunFiles, isStepKind, loadRuns, saveRuns, STEP_KINDS, type Run } from './runs.ts';

/** How long a PermissionRequest is held for the GUI. Must stay below the hook `timeout` (3600 s) printed by `hooks --print`. */
export const HOLD_MS = 3540_000;
const MAX_BODY = 10 * 1024 * 1024;
const WEB_DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
/** Files a phone fetches without cookies when installing the app. Nothing sensitive. */
const PUBLIC_RE = /^\/(manifest\.webmanifest|icon-[\w-]+\.png|apple-touch-icon\.png)$/;

type Opts = {
  holdMs?: number; deps?: Partial<ConstructorParameters<typeof Store>[1]>; webDist?: string; spawnPty?: typeof spawnTmuxPty;
  home?: string; summarise?: Summarise; procRoot?: string; tmuxPrefix?: string; resolveRepo?: ConstructorParameters<typeof Worlds>[2]; createSession?: typeof sys.createSession;
  phoneAddresses?: () => Address[]; stopProcess?: (pid: number) => Promise<boolean>;
  restartClaude?: typeof sys.restartClaude;
  /** Types into a tmux pane (the mail notice); tests stub it. */
  typeInto?: typeof sys.typeInto;
  /** Set by `agent-worlds start`: exits so the launcher starts the new code. Enables watching for code changes. */
  onRestart?: () => void; prepareRestart?: typeof prepareRestart;
  /** Path to cloudflared; null = not installed. Default: looked up on PATH and in ~/.local/bin. */
  cloudflared?: string | null;
  /** Where to download cloudflared from (tests serve a fake one). */
  installCloudflared?: () => Promise<string>;
  detectFirewall?: () => Promise<'firewalld' | 'ufw' | null>;
};

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const same = (a: string | null | undefined, b: string) =>
  typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function send(res: ServerResponse, status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

const BAD_TOKEN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Worlds: link not valid</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:4em auto;padding:0 1em">
<h1>This link no longer works</h1>
<p>The link comes from an older install, or the access token has changed.</p>
<p>On the machine running the server, run <code>agent-worlds open</code> (or <code>agent-worlds url</code>) to get a fresh link.</p>
</body>`;

const BAD_PAIR_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Worlds: code expired</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:34em;margin:4em auto;padding:0 1em">
<h1>This code has expired</h1>
<p>Each phone code works once and only for 5 minutes.</p>
<p>On your computer, open Agent Worlds, press <b>Connect a phone</b> and scan the new code.</p>
</body>`;

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:26em;margin:4em auto;padding:0 1em;background:#14161b;color:#e6e8ec">${body}</body>`;
const loginPage = (msg = '') => page('Agent Worlds: log in', `<h1 style="font-size:24px">Agent Worlds</h1>
${msg ? `<p style="color:#f2b84b">${msg}</p>` : '<p>Enter the password you set in <b>Connect a phone</b> on your computer.</p>'}
<form method="post" action="/login"><input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password"
 style="font:inherit;width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #444;background:#0d0f13;color:inherit">
<button style="font:inherit;margin-top:10px;width:100%;padding:10px;border:0;border-radius:6px;background:#f2b84b;color:#111;font-weight:600">Log in</button></form>`);

/** SIGTERM a Claude process and wait up to 5 s for it to exit. */
async function stopProcess(pid: number): Promise<boolean> {
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try { process.kill(pid, 'SIGTERM'); } catch { return !alive(); }
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive();
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

/** Starts the line typed into a session that has mail; a prompt starting so is not one you typed. */
const MAIL_NOTICE = '[Agent Worlds]';

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { fail(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        // The login page posts a plain HTML form; everything else sends JSON.
        if (req.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return ok(Object.fromEntries(new URLSearchParams(text)));
        const v = JSON.parse(text || '{}');
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('body must be a JSON object');
        ok(v);
      } catch (e) { fail(Object.assign(new Error((e as Error).message), { status: 400 })); }
    });
    req.on('error', fail);
  });
}

export function spawnTmuxPty(session: string, cols: number, rows: number) {
  // Loaded lazily so the rest of the server (and its tests) work without the native module.
  return import('node-pty').then((pty) => {
    const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
    delete env.TMUX; delete env.TMUX_PANE;
    return pty.spawn('tmux', ['attach-session', '-t', '=' + session], { name: 'xterm-256color', cols, rows, env, cwd: process.env.HOME });
  });
}

export function startServer(cfg: Config, token: string, opts: Opts = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const ptys = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // Heartbeat: a socket that misses a ping round is dropped, so half-open connections don't keep tmux clients around.
  const alive = new WeakSet<WebSocket>();
  const track = (ws: WebSocket) => { alive.add(ws); ws.on('pong', () => alive.add(ws)); };
  let insights: Insights | null = null;
  const mailbox = new Mailbox();
  const runsFile = join(opts.home ?? homeDir(), 'runs.json');
  const runs = new Map<string, Run>(loadRuns(runsFile).map((r) => [r.id, r]));
  /** Sessions that reached /mcp: only they have the mailbox tools (a plain `claude` reporting through global hooks has not). */
  const mailboxed = new Set<string>();
  const broadcast = (msg: { type: string; id?: string; [k: string]: unknown }) => {
    if (msg.type === 'session-removed' && msg.id) { insights?.forget(msg.id); mailbox.forget(msg.id); mailboxed.delete(msg.id); runSessionGone(msg.id); }
    const text = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(text);
  };
  const store = new Store(cfg, {
    repoInfo: sys.repoInfo, branchOf: sys.branchOf, tmuxSessionOf: sys.tmuxSessionOf,
    clientsConnected: () => wss.clients.size > 0,
    holdMs: opts.holdMs ?? HOLD_MS,
    stats: new Stats(join(opts.home ?? homeDir(), 'stats.json')),
    placements: new Placements(join(opts.home ?? homeDir(), 'placements.json')),
    onEvent: (s, ev) => {
      insights?.onEvent(s, ev);
      // a prompt you typed (not our mail notice) lets its conversations with other sessions go on
      if (ev === 'UserPromptSubmit' && !s.lastPrompt?.startsWith(MAIL_NOTICE)) mailbox.prompted(s.id);
      runEvent(s, ev);
    },
    ...opts.deps,
  }, broadcast);
  insights = new Insights(store, cfg.claudeBin, { summarise: opts.summarise, contextLimit: cfg.contextLimit });
  const createSession = opts.createSession ?? sys.createSession;
  // Without tmux, sessions run in ptys this server owns; one ending removes its card.
  const direct = new Direct((name) => { for (const s of [...store.sessions.values()]) if (s.direct === name) store.remove(s); });
  const spawnDirect: sys.SpawnDirect = (...a) => direct.spawn(...a);
  /** Whether tmux is installed; the page explains what it adds when it is not. Installing it needs a restart. */
  let tmux = true;
  if (opts.onRestart) void sys.hasTmux().then((v) => { tmux = v; });
  // Claude runs identical hook commands once, but the same hook installed under two different
  // command strings (say a symlinked path globally plus our --settings file) would report every
  // event twice. A byte-identical payload within a few seconds gets the first one's reply instead.
  // Entries live while the first request is in flight and DEDUPE_MS after it settled.
  const recent = new Map<string, { at: number; reply: Promise<string> }>();
  const DEDUPE_MS = 500;
  const worlds = new Worlds(cfg, join(opts.home ?? homeDir(), 'config.json'), opts.resolveRepo);
  // Running claude processes (Linux /proc), refreshed every 10 s.
  let procs: ClaudeProc[] = [];
  let unmanaged: Record<string, unknown>[] = [];
  const repoCache = new Map<string, Promise<sys.RepoInfo>>();
  const repoOf = (cwd: string) => {
    if (!repoCache.has(cwd)) repoCache.set(cwd, (store.deps.repoInfo)(cwd));
    if (repoCache.size > 500) repoCache.delete(repoCache.keys().next().value!);
    return repoCache.get(cwd)!;
  };
  const isManaged = (p: ClaudeProc) => [...store.sessions.values()].some((s) => (p.pane && s.tmux?.pane === p.pane) || (p.direct && s.direct === p.direct) || s.id === p.sessionId);
  /** What a plain-terminal session is doing: its last prompt and when its transcript last changed. Re-read only on change. */
  const ghostInfo = new Map<string, { mtime: number; lastPrompt: string | null }>();
  async function ghostOf(sessionId: string | null): Promise<{ lastPrompt: string | null; lastActivity: number | null }> {
    const file = sessionId ? findTranscript(cfg.claudeProjectsDir, sessionId) : null;
    if (!file) return { lastPrompt: null, lastActivity: null };
    let mtime: number;
    try { mtime = Math.round((await stat(file)).mtimeMs); } catch { return { lastPrompt: null, lastActivity: null }; }
    let hit = ghostInfo.get(file);
    if (hit?.mtime !== mtime) {
      hit = { mtime, lastPrompt: (await transcriptSummary(file)).lastPrompt };
      ghostInfo.set(file, hit);
      if (ghostInfo.size > 200) ghostInfo.delete(ghostInfo.keys().next().value!);
    }
    return { lastPrompt: hit.lastPrompt, lastActivity: mtime };
  }
  /**
   * A session we started (its AGENT_WORLDS_HOME is ours, and it runs in a tmux pane) but don't know, because the server
   * restarted and it sent no hook since (idle, or deep in one long tool call): take it back instead of showing it as a
   * plain-terminal ghost. Its transcript says which.
   */
  async function adopt(p: ClaudeProc) {
    const transcript = findTranscript(cfg.claudeProjectsDir, p.sessionId!);
    await store.handle({ hook_event_name: 'SessionStart', source: 'resume', session_id: p.sessionId, cwd: p.cwd, ...(transcript ? { transcript_path: transcript } : {}) }, p.pane);
    const s = store.sessions.get(p.sessionId!);
    if (!s) return;
    s.now = 'Picked up again after a server restart';
    if (transcript && midTurn(await readTail(transcript, 65536).catch(() => []))) s.state = 'working';
    if (transcript) s.lastPrompt = (await transcriptSummary(transcript)).lastPrompt ?? s.lastPrompt;
    store.push(s);
  }
  async function scan() {
    procs = scanClaude(opts.procRoot ?? '/proc', cfg.claudeProjectsDir);
    const home = opts.home ?? homeDir();
    for (const p of procs) if (p.managedHome === home && p.pane && p.sessionId && !isManaged(p)) await adopt(p);
    const next = await Promise.all(procs.filter((p) => !isManaged(p)).map(async (p) => {
      const info = await repoOf(p.cwd);
      return { pid: p.pid, cwd: p.cwd, repo: info.repo, worldId: store.worldFor(p.sessionId, info.repo, p.cwd), sessionId: p.sessionId, inTmux: !!p.pane, since: p.since, ...(await ghostOf(p.sessionId)) };
    }));
    if (JSON.stringify(next) !== JSON.stringify(unmanaged)) {
      unmanaged = next;
      broadcast({ type: 'unmanaged', unmanaged });
    }
  }
  const worldsChanged = () => { broadcast({ type: 'worlds', worlds: cfg.worlds }); store.recomputeWorlds(); };
  const webDist = opts.webDist ?? WEB_DIST;
  const pairing = new Pairing();
  const password = new Password(join(opts.home ?? homeDir(), 'password.json'));
  const limiter = new LoginLimiter();
  const tunnel = new Tunnel();
  // A newer version of the code on disk shows an "Update now" banner; the click restarts into it.
  let update = false, restarting = false;
  const stopWatch = opts.onRestart ? watchCode(() => { update = true; broadcast({ type: 'update' }); }) : null;
  /** Drops sessions whose tmux session is gone (also run at once when a terminal's tmux attach ends). */
  const sweepNow = async () => { const alive = await sys.tmuxSessions(); if (alive) store.sweep(alive); };
  const waiting = () => [...store.sessions.values()].filter((s) => s.pending.length);
  const access = new AccessLog(join(opts.home ?? homeDir(), 'access.json'));
  let installed: string | null = null;
  const cloudflared = () => installed ?? (opts.cloudflared !== undefined ? opts.cloudflared : findCloudflared());
  /** Where a request came from. cloudflared connects from this machine, so only then is its CF-Connecting-IP trusted. */
  const client = (req: IncomingMessage) => {
    const sock = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
    const local = sock === '127.0.0.1' || sock === '::1';
    const viaTunnel = local && !!tunnel.host() && req.headers.host?.toLowerCase() === tunnel.host();
    const ip = viaTunnel && typeof req.headers['cf-connecting-ip'] === 'string' ? req.headers['cf-connecting-ip'] : sock;
    return { ip, route: (viaTunnel ? 'public link' : local ? 'this computer' : 'network') as 'public link' | 'network' | 'this computer', agent: String(req.headers['user-agent'] ?? '').slice(0, 300) };
  };
  const logAccess = (req: IncomingMessage, via: string, ok: boolean, device: string | null = null) => access.add({ at: Date.now(), device, via, ok, ...client(req) });
  const addresses = opts.phoneAddresses ?? phoneAddresses;
  const port = () => (servers[0].address() as { port?: number } | null)?.port ?? cfg.port;
  /** Sign this browser in: the shared token cookie plus a device id, so the access log can tell devices apart. */
  const login = (req: IncomingMessage, res: ServerResponse, via: string) => {
    const secure = (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https';
    const attrs = `Max-Age=31536000; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
    const device = cookie(req, 'aw_dev') ?? randomBytes(9).toString('base64url');
    logAccess(req, via, true, device);
    res.writeHead(302, { 'set-cookie': [`aw_token=${token}; ${attrs}`, `aw_dev=${device}; ${attrs}`], location: '/' });
    res.end();
  };
  /** Start or stop answering on a phone address, and remember it in config.json. 127.0.0.1 is never touched. */
  async function setListening(address: string, on: boolean): Promise<string | null> {
    const i = cfg.listen.indexOf(address);
    if (on === (i >= 0)) return null;
    if (on) {
      const srv = createServer(onRequest).on('upgrade', onUpgrade);
      try {
        await new Promise<void>((ok, fail) => { srv.once('error', fail); srv.listen(port(), address, () => ok()); });
      } catch (e) { return `cannot listen on ${address}: ${(e as Error).message}`; }
      servers.push(srv); cfg.listen.push(address);
    } else {
      const [srv] = servers.splice(i, 1); cfg.listen.splice(i, 1);
      srv.close(); srv.closeAllConnections();
    }
    allowed = null;
    return saveConfigKey(join(opts.home ?? homeDir(), 'config.json'), 'listen', cfg.listen);
  }
  // host:port names this server answers to. The port is read once listening (config may say 0 in tests).
  let allowed: Set<string> | null = null;
  const allowedHosts = () => {
    if (allowed) return allowed;
    const p = port();
    const hp = (h: string) => `${h.includes(':') ? `[${h}]` : h}:${p}`;
    const set = new Set([...cfg.listen.map(hp), `localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`, ...cfg.extraHosts, ...(tunnel.host() ? [tunnel.host()!] : [])].map((h) => h.toLowerCase()));
    if (servers[0].listening) allowed = set;
    return set;
  };
  /** DNS-rebinding guard: a page on evil.example resolving to 127.0.0.1 still sends Host: evil.example. */
  const hostOk = (req: IncomingMessage) => typeof req.headers.host === 'string' && allowedHosts().has(req.headers.host.toLowerCase());

  const authed = (req: IncomingMessage) => same(cookie(req, 'aw_token'), token) || same(req.headers['x-aw-token'] as string, token);
  const originOk = (req: IncomingMessage) => {
    const o = req.headers.origin;
    if (!o) return true;
    try { return allowedHosts().has(new URL(o).host.toLowerCase()); } catch { return false; }
  };

  async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    try { await stat(join(webDist, 'index.html')); } catch {
      return send(res, 200, 'Agent Worlds server is running. The web UI is not built yet: run `npm install && npm run build` in web/.\n');
    }
    let file = normalize(join(webDist, decodeURIComponent(path)));
    if (file !== webDist && !file.startsWith(webDist + sep)) return send(res, 400, 'bad path');
    try { if (!(await stat(file)).isFile()) throw 0; } catch { file = join(webDist, 'index.html'); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'max-age=3600' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';

    if (!hostOk(req)) return send(res, 421, { error: 'unknown host; add it to extraHosts in the config' });
    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (!same(url.searchParams.get('token'), token)) { logAccess(req, 'link with token', false); return sendHtml(res, 401, BAD_TOKEN_PAGE); }
      return login(req, res, 'link with token');
    }
    if (method === 'GET' && url.pathname.startsWith('/pair/')) {
      if (pairing.redeem(url.pathname.slice('/pair/'.length))) return login(req, res, 'QR code');
      logAccess(req, 'QR code', false);
      return sendHtml(res, 401, BAD_PAIR_PAGE);
    }
    if (!originOk(req)) return send(res, 403, { error: 'origin not allowed' });
    if ((method === 'GET' || method === 'HEAD') && PUBLIC_RE.test(url.pathname)) {
      try { await stat(join(webDist, url.pathname)); } catch { return send(res, 404, 'not found\n'); }
      return serveStatic(req, res, url.pathname);
    }
    if (url.pathname === '/login' && password.isSet()) {
      if (method === 'GET') return sendHtml(res, 200, loginPage());
      if (method === 'POST') {
        const wait = limiter.locked();
        if (wait) return sendHtml(res, 429, loginPage(`Too many wrong passwords. Try again in ${Math.ceil(wait / 60_000)} minutes.`));
        const b = await readBody(req);
        if (typeof b.password === 'string' && password.check(b.password)) { limiter.ok(); return login(req, res, 'password'); }
        limiter.fail();
        logAccess(req, 'password', false);
        return sendHtml(res, 401, loginPage('Wrong password.'));
      }
    }
    if (!authed(req)) {
      if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'unauthorized' });
      if (password.isSet()) { res.writeHead(302, { location: '/login' }); return res.end(); }
      return send(res, 401, 'Unauthorized. Open the URL printed by `agent-worlds url`.\n');
    }
    const dev = cookie(req, 'aw_dev');
    if (dev) access.touch(dev);

    if (method === 'POST' && url.pathname === '/api/hook') {
      const body = await readBody(req);
      const pane = req.headers['x-aw-pane'];
      const pty = req.headers['x-aw-pty'];
      const agent = req.headers['x-aw-agent'];
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const now = Date.now();
      for (const [k, v] of recent) if (v.at && now - v.at > DEDUPE_MS) recent.delete(k);
      const key = createHash('sha1').update(String(pane)).update('\0').update(String(pty)).update('\0').update(JSON.stringify(body)).digest('hex');
      let reply = recent.get(key)?.reply;
      if (!reply) {
        reply = store.handle(body, typeof pane === 'string' && sys.PANE_RE.test(pane) ? pane : null, ac.signal, typeof pty === 'string' && direct.has(pty) ? pty : null, isAgent(agent) ? agent : 'claude');
        const entry = { at: 0, reply };
        recent.set(key, entry);
        reply.finally(() => { entry.at = Date.now(); }).catch(() => {});
      }
      let out: string;
      try { out = await reply; } catch (e) { return send(res, 400, { error: (e as Error).message }); }
      if (res.destroyed) return;
      if (!out) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(out);
    }
    // Sessions message each other through bin/aw-mcp, which forwards their MCP calls here with the pane they run in.
    if (url.pathname === '/mcp') {
      if (method !== 'POST') return send(res, 405, { error: 'POST only' });
      const body = await readBody(req);
      const pane = req.headers['x-aw-pane'], pty = req.headers['x-aw-pty'];
      const self = [...store.sessions.values()].find((s) => (typeof pane === 'string' && pane && s.tmux?.pane === pane) || (typeof pty === 'string' && pty && s.direct === pty));
      if (self) mailboxed.add(self.id);
      const out = await handleMcp(body, mcpContext(self?.id ?? null));
      if (out === null) { res.writeHead(202); return res.end(); }
      return send(res, 200, out);
    }
    if (method === 'GET' && url.pathname === '/api/agents') {
      return send(res, 200, { agents: Object.entries(AGENTS).map(([id, a]) => ({ id, name: a.name, installed: id === 'claude' || onPath(a.bin), modes: a.modes, decides: a.decides, task: a.task })), default: defaultAgent(cfg.defaultAgent) });
    }
    if (method === 'POST' && url.pathname === '/api/agents/default') {
      const b = await readBody(req);
      if (!isAgent(b.agent)) return send(res, 400, { error: `agent must be one of ${Object.keys(AGENTS).join(', ')}` });
      const err = saveConfigKey(join(opts.home ?? homeDir(), 'config.json'), 'defaultAgent', b.agent);
      if (err) return send(res, 500, { error: err });
      cfg.defaultAgent = b.agent;
      return send(res, 200, { default: defaultAgent(cfg.defaultAgent) });
    }
    if (method === 'GET' && url.pathname === '/api/claude-defaults') {
      let permissionMode: string | null = null;
      try { const m = JSON.parse(readFileSync(cfg.userSettingsPath, 'utf8'))?.permissions?.defaultMode; if (typeof m === 'string') permissionMode = m; } catch { /* no settings file */ }
      return send(res, 200, { permissionMode });
    }
    if (method === 'POST' && url.pathname === '/api/restart') {
      if (!opts.onRestart) return send(res, 501, { error: 'updating needs the server started with `agent-worlds start`' });
      if (restarting) return send(res, 409, { error: 'already updating' });
      const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
      const busy = () => {
        const w = waiting();
        if (!w.length) return null;
        const names = w.map((s) => `${s.repoName}${s.task ? ` (${s.task.length > 40 ? `${s.task.slice(0, 40)}…` : s.task})` : ''}`).join(', ');
        return `${w.length > 1 ? 'These sessions are' : 'This session is'} waiting for your answer: ${names}. Answer first, then update.`;
      };
      if (busy()) return send(res, 409, { error: busy() });
      if (direct.size && body.force !== true) return send(res, 409, { error: `${direct.size} session${direct.size > 1 ? 's run' : ' runs'} without tmux and will end. You can resume ${direct.size > 1 ? 'them' : 'it'} from Recent sessions afterwards.`, direct: direct.size });
      restarting = true;
      const err = await (opts.prepareRestart ?? prepareRestart)() ?? busy();
      if (err) { restarting = false; return send(res, 409, { error: err }); }
      send(res, 202, { ok: true });
      setTimeout(opts.onRestart, 200);
      return;
    }
    if (method === 'GET' && url.pathname === '/api/state') return send(res, 200, { worlds: cfg.worlds, sessions: store.list(), unmanaged, runs: [...runs.values()] });
    if (method === 'GET' && url.pathname === '/api/history') {
      const n = Number(url.searchParams.get('limit') ?? 50);
      const limit = Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 50;
      const running = new Set([...store.sessions.keys(), ...procs.map((p) => p.sessionId).filter(Boolean) as string[]]);
      const repo = url.searchParams.get('repo');
      if (repo !== null && !repo.startsWith('/')) return send(res, 400, { error: 'repo must be an absolute path' });
      const items = await Promise.all((await history(cfg.claudeProjectsDir, limit, repo ? normalize(repo).replace(/\/+$/, '') : undefined)).map(async (h) => {
        const info = h.cwd ? await repoOf(h.cwd) : null;
        return {
          ...h, repo: info?.repo ?? null, worldId: info ? store.worldFor(h.sessionId, info.repo, h.cwd!) : null,
          running: running.has(h.sessionId), managed: store.sessions.has(h.sessionId),
        };
      }));
      return send(res, 200, { sessions: items });
    }
    if (method === 'POST' && url.pathname === '/api/sessions/resume') {
      const b = await readBody(req);
      if (typeof b.sessionId !== 'string' || !SESSION_ID_RE.test(b.sessionId)) return send(res, 400, { error: 'sessionId is required' });
      if (b.worldId !== undefined && b.worldId !== null && !cfg.worlds.some((w) => w.id === b.worldId)) return send(res, 400, { error: 'unknown worldId' });
      if (b.worktree === true) return send(res, 400, { error: 'resume in a worktree is not supported' });
      if (b.permissionMode !== undefined && !(sys.PERMISSION_MODES as readonly unknown[]).includes(b.permissionMode)) return send(res, 400, { error: `permissionMode must be one of ${sys.PERMISSION_MODES.join(', ')}` });
      const file = findTranscript(cfg.claudeProjectsDir, b.sessionId);
      if (!file) return send(res, 404, { error: 'no transcript for that session' });
      const cwd = (await readHead(file, 256 * 1024)).find((e) => typeof e.cwd === 'string')?.cwd as string | undefined;
      if (!cwd || !sys.isDir(cwd)) return send(res, 422, { error: `the session's folder no longer exists: ${cwd ?? 'unknown'}` });
      if (b.force !== true) {
        procs = scanClaude(opts.procRoot ?? '/proc', cfg.claudeProjectsDir);
        const live = store.sessions.get(b.sessionId);
        const proc = procs.find((p) => p.sessionId === b.sessionId || (live?.tmux && p.pane === live.tmux.pane));
        // stop: quit the copy running in another terminal first (only ours: scanClaude keeps this user's processes).
        if (b.stop === true && proc && !live) {
          if (!(await (opts.stopProcess ?? stopProcess)(proc.pid))) return send(res, 409, { error: `it did not quit (pid ${proc.pid}); close it in its terminal`, pid: proc.pid, stopFailed: true });
        } else if (live || proc) return send(res, 409, { error: 'that session is still running', pid: proc?.pid ?? null });
      }
      try {
        const r = await createSession({ repo: cwd, worktree: false, resume: b.sessionId, ...(b.permissionMode !== undefined ? { permissionMode: b.permissionMode as string } : {}), claudeBin: cfg.claudeBin, home: opts.home ?? homeDir(), prefix: opts.tmuxPrefix, spawnDirect });
        await store.addStarting({ tmuxSession: r.tmuxSession, pane: r.pane ?? null, direct: r.direct ? r.tmuxSession : null, dir: r.dir, task: null });
        return send(res, 201, { tmuxSession: r.tmuxSession });
      } catch (e) { return send(res, 422, { error: (e as Error).message }); }
    }
    if (url.pathname === '/api/phone' && method === 'GET') {
      return send(res, 200, { port: port(), addresses: addresses().map((a) => ({ ...a, allowed: cfg.listen.includes(a.address) })), firewall: await (opts.detectFirewall ?? detectFirewall)(), lanReached: access.entries.some((e) => e.route === 'network'), passwordSet: password.isSet(), cloudflared: !!cloudflared(), canInstall: !!opts.installCloudflared || !!cloudflaredAsset(), tunnel: tunnel.url });
    }
    if (url.pathname === '/api/access' && method === 'GET') {
      return send(res, 200, { devices: access.devices(), entries: access.entries.slice(0, 100), you: cookie(req, 'aw_dev') });
    }
    if (url.pathname === '/api/password' && method === 'POST') {
      const b = await readBody(req);
      if (typeof b.password !== 'string' || b.password.length < 10) return send(res, 400, { error: 'use at least 10 characters' });
      password.set(b.password);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/password' && method === 'DELETE') {
      tunnel.stop(); allowed = null; // no password, no public link
      password.clear();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/cloudflared/install' && method === 'POST') {
      try { installed = await (opts.installCloudflared ?? installCloudflared)(); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 502, { error: (e as Error).message }); }
    }
    if (url.pathname === '/api/tunnel' && method === 'POST') {
      const b = await readBody(req);
      if (b.on !== true) { tunnel.stop(); allowed = null; return send(res, 200, { url: null }); }
      if (!password.isSet()) return send(res, 400, { error: 'set a password first: the link is reachable from the internet' });
      const bin = cloudflared();
      if (!bin) return send(res, 400, { error: 'cloudflared is not installed on this computer' });
      try { const u = await tunnel.start(bin, port()); allowed = null; return send(res, 200, { url: u }); }
      catch (e) { return send(res, 502, { error: (e as Error).message }); }
    }
    if (url.pathname === '/api/phone/allow' && method === 'POST') {
      const b = await readBody(req);
      if (typeof b.address !== 'string' || !addresses().some((a) => a.address === b.address)) return send(res, 400, { error: 'not a network address of this computer' });
      const err = await setListening(b.address, b.allow === true);
      return err ? send(res, 500, { error: err }) : send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/phone/pair' && method === 'POST') {
      const b = await readBody(req);
      const viaTunnel = b.address === 'tunnel' && tunnel.url;
      if (!viaTunnel && (typeof b.address !== 'string' || !cfg.listen.includes(b.address) || !addresses().some((a) => a.address === b.address))) return send(res, 400, { error: 'phones are not allowed on that address' });
      const { code, expiresAt } = pairing.issue();
      return send(res, 200, { url: viaTunnel ? `${tunnel.url}/pair/${code}` : `http://${b.address}:${port()}/pair/${code}`, expiresAt });
    }
    if (url.pathname === '/api/fs' && method === 'GET') {
      const [code, body] = worlds.list(url.searchParams.get('path'));
      return send(res, code, body);
    }
    if (url.pathname === '/api/worlds' || url.pathname.startsWith('/api/worlds/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/worlds/'.length));
      const body = method === 'POST' || method === 'PATCH' ? await readBody(req) : {};
      let r: [number, Record<string, unknown>] | null = null;
      if (url.pathname === '/api/worlds' && method === 'GET') r = [200, { worlds: cfg.worlds }];
      else if (url.pathname === '/api/worlds' && method === 'POST') r = await worlds.create(body);
      else if (url.pathname === '/api/worlds/order' && method === 'POST') r = await worlds.order(body);
      else if (id && method === 'PATCH') r = await worlds.update(id, body);
      else if (id && method === 'DELETE') r = await worlds.remove(id);
      if (!r) return send(res, 405, { error: 'method not allowed' });
      if (r[0] < 300 && method !== 'GET') worldsChanged();
      return send(res, r[0], r[1]);
    }
    if (method === 'POST' && url.pathname === '/api/sessions') {
      const b = await readBody(req);
      const world = cfg.worlds.find((w) => w.id === b.worldId);
      if (!world) return send(res, 400, { error: 'unknown worldId' });
      if (typeof b.repo !== 'string' || !world.repos.includes(b.repo)) return send(res, 400, { error: `repo is not one of the ${world.name} world's repos` });
      if (b.task !== undefined && (typeof b.task !== 'string' || b.task.length > 10000)) return send(res, 400, { error: 'task must be a string up to 10000 chars' });
      if (b.worktree !== undefined && typeof b.worktree !== 'boolean') return send(res, 400, { error: 'worktree must be a boolean' });
      if (b.branch !== undefined && b.branch !== '' && (typeof b.branch !== 'string' || !b.worktree)) return send(res, 400, { error: 'branch must be a string and needs worktree: true' });
      if (b.permissionMode !== undefined && !(sys.PERMISSION_MODES as readonly unknown[]).includes(b.permissionMode)) return send(res, 400, { error: `permissionMode must be one of ${sys.PERMISSION_MODES.join(', ')}` });
      if (b.agent !== undefined && !isAgent(b.agent)) return send(res, 400, { error: `agent must be one of ${Object.keys(AGENTS).join(', ')}` });
      const agent = isAgent(b.agent) ? b.agent : defaultAgent(cfg.defaultAgent);
      if (agent !== 'claude' && !onPath(AGENTS[agent].bin)) return send(res, 422, { error: `${AGENTS[agent].name} is not installed (no ${AGENTS[agent].bin} on PATH)` });
      try {
        const r = await createSession({ agent, repo: b.repo, task: (b.task as string) ?? '', worktree: b.worktree === true, branch: (b.branch as string) || undefined, ...(b.permissionMode !== undefined ? { permissionMode: b.permissionMode as string } : {}), claudeBin: cfg.claudeBin, home: opts.home ?? homeDir(), prefix: opts.tmuxPrefix, spawnDirect });
        await store.addStarting({ tmuxSession: r.tmuxSession, pane: r.pane ?? null, direct: r.direct ? r.tmuxSession : null, dir: r.dir, task: (b.task as string) || null, agent });
        return send(res, 201, { tmuxSession: r.tmuxSession });
      } catch (e) { return send(res, 422, { error: (e as Error).message }); }
    }

    if (method === 'POST' && url.pathname === '/api/runs') {
      const b = await readBody(req);
      const world = cfg.worlds.find((w) => w.id === b.worldId);
      if (!world) return send(res, 400, { error: 'unknown worldId' });
      if (typeof b.repo !== 'string' || !world.repos.includes(b.repo)) return send(res, 400, { error: `repo is not one of the ${world.name} world's repos` });
      if (typeof b.task !== 'string' || !b.task.trim() || b.task.length > 10000) return send(res, 400, { error: 'task must be a non-empty string up to 10000 chars' });
      if (b.worktree !== undefined && typeof b.worktree !== 'boolean') return send(res, 400, { error: 'worktree must be a boolean' });
      const steps = Array.isArray(b.steps) ? b.steps as Record<string, unknown>[] : [];
      if (!steps.length || steps.length > 8) return send(res, 400, { error: 'steps must list 1 to 8 steps' });
      for (const st of steps) {
        if (!st || !isStepKind(st.kind)) return send(res, 400, { error: `each step needs a kind: ${Object.keys(STEP_KINDS).join(', ')}` });
        if (!isAgent(st.agent)) return send(res, 400, { error: `each step needs an agent: ${Object.keys(AGENTS).join(', ')}` });
        if (st.agent !== 'claude' && !onPath(AGENTS[st.agent].bin)) return send(res, 422, { error: `${AGENTS[st.agent].name} is not installed (no ${AGENTS[st.agent].bin} on PATH)` });
      }
      const r = newRun({ task: b.task.trim(), worldId: world.id, repo: b.repo, worktree: b.worktree === true, now: Date.now(),
        steps: steps.map((st) => ({ kind: st.kind as never, agent: st.agent as AgentId, checkpoint: st.checkpoint === true })) });
      runs.set(r.id, r);
      await startStep(r, 0);
      return r.status === 'failed' ? send(res, 422, { error: r.note, run: r }) : send(res, 201, { run: r });
    }
    const runm = url.pathname.match(/^\/api\/runs\/([^/]+)\/(next|stop)$/);
    if (runm && method === 'POST') {
      const r = runs.get(decodeURIComponent(runm[1]));
      if (!r) return send(res, 404, { error: 'no such run' });
      if (runm[2] === 'stop') {
        if (r.status === 'done' || r.status === 'stopped') return send(res, 409, { error: `the run is already ${r.status}` });
        r.status = 'stopped'; r.note = null; pushRun(r);
        return send(res, 200, { run: r });
      }
      if (r.status !== 'waiting' && r.status !== 'running') return send(res, 409, { error: `the run is ${r.status}` });
      // A checkpoint passed, or you move a step on that never handed off.
      if (r.steps[r.current].status === 'handed') { if (r.current + 1 < r.steps.length) await startStep(r, r.current + 1); else { r.status = 'done'; pushRun(r); } }
      else await stepOver(r, null, true);
      return send(res, 200, { run: r });
    }
    // Restart: a fresh claude resumes the same conversation and draws it from scratch (fixes a wrecked screen for good).
    const rm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/restart$/);
    if (rm && method === 'POST') {
      const s = store.sessions.get(decodeURIComponent(rm[1]));
      if (!s) return send(res, 404, { error: 'no such session' });
      if (!s.tmux) return send(res, 409, { error: 'only a session running in tmux can be restarted' });
      if (s.agent !== 'claude') return send(res, 409, { error: `only a Claude Code session can be restarted, not ${AGENTS[s.agent].name}` });
      const body = await readBody(req).catch(() => ({} as Record<string, unknown>));
      if (s.state === 'working' && body.force !== true) return send(res, 409, { error: 'it is in the middle of a turn: restarting stops that turn', working: true });
      const proc = scanClaude(opts.procRoot ?? '/proc', cfg.claudeProjectsDir).find((p) => p.pane === s.tmux!.pane);
      if (!proc?.argv) return send(res, 409, { error: 'its claude process was not found' });
      const err = await (opts.restartClaude ?? sys.restartClaude)(s.tmux.pane, s.id, proc.cwd, proc.argv, proc.managedHome);
      return err ? send(res, 502, { error: `restart failed: ${err}` }) : send(res, 200, { ok: true });
    }
    // Continue in another agent: write a handoff and start that agent in the same folder (its changes carry
    // over: same dir, same branch) with the handoff as its first message. The old session stays untouched.
    const cm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/continue$/);
    if (cm && method === 'POST') {
      const s = store.sessions.get(decodeURIComponent(cm[1]));
      if (!s) return send(res, 404, { error: 'no such session' });
      const b = await readBody(req);
      if (!isAgent(b.agent)) return send(res, 422, { error: `agent must be one of ${Object.keys(AGENTS).join(', ')}` });
      if (b.agent === s.agent) return send(res, 409, { error: `this session already runs ${AGENTS[s.agent].name}` });
      if (b.agent !== 'claude' && !onPath(AGENTS[b.agent].bin)) return send(res, 422, { error: `${AGENTS[b.agent].name} is not installed (no ${AGENTS[b.agent].bin} on PATH)` });
      if (b.permissionMode !== undefined && !(sys.PERMISSION_MODES as readonly unknown[]).includes(b.permissionMode)) return send(res, 400, { error: `permissionMode must be one of ${sys.PERMISSION_MODES.join(', ')}` });
      const home = opts.home ?? homeDir();
      try {
        const handoff = await writeHandoff(s, home);
        const task = `Read "${handoff}" and carry on from there.`;
        const r = await createSession({ agent: b.agent, repo: s.cwd, task, worktree: false, ...(b.permissionMode !== undefined ? { permissionMode: b.permissionMode as string } : {}), claudeBin: cfg.claudeBin, home, prefix: opts.tmuxPrefix, spawnDirect });
        await store.addStarting({ tmuxSession: r.tmuxSession, pane: r.pane ?? null, direct: r.direct ? r.tmuxSession : null, dir: r.dir, task, agent: b.agent });
        return send(res, 201, { tmuxSession: r.tmuxSession, handoff });
      } catch (e) { return send(res, 422, { error: (e as Error).message }); }
    }
    // A pasted or dropped file: the browser cannot hand the terminal a path, so save it here and return one to type.
    const um = url.pathname.match(/^\/api\/sessions\/([^/]+)\/upload$/);
    if (um && method === 'POST') {
      if (!store.sessions.get(decodeURIComponent(um[1]))) return send(res, 404, { error: 'no such session' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req as AsyncIterable<Buffer>) {
        size += c.length;
        if (size > MAX_BODY) return send(res, 413, { error: 'file too large (10 MB at most)' });
        chunks.push(c);
      }
      if (!size) return send(res, 400, { error: 'empty file' });
      const ext = extname(url.searchParams.get('name') ?? '').toLowerCase();
      const dir = join(opts.home ?? homeDir(), 'uploads');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ''}`);
      await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
      return send(res, 200, { path });
    }

    const hm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (hm && method === 'GET') {
      const s = store.sessions.get(decodeURIComponent(hm[1]));
      if (!s) return send(res, 404, { error: 'no such session' });
      // Claude's full-screen view keeps no terminal scrollback, so read the conversation from its transcript.
      if (!s.transcriptPath) return send(res, 409, { error: 'no transcript yet for this session' });
      try { return send(res, 200, { turns: conversation(await readTail(s.transcriptPath, 2 * 1024 * 1024)).slice(-400) }); }
      catch { return send(res, 502, { error: 'cannot read the transcript' }); }
    }
    const wm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/world$/);
    if (wm && method === 'POST') {
      const body = await readBody(req);
      if (body.worldId !== null && typeof body.worldId !== 'string') return send(res, 400, { error: 'worldId must be a world id or null' });
      const err = store.place(decodeURIComponent(wm[1]), body.worldId);
      return err ? send(res, err[0], { error: err[1] }) : send(res, 200, { ok: true });
    }
    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(permission|answer|input|ack|catchup)$/);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      if (m[2] === 'permission' || m[2] === 'answer') {
        const err = m[2] === 'permission' ? store.decide(id, body) : store.answer(id, body);
        return err ? send(res, err[0], { error: err[1] }) : send(res, 200, { ok: true });
      }
      if (m[2] === 'catchup') {
        const s = store.sessions.get(id);
        if (!s) return send(res, 404, { error: 'no such session' });
        const r = insights!.requestCatchup(s);
        if (r === 'busy') return send(res, 409, { error: 'a catch-up is already running for this session' });
        if (r === 'no-transcript') return send(res, 409, { error: 'no transcript yet for this session' });
        return send(res, 202, { ok: true });
      }
      if (m[2] === 'ack') return store.ack(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such session' });
      const s = store.sessions.get(id);
      if (!s) return send(res, 404, { error: 'no such session' });
      if (typeof body.text !== 'string' || body.text.length > 10000) return send(res, 400, { error: 'text must be a string up to 10000 chars' });
      if (s.direct) return direct.type(s.direct, body.text.replace(/\r\n?/g, '\n')) ? send(res, 200, { ok: true }) : send(res, 409, { error: 'session has ended' });
      if (!s.tmux) return send(res, 409, { error: 'session is not running in tmux' });
      return (await sys.typeInto(s.tmux.pane, body.text.replace(/\r\n?/g, '\n')))
        ? send(res, 200, { ok: true }) : send(res, 502, { error: 'tmux send-keys failed' });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, url.pathname);
    return send(res, 405, 'method not allowed\n');
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    route(req, res).catch((e) => {
      const status = (e as { status?: number }).status ?? 500;
      if (status === 500) console.error('[agent-worlds]', e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
      else res.destroy();
    });
  };

  const onUpgrade = (req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const reject = (code: number, text: string) => { socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`); };
    if (!hostOk(req)) return reject(421, 'Misdirected Request');
    if (!originOk(req)) return reject(403, 'Forbidden');
    if (!authed(req)) return reject(401, 'Unauthorized');
    if (url.pathname === '/ws') {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        track(ws);
        ws.send(JSON.stringify({ type: 'snapshot', worlds: cfg.worlds, sessions: store.list(), unmanaged, update, tmux, runs: [...runs.values()] }));
      });
    }
    if (url.pathname === '/pty') {
      const s = store.sessions.get(url.searchParams.get('session') ?? '');
      if (!s?.tmux?.session && !(s?.direct && direct.has(s.direct))) return reject(404, 'Not Found');
      if (ptys.clients.size >= MAX_PTYS) return reject(503, 'Service Unavailable');
      const [name, spawn] = s.direct ? [s.direct, (n: string) => direct.view(n)] : [s.tmux!.session!, opts.spawnPty ?? spawnTmuxPty];
      // A tmux attach that ends may mean the session died (or tmux did): sweep now instead of showing it as alive for 15 s.
      return ptys.handleUpgrade(req, socket, head, (ws) => { track(ws); attachPty(ws, name, spawn, s.direct ? undefined : () => void sweepNow()); });
    }
    reject(404, 'Not Found');
  };
  const label = (s: { id: string; agent: AgentId; repoName: string; branch: string | null }) => `${AGENTS[s.agent].name} ${s.id.slice(0, 8)} (${s.repoName}${s.branch ? `@${s.branch}` : ''})`;
  function mcpContext(self: string | null) {
    return {
      self,
      peers: (): Peer[] => [...store.sessions.values()].filter((s) => s.id !== self && mailboxed.has(s.id))
        .map((s) => ({ id: s.id, agent: AGENTS[s.agent].name, repo: s.repoName, branch: s.branch, task: s.task, state: s.state })),
      send(to: string, text: string): string | Error {
        const from = store.sessions.get(self!)!;
        const hits = [...store.sessions.values()].filter((s) => s.id !== self && mailboxed.has(s.id) && s.id.startsWith(to));
        if (hits.length !== 1) return new Error(hits.length ? `"${to}" matches ${hits.length} sessions: use more of the id` : `no session "${to}": see aw_agents`);
        const r = mailbox.send(from.id, hits[0].id, text);
        if (typeof r === 'string') return new Error(r);
        store.log(from, `Message to ${label(hits[0])}: ${text}`);
        store.log(hits[0], `Message from ${label(from)}: ${text}`);
        store.push(from); store.push(hits[0]);
        return `Sent to ${label(hits[0])}. ${hits[0].state === 'working' ? 'It is working now and will be told when it is free.' : 'It is being told now.'}`;
      },
      handoff: (summary: string) => handoff(self!, summary),
      inbox(): string {
        const got = mailbox.take(self!);
        return got.length ? got.map((m) => {
          const s = store.sessions.get(m.from);
          return `From ${s ? label(s) : m.from} at ${new Date(m.at).toLocaleTimeString()}:\n${m.text}`;
        }).join('\n\n') : 'No new messages.';
      },
    };
  }
  // Runs: one task through steps on different agents (see runs.ts).
  const pushRun = (r: Run) => { saveRuns(runsFile, runs, Date.now()); broadcast({ type: 'run', run: r }); };
  const stepOf = (id: string) => {
    for (const r of runs.values()) if ((r.status === 'running' || r.status === 'waiting') && r.steps[r.current].sessionId === id) return r;
    return null;
  };
  async function startStep(r: Run, i: number) {
    const step = r.steps[i];
    r.current = i; step.status = 'running'; r.status = 'running'; r.note = null;
    pushRun(r);
    try {
      const first = r.dir === null;
      const task = stepPrompt(r, i);
      // A worktree's branch is named after the run, not after the step's long first message.
      const c = await createSession({ agent: step.agent, repo: r.dir ?? r.repo, task, worktree: first && r.worktree, ...(first && r.worktree ? { branch: `aw/run-${r.id}` } : {}), claudeBin: cfg.claudeBin, home: opts.home ?? homeDir(), prefix: opts.tmuxPrefix, spawnDirect });
      if (first) { r.dir = c.dir; await excludeRunFiles(c.dir).catch(() => {}); }
      step.pane = c.pane ?? null; step.direct = c.direct ? c.tmuxSession : null;
      await store.addStarting({ tmuxSession: c.tmuxSession, pane: c.pane ?? null, direct: step.direct, dir: c.dir, task: `${STEP_KINDS[step.kind].label}: ${r.task}`, agent: step.agent });
    } catch (e) {
      r.status = 'failed'; r.note = `Step ${i + 1} could not start: ${(e as Error).message}`;
    }
    pushRun(r);
  }
  /** The current step is over (handed off, or you moved it on): wait at a checkpoint, or start the next. */
  async function stepOver(r: Run, summary: string | null, force = false) {
    const step = r.steps[r.current];
    const s = step.sessionId ? store.sessions.get(step.sessionId) : undefined;
    r.handoff = s ? { path: await writeHandoff(s, opts.home ?? homeDir()), summary } : r.handoff;
    step.status = 'handed'; step.summary = summary;
    if (r.current + 1 >= r.steps.length) { r.status = 'done'; r.note = null; return pushRun(r); }
    if (step.checkpoint && !force) { r.status = 'waiting'; r.note = `${STEP_KINDS[step.kind].label} is done: check it, then go on to ${STEP_KINDS[r.steps[r.current + 1].kind].label}.`; return pushRun(r); }
    await startStep(r, r.current + 1);
  }
  async function handoff(id: string, summary: string): Promise<string | Error> {
    const r = stepOf(id);
    if (!r || r.steps[r.current].status !== 'running') return new Error('this session is not the current step of a run, so there is nothing to hand off');
    const step = r.steps[r.current];
    await stepOver(r, summary);
    return r.status === 'waiting' && r.steps[r.current] === step ? 'Handed off. The user checks your work before the next step starts; you can stop here.'
      : r.status === 'done' ? 'Handed off: that was the last step, the run is done.' : 'Handed off: the next step has started. You can stop here.';
  }
  /** A step's session: link it on its first hook; a turn that ends without a handoff needs you. */
  function runEvent(s: { id: string; state: string; tmux: { pane: string } | null; direct: string | null }, ev: string) {
    for (const r of runs.values()) {
      const step = r.steps[r.current];
      if ((r.status !== 'running' && r.status !== 'waiting') || step.status !== 'running') continue;
      // Its first hook, or a new conversation in the same pane (/clear) after the old one went away
      if (!step.sessionId && ((step.pane && s.tmux?.pane === step.pane) || (step.direct && s.direct === step.direct))) { step.sessionId = s.id; pushRun(r); }
      if (r.status === 'running' && step.sessionId === s.id && (ev === 'Stop' || ev === 'StopFailure') && (s.state === 'done' || s.state === 'error')) {
        r.status = 'waiting'; r.note = `${STEP_KINDS[step.kind].label} ended its turn without handing off: talk to it, or go on.`;
        pushRun(r);
      }
    }
  }
  function runSessionGone(id: string) {
    const r = stepOf(id);
    if (!r || r.steps[r.current].status !== 'running') return;
    r.status = 'waiting'; r.note = `${STEP_KINDS[r.steps[r.current].kind].label}'s session ended before handing off.`;
    r.steps[r.current].sessionId = null; // gone: a handoff can't read it
    pushRun(r);
  }

  /** Tell sessions that are free (at their prompt, or their turn ended) that mail is waiting, by typing a notice into them. */
  async function deliverMail() {
    for (const id of mailbox.waiting()) {
      const s = store.sessions.get(id);
      if (!s) { mailbox.forget(id); continue; }
      if (!['idle', 'done', 'error'].includes(s.state) || s.pending.length) continue;
      const mail = mailbox.unnotified(id);
      const from = [...new Set(mail.map((m) => store.sessions.get(m.from)).filter((x) => !!x).map(label))].join(', ') || 'another session';
      const notice = `${MAIL_NOTICE} ${mail.length === 1 ? 'A new message' : `${mail.length} new messages`} from ${from}: call the aw_inbox tool to read, and aw_send to reply.`;
      const typed = s.direct ? direct.type(s.direct, notice) : s.tmux ? await (opts.typeInto ?? sys.typeInto)(s.tmux.pane, notice) : false;
      if (typed) for (const m of mail) m.notified = true;
    }
  }

  // One server per listen address (e.g. 127.0.0.1 plus a private VPN address for a phone).
  const servers = cfg.listen.map(() => createServer(onRequest).on('upgrade', onUpgrade));

  let sweeper: NodeJS.Timeout | null = null;
  let interrupts: NodeJS.Timeout | null = null;
  let scanner: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  return {
    server: servers[0], servers, store, scan, deliverMail,
    listen(): Promise<void> {
      sweeper = setInterval(sweepNow, 15_000);
      sweeper.unref();
      interrupts = setInterval(() => { void store.checkInterrupts(); store.checkBusy(); void deliverMail(); }, 2_000);
      interrupts.unref();
      const rescan = () => scan().catch((e) => console.error('[agent-worlds] process scan failed', e));
      void rescan();
      scanner = setInterval(rescan, 10_000);
      scanner.unref();
      heartbeat = setInterval(() => {
        for (const c of [...wss.clients, ...ptys.clients]) {
          if (!alive.delete(c)) c.terminate();
          else c.ping();
        }
      }, 30_000);
      heartbeat.unref();
      return Promise.all(servers.map((srv, i) => new Promise<void>((ok, fail) => {
        srv.once('error', fail);
        srv.listen(cfg.port, cfg.listen[i], () => ok());
      }))).then(() => {});
    },
    close(): Promise<void> {
      if (sweeper) clearInterval(sweeper);
      if (interrupts) clearInterval(interrupts);
      if (scanner) clearInterval(scanner);
      if (heartbeat) clearInterval(heartbeat);
      tunnel.stop();
      stopWatch?.();
      direct.killAll();
      for (const s of [...store.sessions.values()]) store.remove(s);
      for (const c of [...wss.clients, ...ptys.clients]) c.terminate();
      return Promise.all(servers.map((srv) => new Promise<void>((ok) => { srv.close(() => ok()); srv.closeAllConnections(); }))).then(() => {});
    },
  };
}

/** Live terminals across all sessions; each one is a `tmux attach` process. */
const MAX_PTYS = 16;

const dim = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000 ? (v as number) : d);

async function attachPty(ws: WebSocket, session: string, spawn: (session: string, cols: number, rows: number) => Promise<PtyLike>, onEnd?: () => void) {
  let term: PtyLike | null = null;
  const early: string[] = [];
  let size: [number, number] = [80, 24];
  let closed = false;
  ws.on('message', (raw) => {
    let msg: { t?: string; d?: unknown; cols?: unknown; rows?: unknown };
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'in' && typeof msg.d === 'string') { if (term) term.write(msg.d); else early.push(msg.d); }
    else if (msg.t === 'resize') { size = [dim(msg.cols, 80), dim(msg.rows, 24)]; term?.resize(...size); }
  });
  ws.on('close', () => { closed = true; term?.kill(); });
  try {
    term = await spawn(session, ...size);
  } catch (e) {
    console.error('[agent-worlds] pty spawn failed', e);
    return ws.close(1011, 'pty failed');
  }
  if (closed) return term.kill();
  term.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  term.onExit(() => { onEnd?.(); if (ws.readyState === 1) ws.close(1000, 'detached'); });
  term.resize(...size);
  for (const d of early.splice(0)) term.write(d);
}
