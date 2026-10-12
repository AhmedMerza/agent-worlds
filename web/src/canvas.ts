import type { RoomGroup, Session, SessionState } from './types'
import { tiredLevel, waitMinutes, ctxColor, roomConflicts } from './logic'

export const W = 480
export const K = 2
const WALL_H = 48
const ROW_H = 150
const FIRST_DESK = 104

export interface Hit { id: string; x: number; y: number; w: number; h: number }
export interface DrawOpts { group: RoomGroup; selectedId: string | null; t: number; now: number; reduced: boolean }

export const STATE_COLOR: Record<SessionState, string> = {
  working: '#6aaef0', waiting: '#f2b84b', done: '#72cf98', error: '#ee705f', idle: '#8a92a0',
}

/** Station grid for n sessions: 1-4 in one row, 5-8 in two balanced rows. */
export function layout(n: number): { cols: number; rows: number; H: number } {
  const cols = n <= 4 ? Math.max(1, n) : Math.ceil(n / 2)
  const rows = Math.max(1, Math.ceil(n / cols))
  return { cols, rows, H: 200 + (rows - 1) * ROW_H }
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

function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, s: Session, shirt: string, on: boolean) {
  if (on) { ctx.fillStyle = rgba(shirt, 0.28); ctx.fillRect(x - 12, y - 14, 24, 15) }
  ctx.fillStyle = '#3b4352'; ctx.fillRect(x - 8, y - 10, 16, 10)
  ctx.fillStyle = '#5a6375'; ctx.fillRect(x - 8, y - 10, 16, 1)
  ctx.fillStyle = on ? shirt : '#4a5262'; ctx.fillRect(x - 1, y - 6, 2, 2)
  ctx.fillStyle = '#6b4a34'; ctx.fillRect(x - 32, y, 64, 4)
  ctx.fillStyle = '#4e3526'; ctx.fillRect(x - 32, y + 4, 64, 12)
  ctx.fillStyle = '#3a271c'; ctx.fillRect(x - 30, y + 16, 4, 6); ctx.fillRect(x + 26, y + 16, 4, 6)
  ctx.fillStyle = '#2b1e16'; ctx.fillRect(x - 30, y + 6, 60, 9)
  ctx.fillStyle = '#ece6d9'; ctx.font = '600 8px "Pixelify Sans", monospace'
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  const name = s.repoName.length > 12 ? s.repoName.slice(0, 11) + '…' : s.repoName
  ctx.fillText(name, x, y + 11)
  // Context bar: only when the server reports context (v2).
  if (s.context) {
    const pct = Math.max(0, Math.min(100, s.context.pct))
    ctx.fillStyle = '#0e1116'; ctx.fillRect(x - 20, y + 17, 40, 3)
    ctx.fillStyle = ctxColor(pct); ctx.fillRect(x - 20, y + 17, Math.round(40 * pct / 100), 3)
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

function drawStation(ctx: CanvasRenderingContext2D, s: Session, x: number, y: number, o: DrawOpts, hits: Hit[]) {
  const l = look(s.id), tt = o.reduced ? 0 : o.t
  let hb: { x: number; y: number; w: number; h: number }
  if (s.state === 'working') {
    const bob = Math.floor(tt / 260 + l.seed) % 2
    hb = { x: x - 12, y: y - 30, w: 24, h: 30 }
    drawSprite(ctx, x - 12, y - 30 + bob, 3, pal(l), false)
    drawDesk(ctx, x, y, s, l.shirt, true)
    for (let k = 0; k < 3; k++) {
      const ph = ((tt / 1100) + k / 3 + l.seed) % 1
      ctx.fillStyle = rgba(l.shirt, 1 - ph)
      ctx.fillRect(x - 6 + ((k * 5 + Math.floor(l.seed * 7)) % 12), y - 14 - ph * 22, 2, 2)
    }
  } else if (s.state === 'idle') {
    drawDesk(ctx, x, y, s, l.shirt, false)
    const wx = x + Math.round(Math.sin(tt / 2400 + l.seed) * 36)
    const step = !o.reduced && Math.abs(Math.cos(tt / 2400 + l.seed)) > 0.2 && (tt / 180 | 0) % 2 === 1
    const wy = y + 52
    hb = { x: wx - 12, y: wy, w: 24, h: 36 }
    drawSprite(ctx, wx - 12, wy, 3, pal(l), step)
    ctx.fillStyle = '#8a92a0'; ctx.font = '600 9px "Pixelify Sans", monospace'; ctx.textAlign = 'left'
    ctx.fillText('z', wx + 10, wy - 6 - ((tt / 400 | 0) % 3)); ctx.fillText('z', wx + 15, wy - 12 - ((tt / 400 | 0) % 3))
  } else {
    drawDesk(ctx, x, y, s, l.shirt, false)
    const m = waitMinutes(s, o.now), tired = tiredLevel(m)
    const cx = x - 46
    const lift = s.state === 'waiting' && !tired ? (Math.floor(tt / 450) % 2) * 2 : 0
    const sy = y - 6 + (tired === 2 ? 6 : tired * 2)
    hb = { x: cx - 12, y: sy, w: 24, h: 36 }
    drawSprite(ctx, cx - 12, sy - lift, 3, pal(l), false, tired === 2)
    const glyph = s.state === 'waiting' ? (s.card?.kind === 'question' ? '?' : '!') : s.state === 'done' ? '✓' : '×'
    bubble(ctx, cx, sy, glyph, STATE_COLOR[s.state], lift)
    ctx.fillStyle = m >= 20 ? STATE_COLOR.error : m >= 10 ? STATE_COLOR.waiting : '#ece6d9'
    ctx.font = '600 8px "Pixelify Sans", monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.fillText(`${m}m`, cx + 10, sy - 12 - lift)
    if (s.state === 'error') {
      for (let k = 0; k < 3; k++) {
        const ph = ((tt / 1400) + k / 3) % 1
        ctx.fillStyle = `rgba(150,150,150,${0.6 - ph * 0.6})`; ctx.fillRect(x - 2 + k * 2 + ph * 4, y - 14 - ph * 18, 3, 3)
      }
    }
  }
  const hs = s.helpers
  hs.slice(0, 3).forEach((h, i) => {
    const hx = x - 26 + i * 18, hy = y + 26
    const b = h.state === 'working' && !o.reduced ? Math.floor(tt / 220 + i) % 2 : 0
    ctx.fillStyle = rgba(l.shirt, 0.7)
    for (let d = y + 21; d < hy + b; d += 2) ctx.fillRect(hx + 8, d, 1, 1)
    drawSprite(ctx, hx, hy + b, 2, pal(l, true), false)
    if (h.state === 'done') { ctx.fillStyle = STATE_COLOR.done; ctx.fillRect(hx + 13, hy - 2, 4, 4) }
  })
  if (hs.length > 3) {
    ctx.fillStyle = rgba(l.shirt, 0.9); ctx.fillRect(x + 28, y + 32, 16, 11)
    ctx.fillStyle = '#14110b'; ctx.font = '600 8px "Pixelify Sans", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('+' + (hs.length - 3), x + 36, y + 38)
  }
  if (o.selectedId === s.id) brackets(ctx, hb.x, hb.y, hb.w, hb.h)
  hits.push({ id: s.id, ...hb })
}

/** Draws one world's room; returns the click hit-boxes in room coordinates (W x H). */
export function drawRoom(ctx: CanvasRenderingContext2D, o: DrawOpts): Hit[] {
  const { cols, H } = layout(o.group.sessions.length)
  const tint = o.group.world.color
  const wall = mix(tint, '#12161d', 0.78), trim = mix(tint, '#12161d', 0.65)
  ctx.setTransform(K, 0, 0, K, 0, 0); ctx.imageSmoothingEnabled = false
  for (let y = WALL_H; y < H; y += 16) for (let x = 0; x < W; x += 16) {
    ctx.fillStyle = ((x + y) / 16) % 2 ? '#262c33' : '#22272e'; ctx.fillRect(x, y, 16, 16)
  }
  ctx.fillStyle = wall; ctx.fillRect(0, 0, W, WALL_H)
  ctx.fillStyle = trim; ctx.fillRect(0, 44, W, 4)
  for (let i = 0; i < 3; i++) {
    const wx = 52 + i * 150
    ctx.fillStyle = trim; ctx.fillRect(wx - 2, 8, 48, 30)
    ctx.fillStyle = '#121a2a'; ctx.fillRect(wx, 10, 44, 26)
    ctx.fillStyle = '#ece6d9'
    ctx.fillRect(wx + 6 + i * 7, 15, 1, 1); ctx.fillRect(wx + 30 - i * 3, 22, 1, 1); ctx.fillRect(wx + 18, 30 - i * 2, 1, 1)
    ctx.fillStyle = trim; ctx.fillRect(wx + 21, 10, 2, 26)
  }
  ctx.fillStyle = '#e8d7a0'; ctx.fillRect(W - 30, 14, 10, 10)
  ctx.fillStyle = '#3d6b45'; ctx.fillRect(6, 30, 12, 14); ctx.fillStyle = '#5c3b2a'; ctx.fillRect(8, 42, 8, 8)
  const hits: Hit[] = []
  const pos = new Map<string, { x: number; y: number }>()
  o.group.sessions.forEach((s, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const x = Math.round((col + 0.5) * W / cols), y = FIRST_DESK + row * ROW_H
    pos.set(s.id, { x, y })
    drawStation(ctx, s, x, y, o, hits)
  })
  const { links, badges } = roomConflicts(o.group.sessions)
  const warn = STATE_COLOR.waiting
  for (const l of links) {
    const a = pos.get(l.a)!, b = pos.get(l.b)!
    const x1 = a.x, y1 = a.y - 34, x2 = b.x, y2 = b.y - 34
    const n = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 5))
    const off = o.reduced ? 0 : (o.t / 120) % 2
    for (let i = 0; i < n; i++) {
      if ((i + Math.floor(off)) % 2) continue
      const t = i / n
      ctx.fillStyle = warn; ctx.fillRect(Math.round(x1 + (x2 - x1) * t), Math.round(y1 + (y2 - y1) * t - Math.sin(t * Math.PI) * 14), 2, 2)
    }
    const mx = Math.round((x1 + x2) / 2), my = Math.round((y1 + y2) / 2 - 16)
    ctx.fillStyle = warn; ctx.fillRect(mx - 5, my - 5, 11, 11)
    ctx.fillStyle = '#14110b'; ctx.font = '600 9px "Pixelify Sans", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', mx, my + 1)
  }
  for (const id of badges) {
    const p = pos.get(id)!
    ctx.fillStyle = warn; ctx.fillRect(p.x + 18, p.y - 40, 11, 11)
    ctx.fillStyle = '#14110b'; ctx.font = '600 9px "Pixelify Sans", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', p.x + 23, p.y - 39)
  }
  return hits
}

/** Finds the session under a point given in room coordinates. */
export const hitTest = (hits: Hit[], px: number, py: number): Hit | undefined =>
  hits.find((h) => px >= h.x - 5 && px <= h.x + h.w + 5 && py >= h.y - 18 && py <= h.y + h.h + 24)
