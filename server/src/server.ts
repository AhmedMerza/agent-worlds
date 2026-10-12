import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { homeDir, type Config } from './config.ts';
import { Store } from './store.ts';
import { Stats } from './rules.ts';
import { Insights, type Summarise } from './insights.ts';
import * as sys from './sys.ts';
import { Worlds } from './worlds.ts';

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
  home?: string; summarise?: Summarise; resolveRepo?: ConstructorParameters<typeof Worlds>[2]; createSession?: typeof sys.createSession;
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
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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
  let insights: Insights | null = null;
  const broadcast = (msg: { type: string; id?: string; [k: string]: unknown }) => {
    if (msg.type === 'session-removed' && msg.id) insights?.forget(msg.id);
    const text = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(text);
  };
  const store = new Store(cfg, {
    repoInfo: sys.repoInfo, branchOf: sys.branchOf, tmuxSessionOf: sys.tmuxSessionOf,
    clientsConnected: () => wss.clients.size > 0,
    holdMs: opts.holdMs ?? HOLD_MS,
    stats: new Stats(join(opts.home ?? homeDir(), 'stats.json')),
    onEvent: (s, ev) => insights?.onEvent(s, ev),
    ...opts.deps,
  }, broadcast);
  insights = new Insights(store, cfg.claudeBin, { summarise: opts.summarise, contextLimit: cfg.contextLimit });
  const createSession = opts.createSession ?? sys.createSession;
  // Claude runs identical hook commands once, but the same hook installed under two different
  // command strings (say a symlinked path globally plus our --settings file) would report every
  // event twice. A byte-identical payload within a few seconds gets the first one's reply instead.
  // Entries live while the first request is in flight and DEDUPE_MS after it settled.
  const recent = new Map<string, { at: number; reply: Promise<string> }>();
  const DEDUPE_MS = 500;
  const worlds = new Worlds(cfg, join(opts.home ?? homeDir(), 'config.json'), opts.resolveRepo);
  const worldsChanged = () => { broadcast({ type: 'worlds', worlds: cfg.worlds }); store.recomputeWorlds(); };
  const webDist = opts.webDist ?? WEB_DIST;
  const hostPort = (h: string) => `${h.includes(':') ? `[${h}]` : h}:${cfg.port}`;
  const allowed = new Set([...cfg.listen.map(hostPort), `localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`, ...cfg.extraHosts]);

  const authed = (req: IncomingMessage) => same(cookie(req, 'aw_token'), token) || same(req.headers['x-aw-token'] as string, token);
  const originOk = (req: IncomingMessage) => {
    const o = req.headers.origin;
    if (!o) return true;
    try { return allowed.has(new URL(o).host); } catch { return false; }
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

    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (!same(url.searchParams.get('token'), token)) return send(res, 401, 'bad token\n');
      res.writeHead(302, { 'set-cookie': `aw_token=${token}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
      return res.end();
    }
    if (!originOk(req)) return send(res, 403, { error: 'origin not allowed' });
    if ((method === 'GET' || method === 'HEAD') && PUBLIC_RE.test(url.pathname)) {
      try { await stat(join(webDist, url.pathname)); } catch { return send(res, 404, 'not found\n'); }
      return serveStatic(req, res, url.pathname);
    }
    if (!authed(req)) return send(res, 401, url.pathname.startsWith('/api/') ? { error: 'unauthorized' } : 'Unauthorized. Open the URL printed by `agent-worlds url`.\n');

    if (method === 'POST' && url.pathname === '/api/hook') {
      const body = await readBody(req);
      const pane = req.headers['x-aw-pane'];
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      const now = Date.now();
      for (const [k, v] of recent) if (v.at && now - v.at > DEDUPE_MS) recent.delete(k);
      const key = createHash('sha1').update(String(pane)).update('\0').update(JSON.stringify(body)).digest('hex');
      let reply = recent.get(key)?.reply;
      if (!reply) {
        reply = store.handle(body, typeof pane === 'string' && sys.PANE_RE.test(pane) ? pane : null, ac.signal);
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
    if (method === 'GET' && url.pathname === '/api/state') return send(res, 200, { worlds: cfg.worlds, sessions: store.list() });
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
      try {
        const r = await createSession({ repo: b.repo, task: (b.task as string) ?? '', worktree: b.worktree === true, branch: (b.branch as string) || undefined, claudeBin: cfg.claudeBin, home: opts.home ?? homeDir() });
        return send(res, 201, { tmuxSession: r.tmuxSession });
      } catch (e) { return send(res, 422, { error: (e as Error).message }); }
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
    if (!originOk(req)) return reject(403, 'Forbidden');
    if (!authed(req)) return reject(401, 'Unauthorized');
    if (url.pathname === '/ws') {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'snapshot', worlds: cfg.worlds, sessions: store.list() }));
      });
    }
    if (url.pathname === '/pty') {
      const s = store.sessions.get(url.searchParams.get('session') ?? '');
      if (!s?.tmux?.session) return reject(404, 'Not Found');
      const name = s.tmux.session;
      return ptys.handleUpgrade(req, socket, head, (ws) => attachPty(ws, name, opts.spawnPty ?? spawnTmuxPty));
    }
    reject(404, 'Not Found');
  };
  // One server per listen address (e.g. 127.0.0.1 plus a private VPN address for a phone).
  const servers = cfg.listen.map(() => createServer(onRequest).on('upgrade', onUpgrade));

  let sweeper: NodeJS.Timeout | null = null;
  return {
    server: servers[0], servers, store,
    listen(): Promise<void> {
      sweeper = setInterval(async () => {
        const alive = await sys.tmuxSessions();
        if (alive) store.sweep(alive);
      }, 15_000);
      sweeper.unref();
      return Promise.all(servers.map((srv, i) => new Promise<void>((ok, fail) => {
        srv.once('error', fail);
        srv.listen(cfg.port, cfg.listen[i], () => ok());
      }))).then(() => {});
    },
    close(): Promise<void> {
      if (sweeper) clearInterval(sweeper);
      for (const s of [...store.sessions.values()]) store.remove(s);
      for (const c of [...wss.clients, ...ptys.clients]) c.terminate();
      return Promise.all(servers.map((srv) => new Promise<void>((ok) => { srv.close(() => ok()); srv.closeAllConnections(); }))).then(() => {});
    },
  };
}

const dim = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000 ? (v as number) : d);

async function attachPty(ws: WebSocket, session: string, spawn: typeof spawnTmuxPty) {
  let term: Awaited<ReturnType<typeof spawnTmuxPty>> | null = null;
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
  term.onExit(() => { if (ws.readyState === 1) ws.close(1000, 'detached'); });
  term.resize(...size);
  for (const d of early.splice(0)) term.write(d);
}
