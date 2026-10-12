// Tiny stand-in for the Agent Worlds server, for developing the UI without it.
// Usage: node mock/server.mjs   (port 4322; also serves ../dist). No dependencies.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.MOCK_PORT || 4322)
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const MIN = 60000
const now = () => Date.now()

const worlds = [
  { id: 'web', name: 'Web', color: '#47b4a7', repos: ['/work/repo-a', '/work/repo-b', '/work/repo-c', '/work/repo-d'] },
  { id: 'mobile', name: 'Mobile', color: '#e07aa8', repos: ['/work/repo-e', '/work/repo-f', '/work/repo-g'] },
  { id: 'tools', name: 'Tools', color: '#9c88df', repos: ['/work/repo-h'] },
]
const mkSession = (id, worldId, over) => ({
  id, worldId, repo: `/work/${id}`, repoName: id, cwd: `/work/${id}`, branch: 'main', worktree: false,
  tmux: { session: `aw-${id}`, pane: '%1' }, state: 'working', waitingSince: null, task: `Task for ${id}`,
  now: 'Working', log: [{ t: now() - 2 * MIN, text: 'Read a file' }, { t: now() - MIN, text: 'Edited a file' }],
  helpers: [], card: null, catchup: null, catchupRunning: false, catchupAt: null, context: null, conflicts: [], startedAt: now() - 30 * MIN, updatedAt: now(), ...over,
})
const perm = (cmd, risky = null) => ({ kind: 'permission', requestId: crypto.randomUUID(), tool: 'Bash', command: cmd, input: { command: cmd }, risky, seenCount: 0, live: true })
const sessions = new Map(Object.entries({
  'repo-a': mkSession('repo-a', 'web', { branch: 'feat/filter', worktree: true, context: { used: 24000, limit: 200000, pct: 12 }, helpers: [{ id: 'h1', task: 'Search for the endpoint', state: 'working', startedAt: now() }, { id: 'h2', task: 'Check labels', state: 'done', startedAt: now() }],
    conflicts: [{ withId: 'repo-b', reason: 'both edit the table component' }, { withId: 'repo-e', reason: 'same API client' }],
    catchupAt: now() - 4 * MIN, catchup: { asked: 'Add a filter to the table', did: 'Wired the dropdown to the API', needs: '' } }),
  'repo-b': mkSession('repo-b', 'web', { state: 'waiting', waitingSince: now() - 3 * MIN, now: 'Waiting for you to allow a command', card: perm('npm run migrate -- --force', 'changes a database'), context: { used: 70000, limit: 200000, pct: 35 } }),
  'repo-c': mkSession('repo-c', 'web', { state: 'waiting', waitingSince: now() - 14 * MIN, now: 'Waiting for your answer',
    card: { kind: 'question', requestId: crypto.randomUUID(), live: true, questions: [{ question: 'Where should the new categories go?', header: 'Parent', multiSelect: false, options: [{ label: 'Under Restaurants', description: 'Nested one level' }, { label: 'New top-level category', description: '' }, { label: 'Leave unassigned', description: '' }] }] } }),
  'repo-d': mkSession('repo-d', 'web', { state: 'done', waitingSince: now() - 8 * MIN, now: 'Finished', card: { kind: 'done', summary: 'Fixed the badge count. All 12 tests pass.', review: { files: [{ path: 'src/badge.ts', added: 6, deleted: 3 }, { path: 'src/cart.ts', added: 4, deleted: 9 }], tests: { command: 'npm test', ok: true, line: '12 passed, 0 failed' }, diff: ['@@ src/badge.ts @@', '-const n = cache.count', '+const n = fresh.count', ...Array.from({ length: 450 }, (_, i) => (i % 3 ? ` context ${i}` : `+added line ${i}`))].join('\n') } }, context: { used: 140000, limit: 200000, pct: 70 } }),
  'repo-e': mkSession('repo-e', 'mobile', { conflicts: [{ withId: 'repo-f', reason: 'both touch sync' }], state: 'error', waitingSince: now() - 26 * MIN, now: 'Stopped after failing tests', card: { kind: 'error', summary: '3 of 41 tests fail in the sync suite.' }, context: { used: 170000, limit: 200000, pct: 85 } }),
  'repo-f': mkSession('repo-f', 'mobile', { conflicts: [{ withId: 'repo-e', reason: 'both touch sync' }], helpers: [1, 2, 3, 4, 5].map((n) => ({ id: `h${n}`, task: `Helper ${n}`, state: n % 2 ? 'working' : 'done', startedAt: now() })) }),
  'repo-g': mkSession('repo-g', 'mobile', { state: 'idle', now: 'Ready for a new task', context: { used: 5000, limit: 200000, pct: 3 } }),
  'repo-h': mkSession('repo-h', 'tools', { state: 'waiting', waitingSince: now() - MIN, now: 'Waiting for you to allow a command', card: { ...perm('npm run lint'), seenCount: 5 } }),
  'repo-j': mkSession('repo-j', 'tools', { state: 'waiting', waitingSince: now() - 2 * MIN, now: 'Waiting (terminal only)', card: { ...perm('rm -rf build'), live: false } }),
  'repo-i': mkSession('repo-i', null, { tmux: null, now: 'Running outside tmux' }),
}))

// ---- websocket plumbing (RFC 6455, text frames only) ----
const wsClients = new Set()
const frame = (text) => {
  const b = Buffer.from(text)
  const head = b.length < 126 ? Buffer.from([0x81, b.length]) : b.length < 65536 ? Buffer.from([0x81, 126, b.length >> 8, b.length & 255]) : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); return h })()
  return Buffer.concat([head, b])
}
function onFrames(socket, handler) {
  let buf = Buffer.alloc(0)
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    for (;;) {
      if (buf.length < 2) return
      const op = buf[0] & 15
      let len = buf[1] & 127, off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const masked = buf[1] & 128
      if (buf.length < off + (masked ? 4 : 0) + len) return
      const mask = masked ? buf.subarray(off, off + 4) : null
      const payload = Buffer.from(buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len))
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
      buf = buf.subarray(off + (masked ? 4 : 0) + len)
      if (op === 8) { socket.end(Buffer.from([0x88, 0])); return }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue }
      if (op === 1) handler(payload.toString())
    }
  })
}
const broadcast = (msg) => { const f = frame(JSON.stringify(msg)); for (const s of wsClients) s.write(f) }
const upsert = (s) => { s.updatedAt = now(); broadcast({ type: 'session', session: s }) }

// ---- state transitions ----
function resume(s, text) { Object.assign(s, { state: 'working', waitingSince: null, card: null, now: text }); s.log.push({ t: now(), text }); upsert(s) }
function tick() {
  const list = [...sessions.values()]
  const s = list[Math.floor(Math.random() * list.length)]
  if (s.state === 'working' && Math.random() < 0.5) {
    Object.assign(s, { state: 'waiting', waitingSince: now(), now: 'Waiting for you to allow a command', card: perm('npm test') }); upsert(s)
  } else if (s.state === 'working') {
    Object.assign(s, { state: 'done', waitingSince: now(), now: 'Finished', card: { kind: 'done', summary: null, review: null } }); upsert(s)
  } else if (s.state === 'idle') {
    Object.assign(s, { state: 'working', now: 'Picked up a new task' }); upsert(s)
  }
}
setInterval(tick, 9000)

// ---- http ----
const readBody = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { res(JSON.parse(d || '{}')) } catch { res({}) } }) })
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { worlds, sessions: [...sessions.values()] })
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const b = await readBody(req)
    if (!b.task || !b.repo) return json(400, { message: 'Task and repo are required.' })
    if (/bad/.test(b.task)) return json(500, { message: 'Could not start tmux: no server running.' })
    const id = `repo-new-${sessions.size}`
    const s = mkSession(id, b.worldId, { repoName: path.basename(b.repo), repo: b.repo, task: b.task, worktree: !!b.worktree, branch: b.branch || (b.worktree ? 'feat/new' : 'main') })
    sessions.set(id, s); upsert(s)
    return json(201, { id, tmuxSession: s.tmux.session })
  }
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(permission|answer|input|ack|catchup)$/)
  if (req.method === 'POST' && m) {
    const s = sessions.get(decodeURIComponent(m[1]))
    if (!s) return json(404, { error: 'no such session' })
    const body = await readBody(req)
    if (m[2] === 'catchup') {
      if (s.catchupRunning) return json(409, { error: 'Catch-up is already running.' })
      s.catchupRunning = true; upsert(s)
      setTimeout(() => { s.catchupRunning = false; s.catchupAt = now(); s.catchup = { asked: s.task, did: `Worked on ${s.id}. (mock summary)`, needs: s.card ? 'Your decision on the open request' : '' }; upsert(s) }, 1500)
      res.writeHead(202, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}')
    }
    if (m[2] === 'permission') {
      if (s.card?.requestId !== body.requestId || s.card.live === false) return json(409, { error: 'That request is no longer live. Answer it in the terminal.' })
      resume(s, body.decision === 'allow' ? 'Running the command' : 'Looking for another way')
      broadcast({ type: 'toast', text: body.decision === 'allow' ? `Allowed (${body.scope}). ${s.id} is running.` : `Denied. ${s.id} was told no.` })
    } else if (m[2] === 'answer') {
      if (s.card?.requestId !== body.requestId || s.card.live === false) return json(409, { error: 'That request is no longer live. Answer it in the terminal.' })
      resume(s, 'Continuing with your answer')
      broadcast({ type: 'toast', text: `Answered ${s.id}.` })
    } else if (m[2] === 'ack') {
      Object.assign(s, { state: 'idle', waitingSince: null, card: null, now: 'Ready for a new task' }); upsert(s)
    } else { s.log.push({ t: now(), text: `Input: ${body.text}` }); upsert(s) }
    return json(200, { ok: true })
  }
  // static dist (SPA)
  let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('run `npm run build` first, or use vite on :5190') }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, 'http://x')
  const key = req.headers['sec-websocket-key']
  if (!key || !['/ws', '/pty'].includes(url.pathname)) return socket.destroy()
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  if (url.pathname === '/ws') {
    wsClients.add(socket)
    socket.on('close', () => wsClients.delete(socket))
    socket.on('error', () => wsClients.delete(socket))
    onFrames(socket, () => {})
    socket.write(frame(JSON.stringify({ type: 'snapshot', worlds, sessions: [...sessions.values()] })))
    return
  }
  // /pty: echo terminal
  const id = url.searchParams.get('session') || '?'
  socket.on('error', () => {})
  socket.write(frame(`\x1b[32mmock terminal for ${id}\x1b[0m\r\n$ `))
  onFrames(socket, (text) => {
    let m
    try { m = JSON.parse(text) } catch { return }
    if (m.t === 'in') socket.write(frame(String(m.d).replace(/\r/g, '\r\n$ ')))
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock server on http://127.0.0.1:${PORT}`))
