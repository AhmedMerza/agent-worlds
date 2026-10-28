import type { DrawOpts, Hit } from './canvas'
import type { Session } from './types'
import { nameOf, stateLabel } from './logic'

const office = typeof Image === 'undefined' ? null : new Image()
if (office) office.src = '/art/office.png'
const agents = typeof Image === 'undefined' ? null : new Image()
if (agents) agents.src = '/art/agents.png'
export const illustrationReady = () => !!(office?.complete && office.naturalWidth && agents?.complete && agents.naturalWidth)

export const OFFICE_PAGE_SIZE = 4
export function officePage(sessions: Session[], page: number): Session[] {
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const index = Math.max(0, Math.min(page, Math.ceil(sorted.length / OFFICE_PAGE_SIZE) - 1))
  return sorted.slice(index * OFFICE_PAGE_SIZE, (index + 1) * OFFICE_PAGE_SIZE)
}

/** Real session hit targets are drawn with the artwork, never baked into it. */
export function illustratedRoom(ctx: CanvasRenderingContext2D, o: DrawOpts): Hit[] | null {
  if (!office || !agents || !illustrationReady()) return null
  ctx.setTransform(o.k, 0, 0, o.k, 0, 0)
  ctx.clearRect(0, 0, 480, o.h)
  const size = Math.min(480, o.h)
  const y = Math.max(0, (o.h - size) / 2)
  ctx.save()
  const tint = o.group.world.color.replace('#', '')
  const rgb = [0, 2, 4].map(i => parseInt(tint.slice(i, i + 2), 16) / 255)
  const max = Math.max(...rgb), min = Math.min(...rgb), d = max - min
  const hue = !d ? 180 : 60 * (max === rgb[0] ? ((rgb[1] - rgb[2]) / d + 6) % 6 : max === rgb[1] ? (rgb[2] - rgb[0]) / d + 2 : (rgb[0] - rgb[1]) / d + 4)
  ctx.filter = `hue-rotate(${hue - 180}deg)`
  ctx.drawImage(office, 0, y, 480, size)
  ctx.restore()
  const sessions = [...o.group.sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const hits: Hit[] = []
  const labelHits: Hit[] = []
  const labels: (() => void)[] = []
  sessions.forEach((s, i) => {
    // Four readable stations; the room component pages larger teams.
    const [x, floorY] = [[240, 260], [140, 325], [340, 325], [240, 400]][i % OFFICE_PAGE_SIZE]
    const feet = y + size * floorY / 480
    const working = s.state === 'working'
    const idle = s.state === 'idle' || s.state === 'starting'
    const variant = [...s.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 3
    const sw = agents.naturalWidth / 3
    const split = agents.naturalHeight * .45
    const sh = working ? split : agents.naturalHeight - split
    const h = working ? 126 : 115
    const w = h * sw / sh
    const top = feet - h
    ctx.save()
    if ('ghost' in s && s.ghost) ctx.globalAlpha = .55
    ctx.drawImage(agents, (working ? variant : idle ? 2 : variant % 2) * sw, working ? 0 : split, sw, sh, x - w / 2, top, w, h)
    ctx.restore()
    const color = s.state === 'working' ? '#66e59c' : s.state === 'waiting' ? '#ffcf55' : s.state === 'error' ? '#ff817b' : '#aebed4'
    const selected = o.selectedId === s.id || o.hoverId === s.id
    const label = nameOf(s)
    const textScale = Math.min(1.8, Math.max(1, (globalThis.devicePixelRatio || 1) / o.k))
    ctx.font = `600 ${10 * textScale}px system-ui`
    const width = Math.min(150, Math.max(76, ctx.measureText(label).width + 16))
    const labelHeight = 29 * textScale
    labels.push(() => {
      ctx.fillStyle = '#081426ee'
      ctx.strokeStyle = selected ? '#ffffff' : color
      ctx.lineWidth = selected ? 2 : .8
      ctx.beginPath(); ctx.roundRect(x - width / 2, feet - 3, width, labelHeight, 5); ctx.fill(); ctx.stroke()
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillStyle = color; ctx.font = `600 ${8 * textScale}px system-ui`
      ctx.fillText([o.roles?.[s.id], stateLabel(s, o.now)].filter(Boolean).join(' · '), x, feet + 6 * textScale, width - 8)
      ctx.fillStyle = '#f1f5ff'; ctx.font = `600 ${10 * textScale}px system-ui`
      ctx.fillText(label, x, feet + 19 * textScale, width - 8)
    })
    labelHits.push({ id: s.id, x: x - width / 2, y: feet - 3, w: width, h: labelHeight, exact: true })
    hits.push({ id: s.id, x: x - w / 2, y: top, w, h, exact: true })
  })
  labels.forEach(draw => draw())
  return [...labelHits.reverse(), ...hits.reverse()]
}
