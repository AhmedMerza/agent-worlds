<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RoomGroup } from '../types'
import { drawRoom, hitTest, W, type Hit } from '../canvas'
import { roomHeight, type Walker } from '../zones'
import { LABEL, NEEDS_YOU, roomConflicts, UNSORTED } from '../logic'
import { state, select, ui } from '../store'

const props = defineProps<{ group: RoomGroup; numbers: Record<string, number> }>()
defineEmits<{ 'new-task': [worldId: string] }>()
const conflictN = computed(() => { const c = roomConflicts(props.group.sessions); return c.links.length + c.badges.length })
const canCreate = computed(() => props.group.world.id !== UNSORTED.id)
const wrap = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const count = (st: (s: string) => boolean) => props.group.sessions.filter((s) => st(s.state)).length
const needN = computed(() => count((st) => NEEDS_YOU.includes(st as never)))
const working = computed(() => count((st) => st === 'working'))
const idle = computed(() => count((st) => st === 'idle'))

const h = computed(() => roomHeight(props.group.sessions))
const walkers = new Map<string, Walker>()
let hits: Hit[] = []
let raf = 0
let k = 1
let hLog = 250
let lastStatic = ''

/** The canvas fills its box exactly (width AND height). The scene scales by width; spare height is extra floor. */
function fitCanvas() {
  const c = canvas.value, box = wrap.value
  if (!c || !box) return
  const dpr = window.devicePixelRatio || 1
  box.style.minHeight = `${(h.value * box.clientWidth) / W}px` // never shorter than the scene needs
  c.width = Math.max(1, Math.round(box.clientWidth * dpr)); c.height = Math.max(1, Math.round(box.clientHeight * dpr))
  k = c.width / W
  hLog = c.height / k
  lastStatic = ''
}

function frame(t: number) {
  raf = requestAnimationFrame(frame)
  const c = canvas.value
  if (!c || document.hidden || c.offsetParent === null) return
  const ctx = c.getContext('2d')
  if (!ctx) return
  // With reduced motion the picture only changes when data does, so skip identical redraws.
  if (reduced) {
    const key = JSON.stringify([props.group.sessions, state.selectedId, Math.floor(state.now / 60000), c.width, c.height, h.value])
    if (key === lastStatic) return
    lastStatic = key
  }
  hits = drawRoom(ctx, { group: props.group, selectedId: state.selectedId, t, now: state.now, reduced, walkers, k, h: Math.max(h.value, hLog) })
}
let ro: ResizeObserver | null = null
onMounted(() => {
  fitCanvas()
  ro = new ResizeObserver(fitCanvas)
  if (wrap.value) ro.observe(wrap.value)
  raf = requestAnimationFrame(frame)
})
watch(h, fitCanvas, { flush: 'post' })
onBeforeUnmount(() => { cancelAnimationFrame(raf); ro?.disconnect() })

function at(e: MouseEvent): Hit | undefined {
  const b = canvas.value!.getBoundingClientRect()
  return hitTest(hits, (e.clientX - b.left) / b.width * W, (e.clientY - b.top) / b.height * hLog)
}
const onClick = (e: MouseEvent) => { const h = at(e); if (h) select(h.id) }
const onMove = (e: MouseEvent) => { canvas.value!.style.cursor = at(e) ? 'pointer' : 'default' }
</script>

<template>
  <article class="room" :style="{ '--tint': group.world.color }">
    <header>
      <h2>{{ group.world.name }}</h2>
      <span class="meta">{{ needN }} need you · {{ working }} working · {{ idle }} idle</span>
      <span v-if="conflictN" class="warn" :title="'Sessions in this room may be working on the same thing'">⚠ {{ conflictN }}</span>
      <button v-if="canCreate" class="room-btn" @click="$emit('new-task', group.world.id)">+ New session</button>
    </header>
    <div ref="wrap" class="canvas-wrap"><canvas ref="canvas" :aria-label="`${group.world.name} room`" @click="onClick" @mousemove="onMove" /></div>
    <div class="chips">
      <p v-if="!group.sessions.length" class="meta">No sessions yet.</p>
      <template v-for="s in group.sessions" :key="s.id">
        <button class="chip" :aria-pressed="state.selectedId === s.id" @click="select(s.id)">
          <span class="k">{{ numbers[s.id] ?? '' }}</span><span :class="['dot', s.state]" />{{ s.repoName }} <span class="st">{{ LABEL[s.state] }}</span>
        </button>
        <button v-if="!canCreate" class="chip-more" @click="ui.putSession = s.id">Put {{ s.repoName }} in a world…</button>
      </template>
    </div>
  </article>
</template>
