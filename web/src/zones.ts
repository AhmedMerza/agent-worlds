import type { Session, SessionState } from './types'

export type Zone = 'lounge' | 'desks' | 'help'
export const ROOM_W = 480
export const ROOM_H = 300
export const FLOOR_TOP = 48
/** Horizontal extent of each zone in a quiet room; a busy room uses zoneBounds. */
export const ZONE_X: Record<Zone, [number, number]> = { lounge: [0, 120], desks: [120, 360], help: [360, 480] }
const MAX_COLS: Record<Zone, number> = { lounge: 3, desks: 4, help: 3 }
const MAX_ROWS: Record<Zone, number> = { lounge: 3, desks: 2, help: 3 }
const ROW_H: Record<Zone, number> = { lounge: 80, desks: 112, help: 80 }
const FIRST_TOP: Record<Zone, number> = { lounge: 76, desks: 68, help: 76 }
export const WALK_MS = 1000

export const zoneOf = (state: SessionState): Zone => (state === 'working' ? 'desks' : state === 'idle' || state === 'starting' ? 'lounge' : 'help')
export const capacity = (zone: Zone): number => MAX_COLS[zone] * MAX_ROWS[zone]

/** Sessions per zone, in a stable order (start time, then id) so slots never shuffle when states change.
 *  With `arrivals` (kept between frames, updated here) the desks go in arrival order instead: whoever comes back takes the last desk. */
export function assignZones(sessions: Session[], arrivals?: Set<string>): Record<Zone, Session[]> {
  const out: Record<Zone, Session[]> = { lounge: [], desks: [], help: [] }
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  for (const s of sorted) out[zoneOf(s.state)].push(s)
  if (arrivals) {
    const at = new Set(out.desks.map((s) => s.id))
    for (const id of arrivals) if (!at.has(id)) arrivals.delete(id)
    for (const s of out.desks) arrivals.add(s.id)
    const rank = new Map([...arrivals].map((id, i) => [id, i]))
    out.desks.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  }
  return out
}

export interface Pos { x: number; top: number }

type Bounds = Record<Zone, [number, number]>
const COL_W: Record<Zone, number> = { lounge: 46, desks: 55, help: 54 }
/** Lounge furniture and the help counter need this much; desks can go narrower. */
const MIN_W: Record<Zone, number> = { lounge: 120, desks: 140, help: 120 }

/** Zone extents for a room: a crowded zone widens (up to what its columns need) and a quiet one gives way.
 *  When every zone wants more than the room has, each gets its share in proportion. */
export function zoneBounds(counts: Record<Zone, number>): Bounds {
  const want = {} as Record<Zone, number>
  for (const z of ['lounge', 'desks', 'help'] as Zone[]) want[z] = Math.max(MIN_W[z], 20 + Math.max(1, Math.min(counts[z], MAX_COLS[z])) * COL_W[z])
  const total = want.lounge + want.desks + want.help
  let l = want.lounge, h = want.help
  if (total > ROOM_W) { l = Math.round(want.lounge * ROOM_W / total); h = Math.round(want.help * ROOM_W / total) }
  return { lounge: [0, l], desks: [l, ROOM_W - h], help: [ROOM_W - h, ROOM_W] }
}
export const countZones = (z: Record<Zone, unknown[]>): Record<Zone, number> => ({ lounge: z.lounge.length, desks: z.desks.length, help: z.help.length })

/** Centre-x and sprite-top of slot `i` when `n` sessions share the zone; spacing shrinks as n grows. */
export function slotPos(zone: Zone, i: number, n: number, bounds: Bounds = ZONE_X): Pos {
  const cols = Math.max(1, Math.min(n, MAX_COLS[zone]))
  const [x0, x1] = bounds[zone]
  const col = i % cols, row = Math.floor(i / cols)
  const pad = 10 // keeps timers and bubbles inside the room edge
  return { x: Math.round(x0 + pad + (col + 0.5) * (x1 - x0 - 2 * pad) / cols), top: FIRST_TOP[zone] + row * ROW_H[zone] }
}
/** Width available to one slot (desks shrink with it). */
export const slotWidth = (zone: Zone, n: number, bounds: Bounds = ZONE_X): number => (bounds[zone][1] - bounds[zone][0] - 20) / Math.max(1, Math.min(n, MAX_COLS[zone]))

/** Eased position between two slots. `moving` is false once arrived (or when motion is reduced). */
export function walkPos(from: Pos, to: Pos, elapsedMs: number, reduced: boolean, dur = WALK_MS): Pos & { moving: boolean } {
  if (reduced || elapsedMs >= dur || (from.x === to.x && from.top === to.top)) return { ...to, moving: false }
  const t = Math.max(0, elapsedMs) / dur, e = t * t * (3 - 2 * t)
  return { x: from.x + (to.x - from.x) * e, top: from.top + (to.top - from.top) * e, moving: true }
}

export interface Walker { from: Pos; to: Pos; start: number }
/** Updates a walker for a new target; a changed target starts a walk from wherever the sprite is now. */
export function retarget(w: Walker | undefined, target: Pos, now: number, reduced: boolean): Walker {
  if (!w) return { from: target, to: target, start: now }
  if (w.to.x === target.x && w.to.top === target.top) return w
  const cur = walkPos(w.from, w.to, now - w.start, reduced)
  return { from: { x: cur.x, top: cur.top }, to: target, start: now }
}

/** Holds a walk still for `dt` ms (the pointer is over the sprite): the walk resumes where it stopped. */
export function pauseWalker(w: Walker, dt: number): void { w.start += dt }

/** A newcomer starts outside the left wall and walks in through the door to its slot. */
export const doorWalker = (to: Pos, now: number): Walker => ({ from: { x: -16, top: to.top }, to, start: now })

/** Room height that fits the busiest zone (never shorter than a small room). */
export function roomHeight(sessions: Session[]): number {
  const z = assignZones(sessions)
  let need = 0
  for (const zone of ['lounge', 'desks', 'help'] as Zone[]) {
    const n = Math.min(z[zone].length, capacity(zone))
    if (!n) continue
    const rows = Math.ceil(n / Math.min(n, MAX_COLS[zone]))
    const bottom = FIRST_TOP[zone] + (rows - 1) * ROW_H[zone] + (zone === 'desks' ? 124 : 66)
    need = Math.max(need, bottom)
  }
  return Math.min(ROOM_H, Math.max(150, need + 8))
}
