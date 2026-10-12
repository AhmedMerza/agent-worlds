// Generates the pixel-art app icons into public/. No dependencies: `node scripts/make-icons.mjs`.
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')
const BG = [0x12, 0x16, 0x1d], TEAL = [0x47, 0xb4, 0xa7], PINK = [0xe0, 0x7a, 0xa8], YELLOW = [0xf2, 0xb8, 0x4b]
// 16x16 grid, drawn back to front: the same three squares as the header mark.
const RECTS = [[TEAL, 3, 7, 4, 4], [PINK, 9, 7, 4, 4], [YELLOW, 6, 3, 4, 4]]

function pixel(x, y, size, scale) {
  const u = Math.floor(((x / size - 0.5) / scale + 0.5) * 16), v = Math.floor(((y / size - 0.5) / scale + 0.5) * 16)
  let c = BG
  for (const [col, rx, ry, rw, rh] of RECTS) if (u >= rx && u < rx + rw && v >= ry && v < ry + rh) c = col
  return c
}
function png(size, scale) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x + 0.5, y + 0.5, size, scale), o = y * (size * 4 + 1) + 1 + x * 4
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const files = { 'icon-192.png': [192, 1], 'icon-512.png': [512, 1], 'icon-maskable-512.png': [512, 0.8], 'apple-touch-icon.png': [180, 0.9] }
for (const [name, [size, scale]] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), png(size, scale))
console.log('wrote', Object.keys(files).join(', '))
