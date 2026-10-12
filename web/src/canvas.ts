import type { RoomGroup, Session, SessionState } from './types'
import { tiredLevel, waitMinutes, ctxColor, roomConflicts } from './logic'
import { ROOM_W, ROOM_H, FLOOR_TOP, WALK_MS, ZONE_X, assignZones, slotPos, slotWidth, capacity, retarget, doorWalker, walkPos, pauseWalker, type Zone, type Walker } from './zones'

export const W = ROOM_W
const WALL_H = 48

export interface Hit { id: string; x: number; y: number; w: number; h: number }
export interface DrawOpts { group: RoomGroup; selectedId: string | null; t: number; now: number; reduced: boolean; walkers: Map<string, Walker>; k: number; h: number
  /** Session under the pointer: its walk is held still. */
  hoverId?: string | null
  /** ms since the previous frame (used to hold a walk). */
  dt?: number
  /** Ghosts left out of the scene by the cap; drawn as "+N" in the lounge. */
  moreGhosts?: number }
export const H = ROOM_H

export const STATE_COLOR: Record<SessionState, string> = {
  starting: '#b5bcc8', working: '#6aaef0', waiting: '#f2b84b', done: '#72cf98', error: '#ee705f', idle: '#8a92a0',
}

// ---- colour helpers ----
const hexToRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}
const rgba = (h: string, a: number): string => { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})` }
const lighten = (h: string, a: number): string => {
  const [r, g, b] = hexToRgb(h)
  const m = (v: number) => Math.round(v + (255 - v) * a)
  return `rgb(${m(r)},${m(g)},${m(b)})`
}
const mix = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexToRgb(a); const [r2, g2, b2] = hexToRgb(b)
  const m = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `rgb(${m(r1, r2)},${m(g1, g2)},${m(b1, b2)})`
}

// ---- stable per-session look (the server gives none) ----
const SHIRTS = ['#47b4a7', '#f0d36b', '#e07aa8', '#f08a5d', '#7fc4e8', '#9c88df', '#8fbf7a', '#c9b28a', '#e8c547']
const HAIRS = ['#2b1d14', '#15110e', '#3b2a1e', '#6b3b1f', '#1e1a17', '#2a2a33', '#4a3020', '#121212', '#5a2e1a']
const SKINS = ['#d9a27c', '#c68b62', '#e0b08c', '#e6be9a', '#b97b55', '#d6a07a', '#e3b591', '#a86f4c', '#f0c8a4']
export function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
export function look(id: string) {
  const h = hash(id)
  return { shirt: SHIRTS[h % 9], hair: HAIRS[(h >> 4) % 9], skin: SKINS[(h >> 8) % 9], seed: (h % 100) / 100 * 9 }
}

// ---- sprites ----
const SPRITE = ['..hhhh..', '.hhhhhh.', '.hsssss.', '.sesses.', '.ssssss.', '..ssss..', '.cccccc.', 'sccccccs', 'sccccccs', '.cccccc.', '.pp..pp.', '.kk..kk.']
const LEGS_B = ['..pp.pp.', '..kk.kk.']
type Pal = Record<string, string>
const pal = (l: ReturnType<typeof look>, helper = false): Pal => ({
  h: helper ? lighten(l.shirt, 0.2) : l.hair, s: l.skin, e: '#1a1410',
  c: helper ? lighten(l.shirt, 0.45) : l.shirt, p: '#2f3a4f', k: '#16181e',
})
function drawSprite(ctx: CanvasRenderingContext2D, x: number, y: number, px: number, p: Pal, step: boolean, sit = false) {
  for (let r = 0; r < SPRITE.length; r++) {
    if (sit && r >= 10) continue
    const row = step && r >= 10 ? LEGS_B[r - 10] : SPRITE[r]
    for (let c = 0; c < 8; c++) {
      const ch = row[c]
      if (ch === '.') continue
      ctx.fillStyle = p[ch]; ctx.fillRect(x + c * px, y + r * px, px, px)
    }
  }
  if (sit) {
    ctx.fillStyle = p.p; ctx.fillRect(x + px, y + 10 * px, 8 * px, px)
    ctx.fillStyle = p.k; ctx.fillRect(x + 9 * px, y + 10 * px, px, px)
  }
}

function bubble(ctx: CanvasRenderingContext2D, cx: number, top: number, glyph: string, color: string, lift: number) {
  const bw = 15, bh = 13, bx = Math.round(cx - bw / 2), by = top - bh - 5 - lift
  ctx.fillStyle = '#12161d'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2)
  ctx.fillStyle = color; ctx.fillRect(bx, by, bw, bh); ctx.fillRect(cx - 1, by + bh, 3, 3)
  ctx.fillStyle = '#14110b'; ctx.font = '600 11px "Pixelify Sans", monospace'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(glyph, cx, by + bh / 2 + 1)
}

function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = '#ece6d9'
  const L = 5, x2 = x + w, y2 = y + h
  const corners: [number, number, number, number][] = [[x - 3, y - 3, 1, 1], [x2 + 2, y - 3, -1, 1], [x - 3, y2 + 2, 1, -1], [x2 + 2, y2 + 2, -1, -1]]
  for (const [cx, cy, dx, dy] of corners) {
    ctx.fillRect(dx > 0 ? cx : cx - L + 1, cy, L, 1)
    ctx.fillRect(cx, dy > 0 ? cy : cy - L + 1, 1, L)
  }
}

function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, s: Session, shirt: string) {
  const hw = Math.round(w / 2)
  ctx.fillStyle = rgba(shirt, 0.28); ctx.fillRect(x - 12, y - 14, 24, 15)
  ctx.fillStyle = '#3b4352'; ctx.fillRect(x - 8, y - 10, 16, 10)
  ctx.fillStyle = '#5a6375'; ctx.fillRect(x - 8, y - 10, 16, 1)
  ctx.fillStyle = shirt; ctx.fillRect(x - 1, y - 6, 2, 2)
  ctx.fillStyle = '#6b4a34'; ctx.fillRect(x - hw, y, hw * 2, 4)
  ctx.fillStyle = '#4e3526'; ctx.fillRect(x - hw, y + 4, hw * 2, 12)
  ctx.fillStyle = '#3a271c'; ctx.fillRect(x - hw + 2, y + 16, 4, 6); ctx.fillRect(x + hw - 6, y + 16, 4, 6)
  ctx.fillStyle = '#2b1e16'; ctx.fillRect(x - hw + 2, y + 6, hw * 2 - 4, 9)
  label(ctx, s.repoName, x, y + 11, hw * 2 - 6)
  if (s.context) {
    const pct = Math.max(0, Math.min(100, s.context.pct))
    ctx.fillStyle = '#0e1116'; ctx.fillRect(x - 20, y + 17, 40, 3)
    ctx.fillStyle = ctxColor(pct); ctx.fillRect(x - 20, y + 17, Math.round(40 * pct / 100), 3)
  }
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number) {
  ctx.fillStyle = '#ece6d9'; ctx.font = '600 8px "Pixelify Sans", monospace'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  let t = text
  while (t.length > 3 && ctx.measureText(t).width > maxW) t = t.slice(0, -2) + '…'
  ctx.fillText(t, x, y)
}

function drawStation(ctx: CanvasRenderingContext2D, s: Session, zone: Zone, x: number, top: number, dest: { x: number; top: number }, moving: boolean, n: number, o: DrawOpts, hits: Hit[]) {
  const l = look(s.id), tt = o.reduced ? 0 : o.t
  const step = moving && Math.floor(o.t / 150) % 2 === 1
  let hb: { x: number; y: number; w: number; h: number }
  if (zone === 'desks') {
    const deskY = dest.top + 30, dx = dest.x // the desk waits at the destination slot while the sprite walks over
    const bob = moving ? 0 : Math.floor(tt / 260 + l.seed) % 2
    hb = { x: x - 12, y: top, w: 24, h: 30 }
    if (moving) drawSprite(ctx, x - 12, top, 3, pal(l), step)
    else drawSprite(ctx, x - 12, top + bob, 3, pal(l), false)
    drawDesk(ctx, dx, deskY, Math.min(64, slotWidth('desks', n) - 6), s, l.shirt)
    for (let k = 0; k < 3 && !moving; k++) {
      const ph = ((tt / 1100) + k / 3 + l.seed) % 1
      ctx.fillStyle = rgba(l.shirt, 1 - ph)
      ctx.fillRect(dx - 6 + ((k * 5 + Math.floor(l.seed * 7)) % 12), deskY - 14 - ph * 22, 2, 2)
    }
    s.helpers.slice(0, 3).forEach((h, i) => {
      const hx = dx - 26 + i * 18, hy = deskY + 26
      const b = h.state === 'working' && !o.reduced ? Math.floor(tt / 220 + i) % 2 : 0
      ctx.fillStyle = rgba(l.shirt, 0.7)
      for (let d = deskY + 21; d < hy + b; d += 2) ctx.fillRect(hx + 8, d, 1, 1)
      drawSprite(ctx, hx, hy + b, 2, pal(l, true), false)
      if (h.state === 'done') { ctx.fillStyle = STATE_COLOR.done; ctx.fillRect(hx + 13, hy - 2, 4, 4) }
    })
    if (s.helpers.length > 3) {
      ctx.fillStyle = rgba(l.shirt, 0.9); ctx.fillRect(dx + 28, deskY + 32, 16, 11)
      ctx.fillStyle = '#14110b'; ctx.font = '600 8px "Pixelify Sans", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('+' + (s.helpers.length - 3), dx + 36, deskY + 38)
    }
  } else if (zone === 'lounge') {
    hb = { x: x - 12, y: top, w: 24, h: 36 }
    const starting = s.state === 'starting'
    ctx.globalAlpha = s.ghost ? 0.3 : starting ? 1 : 0.6
    drawSprite(ctx, x - 12, top, 3, pal(l), step)
    ctx.globalAlpha = 1
    if (s.ghost) { // dashed outline: there, but not ours
      ctx.fillStyle = 'rgba(236,230,217,0.6)'
      for (let d = 0; d < 36; d += 4) { ctx.fillRect(x - 14, top - 2 + d, 1, 2); ctx.fillRect(x + 13, top - 2 + d, 1, 2) }
      for (let d = 0; d < 28; d += 4) { ctx.fillRect(x - 14 + d, top - 2, 2, 1); ctx.fillRect(x - 14 + d, top + 34, 2, 1) }
    }
    if (starting) bubble(ctx, x, top, '…', STATE_COLOR.starting, 0)
    if (!moving && !s.ghost && !starting) {
      ctx.fillStyle = '#8a92a0'; ctx.font = '600 9px "Pixelify Sans", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      ctx.fillText('z', x + 10, top - 2 - ((tt / 400 | 0) % 3)); ctx.fillText('z', x + 15, top - 8 - ((tt / 400 | 0) % 3))
    }
    label(ctx, s.repoName, x, top + 42, slotWidth('lounge', n) - 2)
  } else {
    const m = waitMinutes(s, o.now), tired = tiredLevel(m)
    const lift = s.state === 'waiting' && !tired && !moving ? (Math.floor(tt / 450) % 2) * 2 : 0
    const sy = top + (tired === 2 ? 6 : tired * 2)
    hb = { x: x - 12, y: sy, w: 24, h: 36 }
    drawSprite(ctx, x - 12, sy - lift, 3, pal(l), step, tired === 2 && !moving)
    const glyph = s.state === 'waiting' ? (s.card?.kind === 'question' || s.card?.kind === 'asking' ? '?' : '!') : s.state === 'done' ? '✓' : '×'
    bubble(ctx, x, sy, glyph, STATE_COLOR[s.state], lift)
    ctx.fillStyle = m >= 20 ? STATE_COLOR.error : m >= 10 ? STATE_COLOR.waiting : '#ece6d9'
    ctx.font = '600 8px "Pixelify Sans", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(`${m}m`, x + 10, sy - 12 - lift)
    if (s.state === 'error' && !moving) {
      for (let k = 0; k < 3; k++) {
        const ph = ((tt / 1400) + k / 3) % 1
        ctx.fillStyle = `rgba(150,150,150,${0.6 - ph * 0.6})`; ctx.fillRect(x - 2 + k * 2 + ph * 4, top - 4 - ph * 18, 3, 3)
      }
    }
    s.helpers.slice(0, 3).forEach((h, i) => {
      const hx = x + 13 + i * 6, hy = sy + 14 + (h.state === 'working' && !o.reduced ? Math.floor(tt / 220 + i) % 2 : 0)
      drawSprite(ctx, hx, hy, 1, pal(l, true), false)
      if (h.state === 'done') { ctx.fillStyle = STATE_COLOR.done; ctx.fillRect(hx + 6, hy - 2, 2, 2) }
    })
    if (s.helpers.length > 3) { ctx.fillStyle = '#ece6d9'; ctx.font = '600 7px "Pixelify Sans", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('+' + (s.helpers.length - 3), x + 13, sy + 32) }
    label(ctx, s.repoName, x, top + 44, slotWidth('help', n) - 2)
  }
  if (o.selectedId === s.id) brackets(ctx, hb.x, hb.y, hb.w, hb.h)
  hits.push({ id: s.id, ...hb })
}

function drawScenery(ctx: CanvasRenderingContext2D, wall: string, trim: string, H: number) {
  for (let y = WALL_H; y < H; y += 16) for (let x = 0; x < W; x += 16) {
    ctx.fillStyle = ((x + y) / 16) % 2 ? '#262c33' : '#22272e'; ctx.fillRect(x, y, 16, 16)
  }
  // zone floors: lounge dimmed, help desk amber
  ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(ZONE_X.lounge[0], WALL_H, ZONE_X.lounge[1], H - WALL_H)
  ctx.fillStyle = 'rgba(242,184,75,0.10)'; ctx.fillRect(ZONE_X.help[0], WALL_H, ZONE_X.help[1] - ZONE_X.help[0], H - WALL_H)
  ctx.fillStyle = 'rgba(236,230,217,0.12)'
  for (const x of [ZONE_X.lounge[1], ZONE_X.help[0]]) for (let y = WALL_H; y < H; y += 6) ctx.fillRect(x, y, 1, 3)
  ctx.fillStyle = wall; ctx.fillRect(0, 0, W, WALL_H)
  ctx.fillStyle = trim; ctx.fillRect(0, 44, W, 4)
  for (let i = 0; i < 2; i++) {
    const wx = 150 + i * 100
    ctx.fillStyle = trim; ctx.fillRect(wx - 2, 6, 48, 28)
    ctx.fillStyle = '#121a2a'; ctx.fillRect(wx, 8, 44, 24)
    ctx.fillStyle = '#ece6d9'
    ctx.fillRect(wx + 6 + i * 7, 13, 1, 1); ctx.fillRect(wx + 30 - i * 3, 20, 1, 1); ctx.fillRect(wx + 18, 28 - i * 2, 1, 1)
    ctx.fillStyle = trim; ctx.fillRect(wx + 21, 8, 2, 24)
  }
  // lounge: plant + couch
  ctx.fillStyle = '#3d6b45'; ctx.fillRect(6, 30, 12, 14); ctx.fillStyle = '#5c3b2a'; ctx.fillRect(8, 42, 8, 8)
  ctx.fillStyle = '#4a3d5c'; ctx.fillRect(34, 24, 62, 12); ctx.fillStyle = '#5a4b70'; ctx.fillRect(34, 32, 62, 12)
  ctx.fillStyle = '#3a2f4a'; ctx.fillRect(32, 30, 4, 14); ctx.fillRect(94, 30, 4, 14)
  // help desk: bell sign
  ctx.fillStyle = '#f2b84b'; ctx.fillRect(414, 14, 12, 3); ctx.fillRect(412, 17, 16, 8); ctx.fillRect(410, 25, 20, 3); ctx.fillRect(418, 29, 4, 3)
  ctx.fillStyle = '#14110b'; ctx.fillRect(418, 20, 4, 2)
  // zone names, big enough to read from across the room
  ctx.font = '600 8px "Pixelify Sans", monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(236,230,217,0.55)'
  ctx.fillText('LOUNGE', 60, 40); ctx.fillText('DESKS', 240, 40)
  ctx.fillStyle = '#f2b84b'; ctx.fillText('HELP DESK', 420, 40)
}

/** Draws one world's room; returns click hit-boxes (in room coordinates) that follow the walking sprites. */
export function drawRoom(ctx: CanvasRenderingContext2D, o: DrawOpts): Hit[] {
  const tint = o.group.world.color
  const wall = mix(tint, '#12161d', 0.78), trim = mix(tint, '#12161d', 0.65)
  ctx.setTransform(o.k, 0, 0, o.k, 0, 0); ctx.imageSmoothingEnabled = false
  // At a fractional scale rects would blur at their edges and leave seams: snap every rect to whole device pixels.
  const k = o.k, rect = CanvasRenderingContext2D.prototype.fillRect
  const snap = (v: number) => Math.round(v * k) / k
  ctx.fillRect = (x: number, y: number, w: number, h: number) => { const x0 = snap(x), y0 = snap(y); rect.call(ctx, x0, y0, snap(x + w) - x0, snap(y + h) - y0) }
  try { return paintRoom(ctx, o, wall, trim) } finally { Reflect.deleteProperty(ctx, 'fillRect') }
}

function paintRoom(ctx: CanvasRenderingContext2D, o: DrawOpts, wall: string, trim: string): Hit[] {
  drawScenery(ctx, wall, trim, o.h)

  const zones = assignZones(o.group.sessions)
  const live = new Set(o.group.sessions.map((s) => s.id))
  for (const id of o.walkers.keys()) if (!live.has(id)) o.walkers.delete(id)

  const placed: { s: Session; zone: Zone; x: number; top: number; dest: { x: number; top: number }; moving: boolean; n: number }[] = []
  for (const zone of ['lounge', 'desks', 'help'] as Zone[]) {
    const list = zones[zone], cap = capacity(zone)
    list.forEach((s, i) => {
      if (i >= cap) return
      const target = slotPos(zone, i, list.length)
      const w = retarget(o.walkers.get(s.id) ?? (s.state === 'starting' && !o.reduced ? doorWalker(target, o.t) : undefined), target, o.t, o.reduced)
      if (o.hoverId === s.id && o.dt && o.t - w.start < WALK_MS) pauseWalker(w, o.dt)
      o.walkers.set(s.id, w)
      const p = walkPos(w.from, w.to, o.t - w.start, o.reduced)
      placed.push({ s, zone, x: Math.round(p.x), top: Math.round(p.top), dest: w.to, moving: p.moving, n: list.length })
    })
    const extra = zone === 'lounge' ? (o.moreGhosts ?? 0) : 0
    if (list.length + extra > cap || extra) {
      const [x0, x1] = ZONE_X[zone]
      ctx.fillStyle = '#ece6d9'; ctx.fillRect(x1 - 26, o.h - 16, 22, 11)
      ctx.fillStyle = '#14110b'; ctx.font = '600 8px "Pixelify Sans", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('+' + (Math.max(0, list.length - cap) + extra), x1 - 15, o.h - 10)
      void x0
    }
  }
  placed.sort((a, b) => a.top - b.top)
  const hits: Hit[] = []
  for (const p of placed) drawStation(ctx, p.s, p.zone, p.x, p.top, p.dest, p.moving, p.n, o, hits)

  const { links, badges } = roomConflicts(o.group.sessions)
  const warn = STATE_COLOR.waiting
  const at = new Map(placed.map((p) => [p.s.id, p]))
  const bang = (mx: number, my: number) => {
    ctx.fillStyle = warn; ctx.fillRect(mx - 5, my - 5, 11, 11)
    ctx.fillStyle = '#14110b'; ctx.font = '600 9px "Pixelify Sans", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', mx, my + 1)
  }
  for (const l of links) {
    const a = at.get(l.a), b = at.get(l.b)
    if (!a || !b) continue
    const x1 = a.x, y1 = a.top - 4, x2 = b.x, y2 = b.top - 4
    const n = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 5))
    const off = o.reduced ? 0 : (o.t / 120) % 2
    for (let i = 0; i < n; i++) {
      if ((i + Math.floor(off)) % 2) continue
      const t = i / n
      ctx.fillStyle = warn; ctx.fillRect(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t - Math.sin(t * Math.PI) * 14), 2, 2)
    }
    bang(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2 - 16))
  }
  for (const id of badges) { const p = at.get(id); if (p) bang(p.x + 18, p.top - 6) }
  return hits
}

/** Finds the session under a point given in room coordinates. */
export const hitTest = (hits: Hit[], px: number, py: number): Hit | undefined =>
  hits.find((h) => px >= h.x - 9 && px <= h.x + h.w + 9 && py >= h.y - 20 && py <= h.y + h.h + 26)
