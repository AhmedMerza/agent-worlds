<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ worlds: string[] }>()
const svg = ref<SVGSVGElement | null>(null)
const paths = ref<string[]>([])
const hub = ref({ x: 0, y: 0 })
const size = ref({ width: 1, height: 1 })
let observer: ResizeObserver | undefined
let frame = 0

function measure() {
  const parent = svg.value?.parentElement
  if (!parent) return
  const bounds = parent.getBoundingClientRect()
  const rooms = [...parent.querySelectorAll('canvas')].map(el => el.getBoundingClientRect()).filter(r => r.width)
  if (rooms.length < 2) { paths.value = []; return }
  const bottoms = [...parent.querySelectorAll('.room')].map(el => el.getBoundingClientRect().bottom - bounds.top + parent.scrollTop)
  size.value = { width: parent.clientWidth, height: Math.max(parent.clientHeight, ...bottoms) + 12 }
  const points = rooms.map((r, i) => ({
    x: r.left - bounds.left + parent.scrollLeft + r.width * (i % 2 ? .08 : .92),
    y: r.top - bounds.top + parent.scrollTop + r.width * .62,
  }))
  const x = parent.clientWidth / 2
  const y = points.length > 2 ? (points[0].y + points[2].y) / 2 : points[0].y + 75
  hub.value = { x, y }
  paths.value = points.map(p => {
    // Short diagonal entrances meet a spine contained in the gap between offices.
    const bendY = p.y + Math.sign(y - p.y) * Math.abs(x - p.x) / 2
    return `M ${p.x} ${p.y} L ${x} ${bendY} L ${x} ${y}`
  })
}
function schedule() { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
async function observeRooms() {
  await nextTick()
  observer?.disconnect()
  const parent = svg.value?.parentElement
  if (parent) {
    observer?.observe(parent)
    parent.querySelectorAll('.room, .canvas-wrap').forEach(el => observer?.observe(el))
  }
  schedule()
}
onMounted(() => { observer = new ResizeObserver(schedule); observeRooms() })
watch(() => props.worlds.join('|'), observeRooms)
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(frame) })
</script>

<template>
  <svg ref="svg" class="world-connections" :width="size.width" :height="size.height" aria-hidden="true">
    <defs>
      <linearGradient id="walkway-floor" x1="0" y1="0" x2="0" y2="1">
        <stop stop-color="#5c7897"/><stop offset="1" stop-color="#263d59"/>
      </linearGradient>
    </defs>
    <g v-for="(path, i) in paths" :key="i" fill="none" stroke-linejoin="bevel">
      <path :d="path" transform="translate(0 14)" stroke="#07121f" stroke-width="40"/>
      <path :d="path" transform="translate(0 8)" stroke="#1d314a" stroke-width="38"/>
      <path :d="path" stroke="#81b6dc" stroke-width="38"/>
      <path :d="path" stroke="url(#walkway-floor)" stroke-width="34"/>
      <path :d="path" stroke="#bfd6eb" stroke-opacity=".18" stroke-width="1" stroke-dasharray="2 14"/>
    </g>
    <g v-if="paths.length" :transform="`translate(${hub.x} ${hub.y})`">
      <path d="M -56 0 L 0 -30 L 56 0 L 56 14 L 0 44 L -56 14 Z" fill="#1d3048" stroke="#456182"/>
      <path d="M -56 0 L 0 -30 L 56 0 L 0 30 Z" fill="#48617c" stroke="#98c4e5" stroke-width="2"/>
      <path d="M -28 0 L 0 -15 L 28 0 L 28 13 L 0 28 L -28 13 Z" fill="#c2b69c" stroke="#f4d997"/>
      <path d="M -25 -2 L 0 -15 L 25 -2 L 0 11 Z" fill="#273b37"/>
      <path d="M -38 15 L -25 22 M 25 22 L 38 15" stroke="#ffdc83" stroke-width="5"/>
      <path d="M 0 3 Q -5 -20 1 -46 M 0 0 Q -17 -10 -23 -31 M 1 -2 Q 18 -15 23 -35" fill="none" stroke="#528750" stroke-width="3"/>
      <g fill="#76a85c" stroke="#365c3e" stroke-width="1">
        <ellipse cx="-14" cy="-19" rx="6" ry="17" transform="rotate(-40 -14 -19)"/>
        <ellipse cx="14" cy="-25" rx="6" ry="18" transform="rotate(40 14 -25)"/>
        <ellipse cx="0" cy="-35" rx="6" ry="18"/>
        <ellipse cx="-7" cy="-8" rx="5" ry="13" transform="rotate(-65 -7 -8)"/>
        <ellipse cx="9" cy="-10" rx="5" ry="14" transform="rotate(65 9 -10)"/>
      </g>
    </g>
  </svg>
</template>
