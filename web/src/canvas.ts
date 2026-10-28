import type { RoomGroup, Session, SessionState } from './types'
import { illustratedRoom } from './illustratedRoom'
import { tiredLevel, waitMinutes, ctxColor, roomConflicts, nameOf } from './logic'
import { ROOM_W, ROOM_H, WALK_MS, assignZones, zoneBounds, countZones, slotPos, slotWidth, capacity, retarget, doorWalker, walkPos, pauseWalker, type Zone, type Walker } from './zones'

export const W = ROOM_W
const WALL_H = 48

export interface Hit { id: string; x: number; y: number; w: number; h: number; exact?: boolean }
export interface DrawOpts { group: RoomGroup; selectedId: string | null; /** Run step tags by session id, shown in place of the branch. */ steps?: Record<string, string>; roles?: Record<string, string | null>; t: number; now: number; reduced: boolean; walkers: Map<string, Walker>; /** Desk arrival order, kept between frames. */ arrivals?: Set<string>; k: number; h: number
  /** Session under the pointer: its walk is held still. */
  hoverId?: string | null
  worldDesign?: 'classic' | 'illustrated'
  /** ms since the previous frame (used to hold a walk). */
  dt?: number
  /** Ghosts left out of the scene by the cap; drawn as "+N" in the lounge. */
  moreGhosts?: number }
export const H = ROOM_H

export const STATE_COLOR: Record<SessionState, string> = {
  starting: '#b5bcc8', working: '#6aaef0', waiting: '#f2b84b', done: '#72cf98', error: '#ee705f', idle: '#8a92a0',
}
const INK = '#ece6d9', DARK_INK = '#14110b', BG = '#12161d'
const FONT = '"Atkinson Hyperlegible", system-ui, sans-serif'

// ---- colour helpers ----
const hexToRgb = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16)
  return [n >> 16, (n >> 8) & 255, n & 255]
}
const hex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')
const rgba = (h: string, a: number): string => { const [r, g, b] = hexToRgb(h); return `rgba(${r},${g},${b},${a})` }
const lighten = (h: string, a: number): string => { const [r, g, b] = hexToRgb(h); return hex(r + (255 - r) * a, g + (255 - g) * a, b + (255 - b) * a) }
const darken = (h: string, a: number): string => { const [r, g, b] = hexToRgb(h); return hex(r * (1 - a), g * (1 - a), b * (1 - a)) }
const mix = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = hexToRgb(a); const [r2, g2, b2] = hexToRgb(b)
  return hex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
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
  return { shirt: SHIRTS[h % 9], hair: HAIRS[(h >>> 4) % 9], skin: SKINS[(h >>> 8) % 9], seed: (h % 100) / 100 * 9, style: (h >>> 12) % 5 }
}
type Look = ReturnType<typeof look>

// ---- shapes ----
type Ctx = CanvasRenderingContext2D
function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]) {
  const [a, b, c, d] = (Array.isArray(r) ? r : [r, r, r, r]).map((v) => Math.max(0, Math.min(v, w / 2, h / 2)))
  ctx.beginPath(); ctx.moveTo(x + a, y); ctx.lineTo(x + w - b, y); ctx.quadraticCurveTo(x + w, y, x + w, y + b)
  ctx.lineTo(x + w, y + h - c); ctx.quadraticCurveTo(x + w, y + h, x + w - c, y + h); ctx.lineTo(x + d, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - d); ctx.lineTo(x, y + a); ctx.quadraticCurveTo(x, y, x + a, y); ctx.closePath()
}
function ell(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot = 0) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2) }
function glow(ctx: Ctx, x: number, y: number, r: number, color: string, a: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, rgba(color, a)); g.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2)
}
/** Text scale for name tags: 1 on a wide screen, up to 1.6 on a phone where 7 room units shrink to ~5 CSS px. */
let ts = 1
const font = (ctx: Ctx, px: number, align: CanvasTextAlign = 'center') => { ctx.font = `700 ${px}px ${FONT}`; ctx.textAlign = align; ctx.textBaseline = 'middle' }

// ---- people ----
type Mood = 'smile' | 'flat' | 'frown' | 'sleep' | 'o'
interface PersonOpts { s?: number; t: number; walk?: boolean; sit?: boolean; mood: Mood; typing?: boolean; slump?: boolean; bob?: number; shirt?: string; hair?: string; noShadow?: boolean }

function hair(ctx: Ctx, hx: number, hy: number, hr: number, col: string, style: number, s: number) {
  ctx.fillStyle = col
  if (style === 2) { rr(ctx, hx - hr - 1.2 * s, hy - 3 * s, 3.4 * s, 12 * s, 1.7 * s); ctx.fill(); rr(ctx, hx + hr - 2.2 * s, hy - 3 * s, 3.4 * s, 12 * s, 1.7 * s); ctx.fill() }
  if (style === 1) { ell(ctx, hx + s, hy - hr - 1.6 * s, 3.4 * s, 3 * s); ctx.fill() }
  ctx.save(); ell(ctx, hx, hy, hr + 1.1 * s, hr + 1.1 * s); ctx.clip()
  ell(ctx, hx + (style === 4 ? 2 * s : -s), hy - hr * 0.62, hr * 1.3, hr * 0.78, style === 4 ? -0.35 : style === 3 ? 0 : 0.18); ctx.fill()
  ctx.restore()
  if (style === 3) {
    ctx.beginPath()
    for (let i = -2; i <= 2; i++) { ctx.moveTo(hx + i * 3 * s - 2 * s, hy - hr + s); ctx.lineTo(hx + i * 3 * s, hy - hr - 3.4 * s); ctx.lineTo(hx + i * 3 * s + 2 * s, hy - hr + s) }
    ctx.fill()
  }
  ctx.strokeStyle = lighten(col, 0.3); ctx.lineWidth = 0.9 * s; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.arc(hx - s, hy - s, hr - 1.5 * s, Math.PI * 1.18, Math.PI * 1.42); ctx.stroke()
}

/** Draws a person standing on (x, feet); about 24 wide and 36 tall at s=1. Returns the y of the top of the head. */
function person(ctx: Ctx, x: number, feet: number, l: Look, o: PersonOpts): number {
  const s = o.s ?? 1, t = o.t
  const ph = o.walk ? Math.sin(t / 110 + l.seed) : 0
  const shirt = o.shirt ?? l.shirt, pants = '#33405a', shoe = '#1a1d24'
  if (!o.noShadow) { ctx.fillStyle = 'rgba(0,0,0,.34)'; ell(ctx, x, feet, 9.5 * s, 2.6 * s); ctx.fill() }
  const hipY = feet - (o.sit ? 3.5 * s : 8 * s)
  for (const side of [-1, 1]) {
    const lift = o.walk ? Math.max(0, side * ph) * 2.4 * s : 0
    ctx.fillStyle = pants; rr(ctx, x + side * 3.3 * s - 2.2 * s, hipY - s, 4.4 * s, feet - hipY + 0.4 * s - lift, 1.8 * s); ctx.fill()
    ctx.fillStyle = shoe; ell(ctx, x + side * 3.5 * s, feet - 1.1 * s - lift, 2.9 * s, 1.6 * s); ctx.fill()
  }
  const slump = o.slump ? 1.6 * s : 0
  const tw = 15 * s, th = 12 * s, tt = hipY - th + (o.bob ?? 0) + slump
  const swing = o.walk ? ph * 2.4 * s : 0
  ctx.fillStyle = darken(shirt, 0.14)
  if (o.typing) {
    const k = Math.sin(t / 85 + l.seed) > 0 ? 0.7 * s : 0
    rr(ctx, x - tw / 2 - 0.6 * s, tt + 3 * s - k, 4.2 * s, 8 * s, 2.1 * s); ctx.fill()
    rr(ctx, x + tw / 2 - 3.6 * s, tt + 3 * s - (0.7 * s - k), 4.2 * s, 8 * s, 2.1 * s); ctx.fill()
  } else {
    const droop = o.slump ? 1.2 * s : 0
    rr(ctx, x - tw / 2 - 2.5 * s, tt + 1.4 * s + swing + droop, 4.4 * s, 10 * s, 2.2 * s); ctx.fill()
    rr(ctx, x + tw / 2 - 1.9 * s, tt + 1.4 * s - swing + droop, 4.4 * s, 10 * s, 2.2 * s); ctx.fill()
    ctx.fillStyle = l.skin
    ell(ctx, x - tw / 2 - 0.3 * s, tt + 11.6 * s + swing + droop, 2 * s, 2 * s); ctx.fill()
    ell(ctx, x + tw / 2 + 0.3 * s, tt + 11.6 * s - swing + droop, 2 * s, 2 * s); ctx.fill()
  }
  const g = ctx.createLinearGradient(x - tw / 2, 0, x + tw / 2, 0)
  g.addColorStop(0, lighten(shirt, 0.1)); g.addColorStop(0.55, shirt); g.addColorStop(1, darken(shirt, 0.24))
  ctx.fillStyle = g; rr(ctx, x - tw / 2, tt, tw, th + s, [6 * s, 6 * s, 2 * s, 2 * s]); ctx.fill()
  ctx.fillStyle = l.skin; ctx.beginPath(); ctx.moveTo(x - 2.6 * s, tt); ctx.lineTo(x + 2.6 * s, tt); ctx.lineTo(x, tt + 3 * s); ctx.closePath(); ctx.fill()
  const hr = 8.6 * s, hx = x + (o.slump ? 0.6 * s : 0), hy = tt - hr + 2.4 * s + slump * 0.6
  ell(ctx, hx - hr + 0.3 * s, hy + s, 1.9 * s, 2.2 * s); ctx.fill()
  ell(ctx, hx + hr - 0.3 * s, hy + s, 1.9 * s, 2.2 * s); ctx.fill()
  ell(ctx, hx, hy, hr, hr); ctx.fill()
  ctx.fillStyle = 'rgba(60,30,20,.10)'; ctx.beginPath(); ctx.arc(hx, hy, hr, -Math.PI / 2, Math.PI / 2); ctx.fill()
  hair(ctx, hx, hy, hr, o.hair ?? l.hair, l.style, s)
  if (s >= 0.45) face(ctx, hx, hy, s, l, o, t)
  return hy - hr - s
}

function face(ctx: Ctx, hx: number, hy: number, s: number, l: Look, o: PersonOpts, t: number) {
  const blink = ((t + l.seed * 997) % 4200) < 140
  const gx = o.mood === 'sleep' ? 0 : [0, 0, -1, 0, 1, 0][Math.floor((t + l.seed * 1500) / 1700) % 6] * 0.8 * s
  const ey = hy + 1.4 * s + (o.slump ? 0.8 * s : 0)
  ctx.lineCap = 'round'
  for (const side of [-1, 1]) {
    const ex = hx + side * 3.3 * s
    if (blink || o.mood === 'sleep') {
      ctx.strokeStyle = '#1c1612'; ctx.lineWidth = 0.8 * s; ctx.beginPath(); ctx.arc(ex, ey - 0.4 * s, 1.3 * s, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke()
    } else {
      ctx.fillStyle = '#1c1612'; ell(ctx, ex + gx, ey, 1.25 * s, o.slump ? 1.1 * s : 1.75 * s); ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,.85)'; ell(ctx, ex + gx + 0.45 * s, ey - 0.6 * s, 0.45 * s, 0.45 * s); ctx.fill()
    }
  }
  ctx.fillStyle = 'rgba(230,110,110,.24)'
  ell(ctx, hx - 5.5 * s, ey + 2.6 * s, 1.6 * s, s); ctx.fill(); ell(ctx, hx + 5.5 * s, ey + 2.6 * s, 1.6 * s, s); ctx.fill()
  const my = ey + 3.4 * s
  ctx.strokeStyle = '#5a2e22'; ctx.fillStyle = '#5a2e22'; ctx.lineWidth = 0.8 * s; ctx.beginPath()
  if (o.mood === 'o') { ell(ctx, hx, my, 0.9 * s, 1.1 * s); ctx.fill(); return }
  if (o.mood === 'smile') ctx.arc(hx, my - 1.2 * s, 1.7 * s, 0.2 * Math.PI, 0.8 * Math.PI)
  else if (o.mood === 'frown') ctx.arc(hx, my + 1.6 * s, 1.6 * s, 1.2 * Math.PI, 1.8 * Math.PI)
  else { ctx.moveTo(hx - 1.3 * s, my); ctx.lineTo(hx + 1.3 * s, my) }
  ctx.stroke()
}

// ---- overlays (drawn after the light, so they stay crisp) ----
function bubble(ctx: Ctx, cx: number, tip: number, glyph: string, color: string) {
  const w = 17, h = 14, bx = cx - w / 2, by = tip - h - 4
  ctx.fillStyle = 'rgba(0,0,0,.35)'; rr(ctx, bx + 1, by + 1.6, w, h, 5); ctx.fill()
  ctx.fillStyle = color; rr(ctx, bx, by, w, h, 5); ctx.fill()
  ctx.beginPath(); ctx.moveTo(cx - 3, by + h - 0.5); ctx.lineTo(cx, by + h + 4); ctx.lineTo(cx + 3, by + h - 0.5); ctx.closePath(); ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.4)'; rr(ctx, bx + 3, by + 2, w - 9, 2, 1); ctx.fill()
  ctx.fillStyle = DARK_INK; font(ctx, 10.5); ctx.fillText(glyph, cx, by + h / 2 + 0.5)
}
/** A bubble with a clock face whose hand ticks round: waiting on background work. */
function clockBubble(ctx: Ctx, cx: number, tip: number, t: number) {
  bubble(ctx, cx, tip, '', STATE_COLOR.working)
  const y = tip - 11
  ctx.strokeStyle = DARK_INK; ctx.lineWidth = 1.1; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.arc(cx, y, 4.2, 0, Math.PI * 2); ctx.stroke()
  const a = (Math.floor(t / 1000) % 12) / 12 * Math.PI * 2 - Math.PI / 2
  ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + Math.cos(a) * 3, y + Math.sin(a) * 3); ctx.stroke()
}
function fit(ctx: Ctx, text: string, maxW: number): string {
  let t = text
  while (t.length > 3 && ctx.measureText(t).width > maxW) t = t.slice(0, -2) + '…'
  return t
}
function pill(ctx: Ctx, text: string, x: number, y: number, maxW: number, fg = INK, px = 7) {
  font(ctx, px)
  const t = fit(ctx, text, maxW - 8)
  const w = ctx.measureText(t).width + 8, h = px + 4
  ctx.fillStyle = 'rgba(10,13,18,.8)'; rr(ctx, x - w / 2, y - h / 2, w, h, h / 2); ctx.fill()
  ctx.fillStyle = fg; ctx.fillText(t, x, y + 0.3)
}
/** Project and branch (or its run step) on two lines; `full` (hovered or selected) never truncates and draws on top. */
function nameTag(ctx: Ctx, s: Session, step: string | undefined, role: string | null | undefined, x: number, y: number, maxW: number, full: boolean) {
  ctx.save(); ctx.translate(x, y); ctx.scale(ts, ts) // never smaller than ~10 CSS px, whatever the screen
  const lim = full ? 1e9 : maxW / ts - 8
  font(ctx, 7); const name = fit(ctx, nameOf(s), lim), nw = ctx.measureText(name).width
  font(ctx, 6); const sub = [role, step ?? s.branch].filter(Boolean).join(' · '), branch = sub ? fit(ctx, sub, lim) : '', bw = branch ? ctx.measureText(branch).width : 0
  const w = Math.max(nw, bw) + 8, h = branch ? 17 : 11
  ctx.fillStyle = full ? 'rgba(10,13,18,.94)' : 'rgba(10,13,18,.8)'; rr(ctx, -w / 2, -5.5, w, h, 5.5); ctx.fill()
  if (full) { ctx.strokeStyle = 'rgba(236,230,217,.35)'; ctx.lineWidth = 0.6; ctx.stroke() }
  font(ctx, 7); ctx.fillStyle = INK; ctx.fillText(name, 0, 0.3)
  if (branch) { font(ctx, 6); ctx.fillStyle = step ? '#d9a441' : '#9aa2b0'; ctx.fillText(branch, 0, 6.8) }
  ctx.restore()
}
function badge(ctx: Ctx, text: string, x: number, y: number, bg: string) {
  font(ctx, 7.5)
  const w = Math.max(11, ctx.measureText(text).width + 7)
  ctx.fillStyle = bg; rr(ctx, x - w / 2, y - 5.5, w, 11, 5.5); ctx.fill()
  ctx.fillStyle = DARK_INK; ctx.fillText(text, x, y + 0.4)
}
function check(ctx: Ctx, x: number, y: number, r = 3.4) {
  ctx.fillStyle = STATE_COLOR.done; ell(ctx, x, y, r, r); ctx.fill()
  ctx.strokeStyle = DARK_INK; ctx.lineWidth = r * 0.32; ctx.lineCap = 'round'
  ctx.beginPath(); ctx.moveTo(x - r * 0.47, y); ctx.lineTo(x - r * 0.1, y + r * 0.38); ctx.lineTo(x + r * 0.5, y - r * 0.38); ctx.stroke()
}
function brackets(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.strokeStyle = INK; ctx.lineWidth = 1.2; ctx.lineCap = 'round'
  const L = 5, x1 = x - 3, y1 = y - 3, x2 = x + w + 3, y2 = y + h + 3
  ctx.beginPath()
  ctx.moveTo(x1, y1 + L); ctx.lineTo(x1, y1); ctx.lineTo(x1 + L, y1)
  ctx.moveTo(x2 - L, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + L)
  ctx.moveTo(x1, y2 - L); ctx.lineTo(x1, y2); ctx.lineTo(x1 + L, y2)
  ctx.moveTo(x2 - L, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - L)
  ctx.stroke()
}

// ---- stations ----
/** The name tag under a person; the hovered or selected one is drawn last and in full. */
function tag(f: Frame, ctx: Ctx, s: Session, x: number, y: number, maxW: number) {
  if (f.focus === s.id) f.top.push(() => nameTag(ctx, s, f.steps[s.id], f.roles[s.id], x, y, maxW, true))
  else f.ui.push(() => nameTag(ctx, s, f.steps[s.id], f.roles[s.id], x, y, maxW, false))
}

interface Frame { tt: number; steps: Record<string, string>; roles: Record<string, string | null>; zx: ReturnType<typeof zoneBounds>; focus: string | null; top: (() => void)[]; ui: (() => void)[]; lights: [number, number, number, string, number][] }

function drawDesk(ctx: Ctx, x: number, y: number, w: number, s: Session, l: Look, f: Frame) {
  const hw = Math.round(w / 2)
  ctx.fillStyle = 'rgba(0,0,0,.34)'; ell(ctx, x, y + 23, hw + 3, 3.5); ctx.fill()
  ctx.fillStyle = '#5e412c'; rr(ctx, x - hw + 2, y + 4, hw * 2 - 4, 18, 2); ctx.fill()
  ctx.fillStyle = '#86603f'; rr(ctx, x - hw - 1, y - 1, hw * 2 + 2, 6, 2); ctx.fill()
  ctx.fillStyle = '#a07452'; ctx.fillRect(x - hw, y - 1, hw * 2, 1)
  ctx.fillStyle = '#3b414d'; rr(ctx, x - 10, y - 15, 20, 14, 2); ctx.fill()
  ctx.fillStyle = '#4a515f'; ctx.fillRect(x - 10, y - 15, 20, 1)
  ctx.fillStyle = l.shirt; ell(ctx, x, y - 8, 1.8, 1.8); ctx.fill()
  ctx.fillStyle = '#2c313b'; rr(ctx, x - 12, y - 2, 24, 2, 1); ctx.fill()
  f.lights.push([x, y - 20, 30, STATE_COLOR.working, s.busy ? 0.12 : 0.28])
  f.ui.push(() => {
    if (f.focus !== s.id) { // the focused one gets a full tag on top instead
      ctx.save(); ctx.translate(x, y + 12); ctx.scale(ts, ts)
      const step = f.steps[s.id], sub = [f.roles[s.id], step ?? s.branch].filter(Boolean).join(' · ')
      font(ctx, 7); ctx.fillStyle = INK; ctx.fillText(fit(ctx, nameOf(s), hw * 2 / ts - 8), 0, sub ? -3 : 0)
      if (sub) { font(ctx, 6); ctx.fillStyle = step ? '#d9a441' : '#b8ad9c'; ctx.fillText(fit(ctx, sub, hw * 2 / ts - 8), 0, 4) }
      ctx.restore()
    }
    if (s.context) {
      const pct = Math.max(0, Math.min(100, s.context.pct))
      ctx.fillStyle = '#0e1116'; rr(ctx, x - 20, y + 26, 40, 3.5, 1.75); ctx.fill()
      ctx.fillStyle = ctxColor(pct); rr(ctx, x - 20, y + 26, Math.max(3.5, 40 * pct / 100), 3.5, 1.75); ctx.fill()
    }
  })
}

function drawStation(ctx: Ctx, s: Session, zone: Zone, x: number, top: number, dest: { x: number; top: number }, moving: boolean, n: number, o: DrawOpts, f: Frame, hits: Hit[]) {
  const l = look(s.id), tt = f.tt
  const feet = top + 36
  let hb: { x: number; y: number; w: number; h: number }
  if (zone === 'desks') {
    const deskY = dest.top + 30, dx = dest.x // the desk waits at the destination slot while the person walks over
    hb = { x: x - 12, y: top, w: 24, h: 30 }
    if (!moving) { ctx.fillStyle = '#262c37'; rr(ctx, dx - 12, deskY - 34, 24, 26, 7); ctx.fill() }
    const head = moving
      ? person(ctx, x, feet, l, { t: tt, walk: true, mood: 'smile' })
      : person(ctx, x, feet, l, { t: tt, mood: s.busy ? 'flat' : 'smile', typing: !s.busy, bob: s.busy ? 0 : Math.sin(tt / 700 + l.seed) * 0.5, noShadow: true })
    drawDesk(ctx, dx, deskY, Math.min(64, slotWidth('desks', n, f.zx) - 6), s, l, f)
    if (f.focus === s.id) f.top.push(() => nameTag(ctx, s, f.steps[s.id], f.roles[s.id], dx, deskY + 9, 0, true))
    if (s.busy && !moving) {
      const busy = s.busy
      f.ui.push(() => busy.kind === 'compact' ? bubble(ctx, x, head - 2, '…', STATE_COLOR.working) : clockBubble(ctx, x, head - 2, tt))
    }
    s.helpers.slice(0, 3).forEach((h, i) => {
      const hx = dx - 18 + i * 18, hf = deskY + 50
      const b = h.state === 'working' && !o.reduced ? -Math.abs(Math.sin(tt / 260 + i)) * 1.2 : 0
      ctx.strokeStyle = rgba(l.shirt, 0.55); ctx.setLineDash([1, 2]); ctx.lineWidth = 0.8
      ctx.beginPath(); ctx.moveTo(dx, deskY + 24); ctx.lineTo(hx, hf - 20); ctx.stroke(); ctx.setLineDash([])
      person(ctx, hx, hf, l, { s: 0.55, t: tt, mood: h.state === 'done' ? 'smile' : 'flat', bob: b, shirt: lighten(l.shirt, 0.4), hair: lighten(l.shirt, 0.15) })
      if (h.state === 'done') f.ui.push(() => check(ctx, hx + 6, hf - 20))
    })
    if (s.helpers.length > 3) f.ui.push(() => badge(ctx, '+' + (s.helpers.length - 3), dx + 38, deskY + 38, rgba(lighten(l.shirt, 0.3), 0.95)))
  } else if (zone === 'lounge') {
    hb = { x: x - 12, y: top, w: 24, h: 36 }
    const starting = s.state === 'starting'
    ctx.save(); ctx.globalAlpha = s.ghost ? 0.35 : 1
    const head = person(ctx, x, feet, l, { t: tt, walk: moving, mood: s.ghost ? 'flat' : starting ? 'o' : 'sleep', shirt: s.ghost || starting ? undefined : mix(l.shirt, '#7d8594', 0.3) })
    ctx.restore()
    if (s.ghost) { // dashed outline: there, but not ours
      ctx.strokeStyle = 'rgba(236,230,217,.55)'; ctx.setLineDash([2, 2]); ctx.lineWidth = 0.8
      rr(ctx, x - 13, top - 2, 26, 40, 6); ctx.stroke(); ctx.setLineDash([])
    }
    if (starting) f.ui.push(() => bubble(ctx, x, head - 2, '…', STATE_COLOR.starting))
    else if (!moving && !s.ghost) f.ui.push(() => {
      ctx.fillStyle = '#b5bcc8'; const z = (tt / 500 | 0) % 3
      font(ctx, 7, 'left'); ctx.fillText('z', x + 9, head - 1 - z)
      font(ctx, 9, 'left'); ctx.fillText('z', x + 13, head - 7 - z)
    })
    tag(f, ctx, s, x, top + 44, slotWidth('lounge', n, f.zx) - 2)
  } else {
    const m = waitMinutes(s, o.now), tired = tiredLevel(m)
    const hop = s.state === 'waiting' && !tired && !moving && !o.reduced ? -Math.abs(Math.sin(tt / 380 + l.seed)) * 2 : 0
    hb = { x: x - 12, y: top, w: 24, h: 36 }
    const sit = tired === 2 && !moving
    const mood: Mood = s.state === 'error' ? 'frown' : s.state === 'done' ? 'smile' : tired ? 'flat' : 'o'
    const head = person(ctx, x, feet, l, { t: tt, walk: moving, sit, mood, slump: tired > 0 && !moving, bob: hop })
    const glyph = s.state === 'waiting' ? (s.card?.kind === 'question' || s.card?.kind === 'asking' ? '?' : '!') : s.state === 'done' ? '✓' : '×'
    f.ui.push(() => {
      bubble(ctx, x, head - 2, glyph, STATE_COLOR[s.state])
      pill(ctx, `${m}m`, x + 15, head - 8, 40, m >= 20 ? STATE_COLOR.error : m >= 10 ? STATE_COLOR.waiting : INK, 6.5)
    })
    tag(f, ctx, s, x, top + 46, slotWidth('help', n, f.zx) - 2)
    if (s.state === 'error') {
      f.lights.push([x, top + 18, 24, STATE_COLOR.error, 0.14])
      if (!moving) for (let k = 0; k < 3; k++) {
        const ph = ((tt / 1400) + k / 3) % 1
        ctx.fillStyle = `rgba(160,170,185,${0.55 * (1 - ph)})`; ell(ctx, x + 6 + ph * 5, head - 4 - ph * 14, 1.6 + ph * 1.6, 1.6 + ph * 1.6); ctx.fill()
      }
    }
    s.helpers.slice(0, 3).forEach((h, i) => {
      const hx = x + 15 + i * 6, b = h.state === 'working' && !o.reduced ? -Math.abs(Math.sin(tt / 260 + i)) : 0
      person(ctx, hx, feet - 4 + b, l, { s: 0.32, t: tt, mood: 'flat', shirt: lighten(l.shirt, 0.4), hair: lighten(l.shirt, 0.15) })
      if (h.state === 'done') f.ui.push(() => check(ctx, hx + 3, feet - 17, 2.2))
    })
    if (s.helpers.length > 3) f.ui.push(() => { ctx.fillStyle = INK; font(ctx, 7, 'left'); ctx.fillText('+' + (s.helpers.length - 3), x + 13, feet + 1) })
  }
  if (o.selectedId === s.id) { const b = hb; f.ui.push(() => brackets(ctx, b.x, b.y, b.w, b.h)) }
  hits.push({ id: s.id, ...hb })
}

// ---- the room ----
function drawScenery(ctx: Ctx, tint: string, H: number, f: Frame) {
  const [lx0, lx1] = f.zx.lounge, [hx0, hx1] = f.zx.help, [dx0, dx1] = f.zx.desks
  let g = ctx.createLinearGradient(0, 0, 0, WALL_H)
  g.addColorStop(0, mix(tint, BG, 0.7)); g.addColorStop(1, mix(tint, BG, 0.82))
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, WALL_H)
  ctx.fillStyle = mix(tint, BG, 0.87); ctx.fillRect(0, 31, W, WALL_H - 31)
  ctx.fillStyle = mix(tint, BG, 0.6); ctx.fillRect(0, 30, W, 1.4)
  for (let i = 0; i < 2; i++) {
    const wx = 150 + i * 100, frame = mix(tint, BG, 0.58)
    ctx.fillStyle = frame; rr(ctx, wx - 2, 3, 48, 25, 3); ctx.fill()
    const sky = ctx.createLinearGradient(0, 5, 0, 26); sky.addColorStop(0, '#0e1730'); sky.addColorStop(1, '#22304f')
    ctx.fillStyle = sky; rr(ctx, wx, 5, 44, 21, 2); ctx.fill()
    ctx.fillStyle = INK; for (const [sx, sy] of [[6, 9], [30, 14], [17, 20], [38, 8]]) { ell(ctx, wx + sx + i * 3, sy, 0.5, 0.5); ctx.fill() }
    if (!i) { ctx.fillStyle = '#efe9cf'; ell(ctx, wx + 34, 11, 3.2, 3.2); ctx.fill(); ctx.fillStyle = '#0e1730'; ell(ctx, wx + 35.6, 10, 2.8, 2.8); ctx.fill() }
    ctx.fillStyle = frame; ctx.fillRect(wx + 21, 5, 2, 21)
  }
  g = ctx.createLinearGradient(0, WALL_H, 0, H); g.addColorStop(0, '#2e343e'); g.addColorStop(1, '#1f232a')
  ctx.fillStyle = g; ctx.fillRect(0, WALL_H, W, H - WALL_H)
  ctx.strokeStyle = 'rgba(0,0,0,.2)'; ctx.lineWidth = 0.6
  for (let y = WALL_H + 10, row = 0; y < H; y += 12, row++) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    for (let x = (row % 2) * 40 + 20; x < W; x += 80) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 12); ctx.stroke() }
  }
  g = ctx.createLinearGradient(0, WALL_H, 0, WALL_H + 12); g.addColorStop(0, 'rgba(0,0,0,.38)'); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.fillRect(0, WALL_H, W, 12)
  // lounge: rug, plant, couch, lamp
  ctx.fillStyle = '#382f4c'; rr(ctx, lx0 + 8, 60, lx1 - lx0 - 16, H - 70, 12); ctx.fill()
  ctx.strokeStyle = '#51466b'; ctx.lineWidth = 1.4; rr(ctx, lx0 + 14, 66, lx1 - lx0 - 28, H - 82, 8); ctx.stroke()
  for (const [x, y, rx, ry, r, c] of [[9, 30, 3, 8, -0.5, '#3d6b45'], [17, 29, 3, 9, 0.45, '#3d6b45'], [13, 26, 3, 9, 0, '#4f8a58'], [7, 36, 2.5, 6, -1, '#4f8a58'], [20, 35, 2.5, 6, 1, '#4f8a58'], [13, 31, 2.5, 7, 0.1, '#2e5235']] as const) { ctx.fillStyle = c; ell(ctx, x, y, rx, ry, r); ctx.fill() }
  ctx.fillStyle = '#8a5a3c'; ctx.beginPath(); ctx.moveTo(6, 40); ctx.lineTo(20, 40); ctx.lineTo(18, 52); ctx.lineTo(8, 52); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#9c6a48'; rr(ctx, 5, 39, 16, 3, 1.5); ctx.fill()
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ell(ctx, 66, 50, 40, 4); ctx.fill()
  ctx.fillStyle = '#4f4266'; rr(ctx, 30, 20, 72, 18, 7); ctx.fill()
  ctx.fillStyle = '#5c4d77'; rr(ctx, 32, 22, 33, 14, 5); ctx.fill(); rr(ctx, 67, 22, 33, 14, 5); ctx.fill()
  ctx.fillStyle = '#46395c'; rr(ctx, 26, 26, 9, 20, 4); ctx.fill(); rr(ctx, 97, 26, 9, 20, 4); ctx.fill()
  ctx.fillStyle = '#5f5079'; rr(ctx, 30, 38, 72, 9, 4); ctx.fill()
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ell(ctx, 110, 62, 7, 1.8); ctx.fill()
  ctx.strokeStyle = '#4a505c'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(110, 30); ctx.lineTo(110, 61); ctx.stroke()
  ctx.fillStyle = '#4a505c'; ell(ctx, 110, 61.5, 5, 1.4); ctx.fill()
  ctx.fillStyle = '#d6a556'; ctx.beginPath(); ctx.moveTo(104, 31); ctx.lineTo(116, 31); ctx.lineTo(113.5, 23); ctx.lineTo(106.5, 23); ctx.closePath(); ctx.fill()
  ctx.fillStyle = '#ffe2a6'; ell(ctx, 110, 31, 6, 1.2); ctx.fill()
  f.lights.push([110, 30, 76, '#ffc46e', 0.22])
  // help desk: counter and bell
  ctx.fillStyle = 'rgba(242,184,75,.05)'; ctx.fillRect(hx0, WALL_H, hx1 - hx0, H - WALL_H)
  ctx.fillStyle = 'rgba(0,0,0,.3)'; ell(ctx, (hx0 + hx1) / 2, 64, 58, 4); ctx.fill()
  ctx.fillStyle = '#5b4330'; rr(ctx, hx0 + 4, 46, hx1 - hx0 - 8, 18, 3); ctx.fill()
  ctx.fillStyle = '#7d5c40'; rr(ctx, hx0 + 2, 43, hx1 - hx0 - 4, 5, 2); ctx.fill()
  ctx.fillStyle = 'rgba(242,184,75,.7)'; ctx.fillRect(hx0 + 4, 48, hx1 - hx0 - 8, 1)
  const bx = hx1 - 22
  ctx.fillStyle = STATE_COLOR.waiting; ctx.beginPath(); ctx.arc(bx, 43, 5, Math.PI, 0); ctx.fill(); ctx.fillRect(bx - 6, 42, 12, 1.6); ell(ctx, bx, 37.5, 1.2, 1.2); ctx.fill()
  f.ui.push(() => {
    font(ctx, 7.5)
    ctx.fillStyle = 'rgba(236,230,217,.6)'; ctx.fillText('LOUNGE', (lx0 + lx1) / 2 + 6, 56); ctx.fillText('DESKS', (dx0 + dx1) / 2, 40)
    ctx.fillStyle = STATE_COLOR.waiting; ctx.fillText('HELP DESK', (hx0 + hx1) / 2 - 8, 38)
  })
}

function drawLight(ctx: Ctx, H: number, f: Frame, waiting: boolean) {
  ctx.fillStyle = 'rgba(6,9,15,.22)'; ctx.fillRect(0, 0, W, H)
  const v = ctx.createRadialGradient(W / 2, H * 0.6, 100, W / 2, H * 0.6, 330)
  v.addColorStop(0, 'rgba(4,6,10,0)'); v.addColorStop(1, 'rgba(4,6,10,.55)')
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H)
  ctx.globalCompositeOperation = 'lighter'
  for (const wx of [150, 250]) {
    const g = ctx.createLinearGradient(0, 26, 0, 150); g.addColorStop(0, 'rgba(150,180,240,.09)'); g.addColorStop(1, 'rgba(150,180,240,0)')
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(wx, 26); ctx.lineTo(wx + 44, 26); ctx.lineTo(wx + 72, 150); ctx.lineTo(wx + 8, 150); ctx.closePath(); ctx.fill()
  }
  const [hx0, hx1] = f.zx.help
  const pulse = waiting ? 0.5 + 0.5 * Math.sin(f.tt / 600) : 0
  glow(ctx, hx1 - 22, 40, 46, STATE_COLOR.waiting, 0.1 + 0.14 * pulse)
  glow(ctx, (hx0 + hx1) / 2, 110, 70, STATE_COLOR.waiting, waiting ? 0.08 : 0.04)
  for (const [x, y, r, c, a] of f.lights) glow(ctx, x, y, r, c, a)
  ctx.globalCompositeOperation = 'source-over'
}

/** Draws one world's room; returns click hit-boxes (in room coordinates) that follow the walking people. */
export function drawRoom(ctx: CanvasRenderingContext2D, o: DrawOpts): Hit[] {
  const illustrated = o.worldDesign === 'classic' ? null : illustratedRoom(ctx, o)
  if (illustrated) return illustrated
  ctx.setTransform(o.k, 0, 0, o.k, 0, 0); ctx.imageSmoothingEnabled = true
  ts = Math.min(1.6, Math.max(1, 10 / (7 * o.k / (globalThis.devicePixelRatio || 1))))
  ctx.clearRect(0, 0, W, o.h)
  const zones = assignZones(o.group.sessions, o.arrivals)
  const f: Frame = { tt: o.reduced ? 0 : o.t, steps: o.steps ?? {}, roles: o.roles ?? {}, zx: zoneBounds(countZones(zones)), focus: o.hoverId ?? o.selectedId, top: [], ui: [], lights: [] }
  drawScenery(ctx, o.group.world.color, o.h, f)

  const live = new Set(o.group.sessions.map((s) => s.id))
  for (const id of o.walkers.keys()) if (!live.has(id)) o.walkers.delete(id)

  const placed: { s: Session; zone: Zone; x: number; top: number; dest: { x: number; top: number }; moving: boolean; n: number }[] = []
  for (const zone of ['lounge', 'desks', 'help'] as Zone[]) {
    const list = zones[zone], cap = capacity(zone)
    list.forEach((s, i) => {
      if (i >= cap) return
      const target = slotPos(zone, i, list.length, f.zx)
      const w = retarget(o.walkers.get(s.id) ?? (s.state === 'starting' && !o.reduced ? doorWalker(target, o.t) : undefined), target, o.t, o.reduced)
      if (o.hoverId === s.id && o.dt && o.t - w.start < WALK_MS) pauseWalker(w, o.dt)
      o.walkers.set(s.id, w)
      const p = walkPos(w.from, w.to, o.t - w.start, o.reduced)
      placed.push({ s, zone, x: p.x, top: p.top, dest: w.to, moving: p.moving, n: list.length })
    })
    const extra = zone === 'lounge' ? (o.moreGhosts ?? 0) : 0
    if (list.length + extra > cap || extra) {
      const x1 = f.zx[zone][1]
      f.ui.push(() => badge(ctx, '+' + (Math.max(0, list.length - cap) + extra), x1 - 15, o.h - 10, INK))
    }
  }
  placed.sort((a, b) => a.top - b.top)
  const hits: Hit[] = []
  for (const p of placed) drawStation(ctx, p.s, p.zone, p.x, p.top, p.dest, p.moving, p.n, o, f, hits)

  drawLight(ctx, o.h, f, zones.help.some((s) => s.state === 'waiting'))
  for (const draw of f.ui) draw()
  for (const draw of f.top) draw()

  const { links, badges } = roomConflicts(o.group.sessions)
  const warn = STATE_COLOR.waiting
  const at = new Map(placed.map((p) => [p.s.id, p]))
  for (const l of links) {
    const a = at.get(l.a), b = at.get(l.b)
    if (!a || !b) continue
    const x1 = a.x, y1 = a.top - 4, x2 = b.x, y2 = b.top - 4, mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 16
    ctx.strokeStyle = warn; ctx.lineWidth = 1.4; ctx.lineCap = 'round'
    ctx.setLineDash([2, 3]); ctx.lineDashOffset = o.reduced ? 0 : -(o.t / 60) % 5
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(mx, (y1 + y2) / 2 - 28, x2, y2); ctx.stroke()
    ctx.setLineDash([]); ctx.lineDashOffset = 0
    badge(ctx, '!', mx, my, warn)
  }
  for (const id of badges) { const p = at.get(id); if (p) badge(ctx, '!', p.x - 18, p.top - 6, warn) } // left of the head: the bubble and timer sit above and right
  return hits
}

/** Finds the session under a point given in room coordinates. */
export const hitTest = (hits: Hit[], px: number, py: number): Hit | undefined =>
  hits.find((h) => px >= h.x - (h.exact ? 0 : 9) && px <= h.x + h.w + (h.exact ? 0 : 9) && py >= h.y - (h.exact ? 0 : 20) && py <= h.y + h.h + (h.exact ? 0 : 26))
