import type { Session, SessionState } from './types'

export type Zone = 'lounge' | 'desks' | 'help'
export const ROOM_W = 480
export const ROOM_H = 250
export const FLOOR_TOP = 48
/** Horizontal extent of each zone in room coordinates. */
export const ZONE_X: Record<Zone, [number, number]> = { lounge: [0, 120], desks: [120, 360], help: [360, 480] }
const MAX_COLS: Record<Zone, number> = { lounge: 3, desks: 4, help: 3 }
const MAX_ROWS: Record<Zone, number> = { lounge: 3, desks: 2, help: 3 }
const ROW_H: Record<Zone, number> = { lounge: 66, desks: 98, help: 66 }
const FIRST_TOP: Record<Zone, number> = { lounge: 76, desks: 68, help: 76 }
export const WALK_MS = 1000

export const zoneOf = (state: SessionState): Zone => (state === 'working' ? 'desks' : state === 'idle' ? 'lounge' : 'help')
export const capacity = (zone: Zone): number => MAX_COLS[zone] * MAX_ROWS[zone]

/** Sessions per zone, in a stable order (start time, then id) so slots never shuffle when states change. */
export function assignZones(sessions: Session[]): Record<Zone, Session[]> {
  const out: Record<Zone, Session[]> = { lounge: [], desks: [], help: [] }
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  for (const s of sorted) out[zoneOf(s.state)].push(s)
  return out
}

export interface Pos { x: number; top: number }

/** Centre-x and sprite-top of slot `i` when `n` sessions share the zone; spacing shrinks as n grows. */
export function slotPos(zone: Zone, i: number, n: number): Pos {
  const cols = Math.max(1, Math.min(n, MAX_COLS[zone]))
  const [x0, x1] = ZONE_X[zone]
  const col = i % cols, row = Math.floor(i / cols)
  const pad = 10 // keeps timers and bubbles inside the room edge
  return { x: Math.round(x0 + pad + (col + 0.5) * (x1 - x0 - 2 * pad) / cols), top: FIRST_TOP[zone] + row * ROW_H[zone] }
}
/** Width available to one slot (desks shrink with it). */
export const slotWidth = (zone: Zone, n: number): number => (ZONE_X[zone][1] - ZONE_X[zone][0] - 20) / Math.max(1, Math.min(n, MAX_COLS[zone]))

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

/** Room height that fits the busiest zone (never shorter than a small room). */
export function roomHeight(sessions: Session[]): number {
  const z = assignZones(sessions)
  let need = 0
  for (const zone of ['lounge', 'desks', 'help'] as Zone[]) {
    const n = Math.min(z[zone].length, capacity(zone))
    if (!n) continue
    const rows = Math.ceil(n / Math.min(n, MAX_COLS[zone]))
    const bottom = FIRST_TOP[zone] + (rows - 1) * ROW_H[zone] + (zone === 'desks' ? 118 : 56)
    need = Math.max(need, bottom)
  }
  return Math.min(ROOM_H, Math.max(150, need + 8))
}
