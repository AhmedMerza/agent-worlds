import type { Session } from './types'

/** Where people stand on the office art (office.png, square): % of its width and height, an isometric 3×3 grid on the floor. */
const GRID = [-1, 0, 1].flatMap(i => [-1, 0, 1].map(j => ({ x: 50 + (i - j) * 14, y: 67 + (i + j) * 8 })))
export const HQ_PAGE_SIZE = GRID.length

/** One page of the office: oldest first, each on a station, listed back to front so nearer people draw over farther ones. */
export function hqPlaces(sessions: Session[], page: number): { s: Session; x: number; y: number }[] {
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const start = Math.max(0, Math.min(page, Math.ceil(sorted.length / HQ_PAGE_SIZE) - 1)) * HQ_PAGE_SIZE
  // Fill from the middle of the floor outwards, so a small team stands together.
  const order = [...GRID].sort((a, b) => Math.hypot(a.x - 50, (a.y - 67) * 1.75) - Math.hypot(b.x - 50, (b.y - 67) * 1.75))
  return sorted.slice(start, start + HQ_PAGE_SIZE).map((s, i) => ({ s, ...order[i] })).sort((a, b) => a.y - b.y || a.x - b.x)
}

export type Camera = { z: number; x: number; y: number }
export const HQ_MIN_ZOOM = 1, HQ_MAX_ZOOM = 3
/** The camera that puts point (px, py) of a w×h stage at stage point (cx, cy), default its middle, at zoom z
 *  (transform: translate(x, y) scale(z), origin 0 0). It never shows past the stage's edges. */
export function cameraOn(w: number, h: number, px: number, py: number, z: number, cx = w / 2, cy = h / 2): Camera {
  z = Math.min(HQ_MAX_ZOOM, Math.max(HQ_MIN_ZOOM, z))
  const clamp = (v: number, size: number) => Math.min(0, Math.max(size - size * z, v))
  return { z, x: clamp(cx - px * z, w), y: clamp(cy - py * z, h) }
}

/** The middle of what you can see of `el` (in its own pixels): not scrolled away, not under the person's card,
 *  which floats over the window's left 360px, or on a phone its bottom 62%. */
export function viewCentre(el: HTMLElement): { x: number; y: number } {
  const b = el.getBoundingClientRect(), phone = innerWidth < 700
  let l = Math.max(b.left, phone ? 0 : 368), r = Math.min(b.right, innerWidth), t = Math.max(b.top, 0), btm = Math.min(b.bottom, phone ? innerHeight * .38 : innerHeight)
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowY === 'visible') continue
    const q = p.getBoundingClientRect()
    l = Math.max(l, q.left); r = Math.min(r, q.right); t = Math.max(t, q.top); btm = Math.min(btm, q.bottom)
  }
  return r > l && btm > t ? { x: (l + r) / 2 - b.left, y: (t + btm) / 2 - b.top } : { x: b.width / 2, y: b.height / 2 }
}

/** 1234 → "1.2k", 3_400_000 → "3.4M". */
export const tokenText = (n: number): string =>
  n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n)
export const usageTotal = (u: NonNullable<Session['usage']>): number => u.input + u.output + u.cacheRead + u.cacheWrite
