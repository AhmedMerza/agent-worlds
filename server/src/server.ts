import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.ts';
import { Store } from './store.ts';
import * as sys from './sys.ts';

/** How long a PermissionRequest is held for the GUI. Must stay below the hook `timeout` (3600 s) printed by `hooks --print`. */
export const HOLD_MS = 3540_000;
const MAX_BODY = 10 * 1024 * 1024;
const WEB_DIST = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

type Opts = { holdMs?: number; deps?: Partial<ConstructorParameters<typeof Store>[1]>; webDist?: string; spawnPty?: typeof spawnTmuxPty };

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
  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const c of wss.clients) if (c.readyState === 1) c.send(text);
  };
  const store = new Store(cfg, {
    repoInfo: sys.repoInfo, branchOf: sys.branchOf, tmuxSessionOf: sys.tmuxSessionOf,
    clientsConnected: () => wss.clients.size > 0,
    holdMs: opts.holdMs ?? HOLD_MS,
    ...opts.deps,
  }, broadcast);
  const webDist = opts.webDist ?? WEB_DIST;
  const allowed = new Set([`${cfg.host}:${cfg.port}`, `localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`, `[::1]:${cfg.port}`, ...cfg.extraHosts]);

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
    if (!authed(req)) return send(res, 401, url.pathname.startsWith('/api/') ? { error: 'unauthorized' } : 'Unauthorized. Open the URL printed by `agent-worlds url`.\n');

    if (method === 'POST' && url.pathname === '/api/hook') {
      const body = await readBody(req);
      const pane = req.headers['x-aw-pane'];
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableFinished) ac.abort(); });
      let out: string;
      try {
        out = await store.handle(body, typeof pane === 'string' && sys.PANE_RE.test(pane) ? pane : null, ac.signal);
      } catch (e) { return send(res, 400, { error: (e as Error).message }); }
      if (res.destroyed) return;
      if (!out) { res.writeHead(204); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(out);
    }
    if (method === 'GET' && url.pathname === '/api/state') return send(res, 200, { worlds: cfg.worlds, sessions: store.list() });

    const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(permission|answer|input|ack)$/);
    if (m && method === 'POST') {
      const id = decodeURIComponent(m[1]);
      const body = await readBody(req);
      if (m[2] === 'permission' || m[2] === 'answer') {
        const err = m[2] === 'permission' ? store.decide(id, body) : store.answer(id, body);
        return err ? send(res, err[0], { error: err[1] }) : send(res, 200, { ok: true });
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

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      const status = (e as { status?: number }).status ?? 500;
      if (status === 500) console.error('[agent-worlds]', e);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message });
      else res.destroy();
    });
  });

  server.on('upgrade', (req, socket, head) => {
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
  });

  let sweeper: NodeJS.Timeout | null = null;
  return {
    server, store,
    listen(): Promise<void> {
      sweeper = setInterval(async () => {
        const alive = await sys.tmuxSessions();
        if (alive) store.sweep(alive);
      }, 15_000);
      sweeper.unref();
      return new Promise((ok, fail) => { server.once('error', fail); server.listen(cfg.port, cfg.host, () => ok()); });
    },
    close(): Promise<void> {
      if (sweeper) clearInterval(sweeper);
      for (const s of [...store.sessions.values()]) store.remove(s);
      for (const c of [...wss.clients, ...ptys.clients]) c.terminate();
      return new Promise((ok) => { server.close(() => ok()); server.closeAllConnections(); });
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
