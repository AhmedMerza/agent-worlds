const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright')
const OUT = process.env.MEDIA_OUT || path.join(__dirname, '..', '..', '..', 'docs', 'media')
const TMP = process.env.REC_TMP || path.join(require('os').tmpdir(), 'awrec')

// A visible pointer ring so viewers can follow clicks (headless screenshots have no cursor).
const POINTER = `(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;z-index:99999;width:22px;height:22px;margin:-11px 0 0 -11px;border:2px solid #ece6d9;border-radius:50%;background:rgba(236,230,217,.25);pointer-events:none;left:-50px;top:-50px;transition:transform .08s'; document.addEventListener('DOMContentLoaded', () => document.body.appendChild(d)); addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px' }); addEventListener('mousedown', () => d.style.transform = 'scale(.7)'); addEventListener('mouseup', () => d.style.transform = '') })()`

async function open(width, height, pointer = true) {
  const b = await chromium.launch()
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  if (pointer) await ctx.addInitScript(POINTER)
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
  return { b, p, errs }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function move(p, loc, steps = 12) { const bx = await loc.boundingBox(); await p.mouse.move(bx.x + bx.width / 2, bx.y + bx.height / 2, { steps }) }

/** Captures frames while `fn` runs, then writes an optimised GIF. */
async function record(p, clip, name, fn, { colors = 128, minCs = 5 } = {}) {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true })
  const frames = []
  let on = true
  const loop = (async () => {
    for (let i = 0; on; i++) {
      const t = Date.now(), file = path.join(TMP, String(i).padStart(4, '0') + '.png')
      fs.writeFileSync(file, await p.screenshot({ clip }))
      frames.push({ file, t })
    }
  })()
  await fn()
  on = false; await loop
  frames.push({ file: null, t: Date.now() })
  // merge identical neighbours, delay = time until the next distinct frame
  const keep = []
  for (let i = 0; i < frames.length - 1; i++) {
    const buf = fs.readFileSync(frames[i].file)
    const dur = frames[i + 1].t - frames[i].t
    const last = keep[keep.length - 1]
    if (last && last.buf.equals(buf)) last.dur += dur
    else keep.push({ file: frames[i].file, buf, dur })
  }
  const args = []
  for (const k of keep) args.push('-delay', String(Math.max(minCs, Math.min(250, Math.round(k.dur / 10)))), k.file)
  args.push('-fuzz', '2%', '+dither', '-colors', String(colors), '-layers', 'OptimizeTransparency', '-loop', '0', path.join(OUT, name))
  execFileSync('convert', args)
  const size = fs.statSync(path.join(OUT, name)).size
  console.log(name, 'frames', keep.length, 'of', frames.length - 1, 'bytes', size, 'seconds', ((frames[frames.length - 1].t - frames[0].t) / 1000).toFixed(1))
}
module.exports = { open, record, move, sleep, OUT }
