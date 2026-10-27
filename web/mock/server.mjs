// Tiny stand-in for the Agent Worlds server, for developing the UI without it.
// Usage: node mock/server.mjs   (port 4322; also serves ../dist). No dependencies.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.MOCK_PORT || 4322)
/** Servers added through New session ("Add a server of your own"), until the mock restarts. */
let servers = []
let defaultProvider = null
let phoneAllowed = false
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const MIN = 60000
const now = () => Date.now()

let worlds = process.env.MOCK_EMPTY ? [] : [
  { id: 'web', name: 'Web', color: '#47b4a7', repos: ['/work/repo-a', '/work/repo-b', '/work/repo-c', '/work/repo-d'], leadSpawn: true, maxSpawned: 3 },
  { id: 'mobile', name: 'Mobile', color: '#e07aa8', repos: ['/work/repo-e', '/work/repo-f', '/work/repo-g'] },
  { id: 'tools', name: 'Tools', color: '#9c88df', repos: ['/work/repo-h', '/work/repo-j'] },
]
const mkSession = (id, worldId, over) => ({
  id, worldId, repo: `/work/${id}`, repoName: id, cwd: `/work/${id}`, branch: 'main', worktree: false,
  tmux: { session: `aw-${id}`, pane: '%1' }, state: 'working', waitingSince: null, task: `Task for ${id}`,
  now: 'Working', log: [{ t: now() - 2 * MIN, text: 'Read a file' }, { t: now() - MIN, text: 'Edited a file' }],
  helpers: [], card: null, catchup: null, catchupRunning: false, catchupAt: null, context: null, conflicts: [], startedAt: now() - 30 * MIN, updatedAt: now(), ...over,
})
const perm = (cmd, risky = null) => ({ kind: 'permission', requestId: crypto.randomUUID(), tool: 'Bash', command: cmd, target: { type: 'command', value: cmd }, input: { command: cmd }, risky, seenCount: 0, live: true })
const permOf = (tool, type, value) => ({ kind: 'permission', requestId: crypto.randomUUID(), tool, command: null, target: { type, value }, input: {}, risky: null, seenCount: 0, live: true })
const sessions = new Map(Object.entries({
  'repo-a': mkSession('repo-a', 'web', { branch: 'feat/filter', worktree: true, context: { used: 24000, limit: 200000, pct: 12 }, usage: { input: 1200, output: 38000, cacheRead: 2_400_000, cacheWrite: 180000 }, helpers: [{ id: 'h1', task: 'Search for the endpoint', state: 'working', startedAt: now() }, { id: 'h2', task: 'Check labels', state: 'done', startedAt: now() }],
    conflicts: [{ withId: 'repo-b', reason: 'both edit the table component' }, { withId: 'repo-e', reason: 'same API client' }],
    catchupAt: now() - 4 * MIN, catchupStale: true, lastPrompt: 'Also make the filter remember its value', catchup: { asked: 'Add a filter to the table', did: 'Wired the dropdown to the API', needs: 'none' } }),
  'repo-b': mkSession('repo-b', 'web', { state: 'waiting', waitingSince: now() - 3 * MIN, now: 'Waiting for you to allow a command', card: perm('npm run migrate -- --force', 'changes a database'), context: { used: 70000, limit: 200000, pct: 35 }, usage: { input: 800, output: 12000, cacheRead: 640000, cacheWrite: 70000 } }),
  'repo-c': mkSession('repo-c', 'web', { state: 'waiting', waitingSince: now() - 14 * MIN, now: 'Waiting for your answer',
    card: { kind: 'question', requestId: crypto.randomUUID(), live: true, questions: [{ question: 'Where should the new categories go?', header: 'Parent', multiSelect: false, options: [{ label: 'Under Restaurants', description: 'Nested one level' }, { label: 'New top-level category', description: '' }, { label: 'Leave unassigned', description: '' }] }] } }),
  'repo-d': mkSession('repo-d', 'web', { state: 'done', waitingSince: now() - 8 * MIN, now: 'Finished', card: { kind: 'done', summary: 'Fixed the badge count. All 12 tests pass.', review: { baseSha: 'a1b2c3d4e5f6', files: [{ path: 'src/badge.ts', added: 6, deleted: 3 }, { path: 'src/cart.ts', added: 4, deleted: 9 }], commits: [{ sha: '9f8e7d6c5b4a', subject: 'Use the fresh cart count in the badge' }], uncommitted: [{ path: 'src/cart.ts', added: 4, deleted: 9 }], tests: { command: 'npm test', ok: true, line: '12 passed, 0 failed' }, diff: ['@@ src/badge.ts @@', '-const n = cache.count', '+const n = fresh.count', ...Array.from({ length: 450 }, (_, i) => (i % 3 ? ` context ${i}` : `+added line ${i}`))].join('\n') } }, context: { used: 140000, limit: 200000, pct: 70 } }),
  'repo-e': mkSession('repo-e', 'mobile', { conflicts: [{ withId: 'repo-f', reason: 'both touch sync' }], state: 'error', waitingSince: now() - 26 * MIN, now: 'Stopped after failing tests', card: { kind: 'error', summary: '3 of 41 tests fail in the sync suite.' }, context: { used: 170000, limit: 200000, pct: 85 } }),
  'repo-f': mkSession('repo-f', 'mobile', { conflicts: [{ withId: 'repo-e', reason: 'both touch sync' }], helpers: [1, 2, 3, 4, 5].map((n) => ({ id: `h${n}`, task: `Helper ${n}`, state: n % 2 ? 'working' : 'done', startedAt: now() })) }),
  'repo-g': mkSession('repo-g', 'mobile', { state: 'idle', now: 'Ready for a new task', context: { used: 5000, limit: 200000, pct: 3 } }),
  'repo-h': mkSession('repo-h', 'tools', { state: 'waiting', waitingSince: now() - MIN, now: 'Waiting for you to allow a command', card: { ...perm('npm run lint'), seenCount: 5 } }),
  'repo-j': mkSession('repo-j', 'tools', { agent: 'codex', state: 'waiting', waitingSince: now() - 2 * MIN, now: 'Waiting (terminal only)', card: { ...perm('rm -rf build'), live: false } }),
  'repo-t': mkSession('repo-t', 'web', { branch: 'fix/totals', worktree: true, state: 'waiting', waitingSince: now() - 4 * MIN, now: 'Waiting for your reply', card: { kind: 'asking', summary: 'I fixed the rounding. Do you want the same change in the invoice totals as well?' } }),
  'repo-v': mkSession('repo-v', 'tools', { state: 'waiting', waitingSince: now() - 7 * MIN, now: 'AskUserQuestion: Which test runner should I use?', card: { kind: 'question', requestId: crypto.randomUUID(), live: false, questions: [{ question: 'Which test runner should I use?', header: 'Runner', multiSelect: false, options: [{ label: 'Vitest', description: 'Already installed' }, { label: 'Jest', description: '' }] }] } }),
  'repo-w': mkSession('repo-w', 'tools', { state: 'done', waitingSince: now() - 9 * MIN, now: 'Bash', card: { kind: 'done', summary: 'Committed the change.', review: { baseSha: 'c0ffee', files: [{ path: 'src/a.ts', added: 3, deleted: 1 }], commits: [{ sha: 'd00dfeed1234', subject: 'Tighten the parser' }], uncommitted: [], tests: null, diff: '@@ src/a.ts @@\n-old\n+new' } } }),
  'repo-q': mkSession('repo-q', 'web', { state: 'waiting', waitingSince: now() - 2 * MIN, now: 'Waiting to edit a file', card: permOf('Edit', 'file', '/work/repo-q/src/app.ts') }),
  'repo-r': mkSession('repo-r', 'mobile', { state: 'waiting', waitingSince: now() - 5 * MIN, now: 'Waiting to open an address', card: permOf('WebFetch', 'url', 'https://example.com/docs') }),
  'repo-s': mkSession('repo-s', 'mobile', { state: 'waiting', waitingSince: now() - 6 * MIN, now: 'Waiting', card: permOf('Grep', 'other', 'TODO') }),
  'repo-i': mkSession('repo-i', null, { tmux: null, now: 'Running outside tmux' }),
}))

// ---- import: processes running outside Agent Worlds, and past sessions ----
let unmanaged = process.env.MOCK_EMPTY ? [] : [
  { pid: 4121, cwd: '/work/repo-k', repo: '/work/repo-k', worldId: 'web', sessionId: 'sess-k', inTmux: false, since: now() - 12 * MIN },
  ...Array.from({ length: Number(process.env.MOCK_GHOSTS ?? 9) }, (_, i) => ({ pid: 6000 + i, cwd: `/work/other-${i}`, repo: null, worldId: null, sessionId: null, inTmux: i % 2 === 0, since: now() - (i + 1) * MIN })),
  { pid: 5230, cwd: '/work/repo-m', repo: null, worldId: null, sessionId: null, inTmux: true, since: now() - 3 * MIN },
]
const history = [
  { sessionId: 'sess-k', cwd: '/work/repo-k', repo: '/work/repo-k', worldId: 'web', lastPrompt: 'Refactor the checkout form validation', lastActivity: now() - 12 * MIN, running: true, managed: false },
  { sessionId: 'sess-codex', agent: 'codex', cwd: '/work/repo-j', repo: '/work/repo-j', worldId: 'tools', lastPrompt: 'Review the deployment scripts', lastActivity: now() - 45 * MIN, running: false, managed: false },
  { sessionId: 'sess-n', cwd: '/work/repo-n', repo: '/work/repo-n', worldId: 'mobile', lastPrompt: 'Add dark mode to the settings screen', lastActivity: now() - 3 * 60 * MIN, running: false, managed: false },
  { sessionId: 'sess-p', cwd: '/work/repo-p', repo: '/work/repo-p', worldId: 'tools', lastPrompt: 'Write a script that prunes old build artifacts', lastActivity: now() - 30 * 60 * MIN, running: false, managed: false },
  { sessionId: 'repo-a', cwd: '/work/repo-a', repo: '/work/repo-a', worldId: 'web', lastPrompt: 'Add a filter to the table', lastActivity: now() - 4 * MIN, running: true, managed: true },
]
let recoverable = process.env.MOCK_RECOVERY ? [
  { id: 'sess-codex', agent: 'codex', cwd: '/work/repo-j', task: 'Review the deployment scripts', lastPrompt: 'Review the deployment scripts', updatedAt: now() - 45 * MIN },
] : []
if (recoverable.length) history.find((h) => h.sessionId === 'sess-codex').interrupted = true

// ---- demo mode (MOCK_DEMO=1 | worlds): deterministic data for recording the README media ----
// 1 = two worlds with five sessions; "worlds" = no worlds yet, same sessions (their repos live in /tmp/demo/*).
// Steps are driven from outside: POST /api/demo/ask (repo-b needs a permission) and /api/demo/done (repo-a finishes).
const DEMO = process.env.MOCK_DEMO
const DEMO_DIR = '/tmp/demo'
if (DEMO) {
  const w = (id) => (DEMO === 'worlds' ? null : id)
  worlds = DEMO === 'worlds' ? [] : [
    { id: 'web', name: 'Web', color: '#47b4a7', repos: [`${DEMO_DIR}/repo-a`, `${DEMO_DIR}/repo-b`, `${DEMO_DIR}/repo-c`] },
    { id: 'mobile', name: 'Mobile', color: '#e07aa8', repos: [`${DEMO_DIR}/repo-d`, `${DEMO_DIR}/repo-e`] },
  ]
  sessions.clear(); unmanaged = []
  const add = (id, world, i, over) => sessions.set(id, mkSession(id, w(world), { repo: `${DEMO_DIR}/${id}`, cwd: `${DEMO_DIR}/${id}`, startedAt: now() - (60 - i) * MIN, ...over }))
  add('repo-a', 'web', 1, { task: 'Add a status filter to the orders table', branch: 'feat/orders-filter', worktree: true, context: { used: 36000, limit: 200000, pct: 18 }, now: 'Editing the orders table',
    helpers: [{ id: 'h1', task: 'Find the orders endpoint', state: 'working', startedAt: now() }], demo: { did: 'Added the filter dropdown and wired it to the orders API.', needs: '' } })
  add('repo-b', 'web', 2, { task: 'Write the migration for payment status', branch: 'feat/payment-status', context: { used: 68000, limit: 200000, pct: 34 }, now: 'Writing the migration', demo: { did: 'Wrote the migration and the model field.', needs: 'Your OK to run the migration' } })
  add('repo-c', 'web', 3, { task: 'Update the deploy checklist', state: 'idle', now: 'Ready for a new task', context: { used: 16000, limit: 200000, pct: 8 }, demo: { did: 'Updated the checklist and stopped.', needs: '' } })
  add('repo-d', 'mobile', 4, { task: 'Build the printer settings screen', branch: 'feat/printer-settings', context: { used: 122000, limit: 200000, pct: 61 }, now: 'Building the settings screen',
    helpers: [{ id: 'h1', task: 'Read the settings screens', state: 'working', startedAt: now() }, { id: 'h2', task: 'Draft the labels', state: 'working', startedAt: now() }, { id: 'h3', task: 'Check permissions', state: 'done', startedAt: now() }], demo: { did: 'Created the settings page.', needs: '' } })
  add('repo-e', 'mobile', 5, { task: 'Fix the cart badge count', branch: 'fix/cart-badge', context: { used: 44000, limit: 200000, pct: 22 }, now: 'Fixing the badge count', demo: { did: 'Switched the badge to the fresh cart count.', needs: '' } })
}
const demoStep = {
  ask(s) { Object.assign(s, { state: 'waiting', waitingSince: now(), now: 'Waiting for you to allow a command', card: perm('npm run migrate -- --force', 'changes a database') }) },
  done(s) {
    Object.assign(s, { state: 'done', waitingSince: now(), now: 'Finished', card: { kind: 'done', summary: 'Added the status filter and wired it to the orders API. All 14 tests pass.', review: {
      baseSha: 'b7c8d9e0f1a2', commits: [], uncommitted: [{ path: 'src/orders/OrdersTable.vue', added: 31, deleted: 4 }, { path: 'src/orders/useOrders.ts', added: 12, deleted: 2 }, { path: 'tests/orders.test.ts', added: 40, deleted: 0 }],
      files: [{ path: 'src/orders/OrdersTable.vue', added: 31, deleted: 4 }, { path: 'src/orders/useOrders.ts', added: 12, deleted: 2 }, { path: 'tests/orders.test.ts', added: 40, deleted: 0 }],
      tests: { command: 'npm test', ok: true, line: '14 passed, 0 failed' },
      diff: ['@@ src/orders/OrdersTable.vue @@', '-  <th>Status</th>', '+  <th><StatusFilter v-model="status" /></th>', ' ', '@@ src/orders/useOrders.ts @@', '-export function useOrders() {', '+export function useOrders(status: Ref<string>) {', "+  const params = computed(() => ({ status: status.value }))"].join('\n') } } })
  },
}

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

// Reproducible visual-load fixture: MOCK_SESSIONS=25 MOCK_SINGLE_WORLD=1 MOCK_NOTICK=1.
if (process.env.MOCK_SESSIONS) {
  const count = Number(process.env.MOCK_SESSIONS)
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('MOCK_SESSIONS must be an integer from 1 to 500')
  sessions.clear(); unmanaged = []; recoverable = []
  // MOCK_WORLDS=10: that many worlds instead of the three above.
  if (process.env.MOCK_WORLDS) worlds = Array.from({ length: Number(process.env.MOCK_WORLDS) }, (_, i) => ({ id: `w${i + 1}`, name: `World ${i + 1}`, color: `hsl(${(i * 47) % 360} 55% 60%)`, repos: [] }))
  worlds.forEach(w => { w.repos = [] })
  for (let i = 0; i < count; i++) {
    const id = `session-${String(i + 1).padStart(2, '0')}`
    const w = worlds[process.env.MOCK_SINGLE_WORLD ? 0 : i % worlds.length]
    const state = ['working', 'waiting', 'idle', 'done', 'error'][i % 5]
    w.repos.push(`/work/${id}`)
    sessions.set(id, mkSession(id, w.id, {
      startedAt: 1000 + i, state, task: `Review task ${i + 1}`, now: state === 'waiting' ? 'Waiting for you to allow a command' : state,
      waitingSince: ['waiting', 'done', 'error'].includes(state) ? now() - (i + 1) * MIN : null,
      card: state === 'waiting' ? perm('npm test') : state === 'done' ? { kind: 'done', summary: `Finished task ${i + 1}`, review: null } : state === 'error' ? { kind: 'error', summary: `Tests failed for task ${i + 1}` } : null,
    }))
  }
}

// ---- worlds: a session belongs to the first world listing its repo ----
const inRepo = (repo, root) => repo === root || repo.startsWith(root + '/')
function regroup() {
  for (const s of sessions.values()) {
    const w = worlds.find((x) => x.repos.some((r) => inRepo(s.repo, r)))
    const id = w ? w.id : null
    if (s.worldId !== id) { s.worldId = id; upsert(s) }
  }
}
const pushUnmanaged = () => broadcast({ type: 'unmanaged', unmanaged })
const pushWorlds = () => { regroup(); broadcast({ type: 'worlds', worlds }) }
let wseq = 1
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
if (!DEMO && !process.env.MOCK_NOTICK) setInterval(tick, 9000)
// Load test: MOCK_CHURN=5 sends that many small session updates a second (activity, context, working/idle).
if (process.env.MOCK_CHURN) setInterval(() => {
  const list = [...sessions.values()], s = list[Math.floor(Math.random() * list.length)]
  s.log = [...s.log.slice(-9), { t: now(), text: `Step ${Math.floor(Math.random() * 1000)}` }]
  s.context = { used: 1000, limit: 200000, pct: Math.floor(Math.random() * 90) }
  if (s.state === 'working' || s.state === 'idle') { s.state = Math.random() < 0.2 ? (s.state === 'working' ? 'idle' : 'working') : s.state; s.now = s.state }
  upsert(s)
}, 1000 / Number(process.env.MOCK_CHURN))

// ---- http ----
const runs = new Map()
const readBody = (req) => new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { res(JSON.parse(d || '{}')) } catch { res({}) } }) })
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.method === 'GET' && url.pathname === '/api/state') return json(200, { worlds, sessions: [...sessions.values()], recoverable, unmanaged })
  if (req.method === 'GET' && url.pathname === '/api/claude-defaults') return json(200, { permissionMode: 'acceptEdits' })
  if (req.method === 'GET' && url.pathname === '/api/agents') return json(200, { agents: [{ id: 'claude', name: 'Claude Code', installed: true, modes: true, models: true }, { id: 'codex', name: 'Codex', installed: true, modes: false, decides: false, task: true, models: true }, { id: 'qwen', name: 'Qwen Code', installed: true, modes: false, decides: false, task: true }, { id: 'kimi', name: 'Kimi Code', installed: true, modes: false, decides: false, task: true }, { id: 'gemini', name: 'Gemini CLI', installed: true, modes: false, decides: true, task: true }, { id: 'agy', name: 'Antigravity CLI', installed: true, modes: false, decides: false, task: true }], default: 'claude' })
  if (req.method === 'GET' && url.pathname === '/api/providers') return json(200, { providers: [{ id: 'openrouter', name: 'OpenRouter', model: 'openrouter/free', keyUrl: 'https://openrouter.ai/keys', hasKey: false }, { id: 'gemini', name: 'Gemini API', model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey', hasKey: true }, { id: 'anthropic', name: 'Anthropic', model: 'claude-sonnet-5-5', keyUrl: 'https://console.anthropic.com/settings/keys', hasKey: false }, ...servers], default: defaultProvider })
  if (req.method === 'POST' && url.pathname === '/api/providers/default') { defaultProvider = (await readBody(req)).provider || null; return json(200, { default: defaultProvider }) }
  if (req.method === 'POST' && url.pathname === '/api/providers') { const b = await readBody(req); const provider = { id: b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: b.name, model: b.model || 'qwen3.8-flash-next-iq3_s', hasKey: !!b.key, custom: true, baseUrl: b.baseUrl.replace(/\/+$/, '') }; servers = [...servers.filter((x) => x.id !== provider.id), provider]; return json(201, { provider }) }
  if (req.method === 'DELETE' && /^\/api\/providers\/[a-z0-9-]+$/.test(url.pathname)) { servers = servers.filter((x) => x.id !== url.pathname.split('/').pop()); return json(200, {}) }
  if (req.method === 'PUT' && /^\/api\/providers\/[a-z0-9-]+\/key$/.test(url.pathname)) return json(200, { hasKey: (await readBody(req)).key !== null })
  if (req.method === 'POST' && url.pathname === '/api/agents/default') return json(200, { default: 'codex' })
  if (req.method === 'POST' && url.pathname === '/api/agents/spawn') return json(200, { spawn: { claude: ['sonnet'], codex: [] } })
  if (req.method === 'GET' && url.pathname === '/api/history') return json(200, { sessions: history })
  if (req.method === 'POST' && url.pathname === '/api/sessions/resume-all') {
    const started = recoverable.map((s) => s.id)
    for (const r of recoverable) {
      const h = history.find((x) => x.sessionId === r.id)
      const s = mkSession(r.id, h?.worldId ?? null, { agent: r.agent, repoName: path.basename(r.cwd), repo: h?.repo ?? r.cwd, cwd: r.cwd, task: r.lastPrompt ?? r.task, state: 'idle', now: 'Resumed after restart' })
      sessions.set(r.id, s); upsert(s)
      if (h) { h.running = true; h.managed = true; h.interrupted = false }
    }
    recoverable = []
    broadcast({ type: 'recoverable', sessions: [] })
    return json(200, { started, failed: [] })
  }
  const recoveryMatch = url.pathname.match(/^\/api\/recovery\/([^/]+)$/)
  if (req.method === 'DELETE' && recoveryMatch) {
    const id = decodeURIComponent(recoveryMatch[1])
    recoverable = recoverable.filter((s) => s.id !== id)
    const h = history.find((x) => x.sessionId === id)
    if (h) h.interrupted = false
    broadcast({ type: 'recoverable', sessions: recoverable })
    return json(200, { ok: true })
  }
  const hm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/)
  if (hm && req.method === 'GET') {
    const s = sessions.get(decodeURIComponent(hm[1]))
    if (!s) return json(404, { error: 'no such session' })
    if (s.state === 'starting' || (s.agent && !['claude', 'codex'].includes(s.agent))) return json(409, { error: 'no transcript yet for this session' })
    return json(200, { turns: [
      { who: 'you', text: s.task || 'Fix the failing checkout test' },
      { who: 'step', text: 'Read: src/checkout.ts' },
      { who: 'step', text: 'Grep: applyCoupon' },
      { who: 'step', text: 'Bash: npm test -- checkout' },
      { who: 'claude', text: 'Found it. `applyCoupon` rounds **before** adding tax, so totals drift by a cent:\n\n```ts\nconst total = round(subtotal - coupon) + tax\n```\n\nI will move the rounding to the end. See https://example.com/rounding for the rule.' },
      { who: 'you', text: 'ok go ahead' },
      { who: 'step', text: 'Edit: src/checkout.ts' },
      { who: 'step', text: 'Bash: npm test -- checkout' },
      { who: 'claude', text: 'Done. All 14 checkout tests pass.\n\n- moved `round()` after tax\n- added a test for a 3-item cart with a coupon' },
    ] })
  }
  // Phone: one made-up LAN address, no Tailscale; the QR link points nowhere real.
  if (req.method === 'GET' && url.pathname === '/api/phone') return json(200, { port: PORT, addresses: [{ address: '192.168.1.20', kind: 'lan', iface: 'wlan0', allowed: phoneAllowed }] })
  if (req.method === 'POST' && url.pathname === '/api/phone/allow') { phoneAllowed = (await readBody(req)).allow === true; return json(200, { ok: true }) }
  if (req.method === 'POST' && url.pathname === '/api/phone/pair') return phoneAllowed ? json(200, { url: `http://192.168.1.20:${PORT}/pair/demo-${Date.now().toString(36)}`, expiresAt: Date.now() + 300_000 }) : json(400, { error: 'phones are not allowed on that address' })
  if (req.method === 'POST' && url.pathname === '/api/sessions/resume') {
    const b = await readBody(req)
    console.log('resume', JSON.stringify(b))
    const h = history.find((x) => x.sessionId === b.sessionId)
    if (!h) return json(404, { error: 'No transcript for that session.' })
    if (h.running && !b.force && !b.stop) return json(409, { error: 'that session is still running', pid: unmanaged.find((u) => u.sessionId === h.sessionId)?.pid ?? null })
    unmanaged = unmanaged.filter((u) => u.sessionId !== h.sessionId); pushUnmanaged()
    h.running = true; h.managed = true
    const id = h.sessionId, tmux = `aw-${id}`
    h.interrupted = false
    const s = mkSession(id, h.worldId, { agent: h.agent, repoName: path.basename(h.repo), repo: h.repo, cwd: h.cwd, task: h.lastPrompt, state: 'starting', now: `Restoring saved ${h.agent === 'codex' ? 'Codex' : 'Claude Code'} conversation…`, tmux: { session: tmux, pane: '%9' } })
    sessions.set(`starting:${tmux}`, { ...s, id: `starting:${tmux}` }); upsert(sessions.get(`starting:${tmux}`))
    setTimeout(() => { sessions.delete(`starting:${tmux}`); broadcast({ type: 'session-removed', id: `starting:${tmux}` }); sessions.set(id, { ...s, state: 'idle', now: 'Resumed' }); upsert(sessions.get(id)) }, 2500)
    return json(201, { tmuxSession: tmux })
  }
  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    const b = await readBody(req)
    console.log('create', JSON.stringify(b))
    if (!b.repo) return json(400, { message: 'Task and repo are required.' })
    if (/bad/.test(b.task)) return json(500, { message: 'Could not start tmux: no server running.' })
    const id = `repo-new-${sessions.size}`
    const s = mkSession(id, b.worldId, { state: 'starting', now: 'Starting', repoName: path.basename(b.repo), repo: b.repo, task: b.task, agent: b.agent, via: b.provider ? `${b.provider} · ${b.model || 'default model'}` : null, worktree: !!b.worktree, branch: b.branch || (b.worktree ? 'feat/new' : 'main') })
    const sid = `starting:${s.tmux.session}`
    sessions.set(sid, { ...s, id: sid }); upsert(sessions.get(sid))
    setTimeout(() => { sessions.delete(sid); broadcast({ type: 'session-removed', id: sid }); sessions.set(id, { ...s, state: 'working', now: 'Working' }); upsert(sessions.get(id)) }, 2500)
    return json(201, { id, tmuxSession: s.tmux.session })
  }
  // Runs: the first step starts as a session and hands off at once, so its checkpoint shows under Needs you.
  if (req.method === 'POST' && url.pathname === '/api/runs') {
    const b = await readBody(req)
    console.log('run', JSON.stringify(b))
    if (!b.task) return json(400, { error: 'task must be a non-empty string up to 10000 chars' })
    const id = `run${runs.size + 1}`
    const sid = `repo-run-${sessions.size}`
    const s = mkSession(sid, b.worldId, { state: 'done', now: 'Done', repoName: path.basename(b.repo), repo: b.repo, task: `Plan: ${b.task}`, agent: b.steps[0].agent, card: { kind: 'done', summary: 'plan.md is ready', review: null } })
    sessions.set(sid, s); upsert(s)
    // Like the server: a step marked "Pause after" waits for you, any other goes straight on.
    const hold = b.steps[0].checkpoint || b.steps.length === 1
    const run = { id, task: b.task, worldId: b.worldId, repo: b.repo, dir: b.repo, current: hold ? 0 : 1, status: hold ? (b.steps.length === 1 ? 'done' : 'waiting') : 'running', note: hold && b.steps.length > 1 ? 'The first step is done. Read what it wrote, then start the next.' : null, startedAt: Date.now(),
      steps: b.steps.map((st, i) => ({ ...st, status: i === 0 ? 'handed' : i === 1 && !hold ? 'running' : 'pending', sessionId: i === 0 ? sid : null, summary: i === 0 ? 'Wrote the plan to plan.md: three changes, in cli.py and its test.' : null })) }
    runs.set(id, run); broadcast({ type: 'run', run })
    return json(201, { run })
  }
  const rn = url.pathname.match(/^\/api\/runs\/([^/]+)\/(next|stop)$/)
  if (req.method === 'POST' && rn) {
    const run = runs.get(rn[1])
    if (!run) return json(404, { error: 'no such run' })
    if (rn[2] === 'stop') { run.status = 'stopped'; run.note = null }
    else if (run.current + 1 >= run.steps.length) run.status = 'done'
    else { run.current++; run.steps[run.current].status = 'running'; run.status = 'running'; run.note = null }
    broadcast({ type: 'run', run })
    return json(200, { run })
  }
  const cm = url.pathname.match(/^\/api\/sessions\/([^/]+)\/continue$/)
  if (req.method === 'POST' && cm) {
    const src = sessions.get(decodeURIComponent(cm[1]))
    if (!src) return json(404, { error: 'no such session' })
    const b = await readBody(req)
    console.log('continue', cm[1], JSON.stringify(b))
    const id = `repo-new-${sessions.size}`
    const handoff = `/tmp/handoffs/${src.id}.md`
    const s = mkSession(id, src.worldId, { state: 'starting', now: 'Starting', repoName: src.repoName, repo: src.repo, cwd: src.cwd, task: `Read ${handoff} and carry on from there.`, agent: b.agent })
    const sid = `starting:${s.tmux.session}`
    sessions.set(sid, { ...s, id: sid }); upsert(sessions.get(sid))
    setTimeout(() => { sessions.delete(sid); broadcast({ type: 'session-removed', id: sid }); sessions.set(id, { ...s, state: 'working', now: 'Working' }); upsert(sessions.get(id)) }, 2500)
    return json(201, { tmuxSession: s.tmux.session, handoff })
  }
  const dm = url.pathname.match(/^\/api\/demo\/(ask|done)$/)
  if (DEMO && dm && req.method === 'POST') {
    const s = sessions.get(dm[1] === 'ask' ? 'repo-b' : 'repo-a')
    demoStep[dm[1]](s); upsert(s); return json(200, { ok: true })
  }
  if (url.pathname === '/api/fs' && req.method === 'GET') {
    const want = path.resolve(url.searchParams.get('path') || (DEMO ? DEMO_DIR : os.homedir()))
    if (DEMO && !(want === DEMO_DIR || want.startsWith(DEMO_DIR + '/'))) return json(400, { error: 'Demo mode only browses /tmp/demo.' })
    try {
      const entries = fs.readdirSync(want, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => { const p = path.join(want, d.name); return { name: d.name, path: p, isRepo: fs.existsSync(path.join(p, '.git')) } })
      return json(200, { path: want, parent: want === '/' ? null : path.dirname(want), entries })
    } catch (e) { return json(400, { error: `Cannot read ${want}: ${e.code || 'error'}` }) }
  }
  if (url.pathname === '/api/worlds/order' && req.method === 'POST') {
    const { ids } = await readBody(req)
    if (!Array.isArray(ids) || ids.length !== worlds.length || !ids.every((i) => worlds.some((w) => w.id === i))) return json(400, { error: 'ids must list every world once' })
    worlds = ids.map((i) => worlds.find((w) => w.id === i)); pushWorlds(); return json(200, { ok: true })
  }
  if (url.pathname === '/api/worlds' && req.method === 'POST') {
    const b = await readBody(req)
    if (!b.name || !String(b.name).trim()) return json(400, { error: 'A world needs a name.' })
    if (worlds.some((w) => w.name.toLowerCase() === String(b.name).trim().toLowerCase())) return json(400, { error: 'A world with that name already exists.' })
    const world = { id: `w${wseq++}-${crypto.randomBytes(2).toString('hex')}`, name: String(b.name).trim(), color: b.color || '#6aaef0', repos: Array.isArray(b.repos) ? b.repos : [] }
    worlds = [...worlds, world]; pushWorlds(); return json(201, { world })
  }
  const wm = url.pathname.match(/^\/api\/worlds\/([^/]+)$/)
  if (wm && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const w = worlds.find((x) => x.id === decodeURIComponent(wm[1]))
    if (!w) return json(404, { error: 'No such world.' })
    if (req.method === 'DELETE') { worlds = worlds.filter((x) => x !== w); pushWorlds(); return json(200, { ok: true }) }
    const b = await readBody(req)
    if (b.name !== undefined) { if (!String(b.name).trim()) return json(400, { error: 'A world needs a name.' }); w.name = String(b.name).trim() }
    if (b.color) w.color = b.color
    if (Array.isArray(b.repos)) w.repos = b.repos
    if (typeof b.leadSpawn === 'boolean') w.leadSpawn = b.leadSpawn
    if (Number.isInteger(b.maxSpawned) && b.maxSpawned >= 0) w.maxSpawned = b.maxSpawned
    pushWorlds(); return json(200, { world: w })
  }
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(permission|answer|input|ack|catchup)$/)
  if (req.method === 'POST' && m) {
    const s = sessions.get(decodeURIComponent(m[1]))
    if (!s) return json(404, { error: 'no such session' })
    const body = await readBody(req)
    if (m[2] === 'catchup') {
      if (s.catchupRunning) return json(409, { error: 'Catch-up is already running.' })
      s.catchupRunning = true; upsert(s)
      setTimeout(() => { s.catchupRunning = false; s.catchupAt = now(); s.catchup = { asked: s.task, did: s.demo?.did ?? `Worked on ${s.id}. (mock summary)`, needs: s.demo ? s.demo.needs : (s.card ? 'Your decision on the open request' : '') }; upsert(s) }, 1500)
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
    } else if (s.card?.kind === 'asking') { resume(s, 'Continuing with your reply') }
    else { s.log.push({ t: now(), text: `Input: ${body.text}` }); upsert(s) }
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
    socket.write(frame(JSON.stringify({ type: 'snapshot', worlds, sessions: [...sessions.values()], recoverable, unmanaged, runs: [...runs.values()] })))
    return
  }
  // /pty: demo terminal with each agent's native-looking prompt; MOCK_ECHO=1 for a plain echo.
  const id = url.searchParams.get('session') || '?'
  socket.on('error', () => {})
  if (process.env.MOCK_ECHO) { // plain echo terminal
    socket.write(frame(`\x1b[32mmock terminal for ${id}\x1b[0m\r\n$ `))
    onFrames(socket, (text) => {
      let m
      try { m = JSON.parse(text) } catch { return }
      if (m.t === 'in') socket.write(frame(String(m.d).replace(/\r/g, '\r\n$ ')))
    })
    return
  }
  const s = sessions.get(id)
  const codex = s?.agent === 'codex'
  const codexPermission = codex && s.card?.kind === 'permission' && s.card.live === false
  const SKILLS = [['checkpoint', 'Is this session still worth keeping?'], ['clear', 'Clear the conversation'], ['commit', 'Commit with a good message'], ['compact', 'Summarise the context'], ['handover-save', 'Save the plan before /clear'], ['mr-create', 'Open a merge request'], ['ship-check', 'Final check before merging']]
  const menu = (buf) => (buf.startsWith('/') && !buf.includes(' ') ? SKILLS.filter(([n]) => n.startsWith(buf.slice(1))) : [])
  const render = (buf) => {
    const items = menu(buf)
    const list = items.map(([n, d], i) => `${i === 0 ? '\x1b[7m' : ''} /${n.padEnd(14)}\x1b[0m\x1b[2m ${d}\x1b[0m`).join('\r\n')
    return `\r\x1b[J\x1b[1m>\x1b[0m ${buf}` + (items.length ? `\x1b7\r\n${list}\x1b8` : '')
  }
  let buf = ''
  const intro = codexPermission
    ? `\x1b[1mCodex CLI\x1b[0m \x1b[2m(demo)\x1b[0m\r\n\r\nWould you like to run the following command?\r\n\r\n\x1b[1m$ ${s.card.command}\x1b[0m\r\n\r\n  1. Yes, proceed\r\n  2. No, and tell Codex what to do differently\r\n\r\n`
    : codex
    ? `\x1b[1mCodex CLI\x1b[0m \x1b[2m(demo)\x1b[0m\r\n\r\n\x1b[1m>\x1b[0m ${s?.task ?? ''}\r\n\r\n• ${s?.now ?? 'Working'}\r\n\r\n`
    : `\x1b[1m✻ Claude Code\x1b[0m \x1b[2m(demo)\x1b[0m\r\n\r\n\x1b[1m>\x1b[0m ${s?.task ?? ''}\r\n\r\n⏺ Reading the project files\r\n  \x1b[2m⎿ Read 4 files\x1b[0m\r\n⏺ ${s?.now ?? 'Working'}\r\n\r\n`
  socket.write(frame(intro + render('')))
  onFrames(socket, (text) => {
    let m
    try { m = JSON.parse(text) } catch { return }
    if (m.t !== 'in') return
    for (const ch of String(m.d)) {
      if (ch === '\r') {
        const line = buf; buf = ''
        const question = s?.card?.kind === 'question' && s.card.live === false ? s.card.questions[0] : null
        const choice = question?.options.find((o, i) => line.trim() === String(i + 1) || line.trim().toLowerCase() === o.label.toLowerCase())
        const permissionChoice = codexPermission && ['1', '2'].includes(line.trim()) ? line.trim() : null
        const reply = permissionChoice
          ? permissionChoice === '1' ? 'Approved. Continuing.' : 'Denied. Waiting for new instructions.'
          : codexPermission ? 'Choose 1 or 2.'
          : question
          ? choice ? `⏺ Answered: ${choice.label}` : `Choose 1–${question.options.length}.`
          : line.startsWith('/') ? `\x1b[2mRunning ${line.split(' ')[0]} ...\x1b[0m` : '⏺ On it. I will check the failing test first.'
        if (choice || permissionChoice) resume(s, permissionChoice === '2' ? 'Waiting for new instructions' : 'Continuing with your answer')
        socket.write(frame(`\r\x1b[J\x1b[1m>\x1b[0m ${line}\r\n\r\n${reply}\r\n\r\n` + render('')))
      } else if (ch === '\x7f') { buf = buf.slice(0, -1); socket.write(frame(render(buf))) }
      else if (ch === '\t') { const it = menu(buf)[0]; if (it) { buf = `/${it[0]} `; socket.write(frame(render(buf))) } }
      else if (ch >= ' ') { buf += ch; socket.write(frame(render(buf))) }
    }
  })
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock server on http://127.0.0.1:${PORT}`))
