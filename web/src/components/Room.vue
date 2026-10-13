<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RoomGroup } from '../types'
import { drawRoom, hitTest, W, type Hit } from '../canvas'
import { roomHeight, type Walker } from '../zones'
import { LABEL, NEEDS_YOU, roomConflicts, UNSORTED, splitGhosts, drawnSessions, ghostChipText } from '../logic'
import { state, select } from '../store'

const props = defineProps<{ group: RoomGroup; numbers: Record<string, number> }>()
defineEmits<{ 'new-task': [worldId: string] }>()
const conflictN = computed(() => { const c = roomConflicts(props.group.sessions); return c.links.length + c.badges.length })
const canCreate = computed(() => props.group.world.id !== UNSORTED.id)
const wrap = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const split = computed(() => splitGhosts(props.group.sessions))
const real = computed(() => split.value.real)
const ghostsOpen = ref(false)
/** The scene draws every real session but only a few ghosts; the rest wait in the chip. */
const drawn = computed(() => drawnSessions(props.group.sessions))
const scene = computed<RoomGroup>(() => ({ world: props.group.world, sessions: drawn.value.sessions }))
const count = (st: (s: string) => boolean) => real.value.filter((s) => st(s.state)).length
const needN = computed(() => count((st) => NEEDS_YOU.includes(st as never)))
const working = computed(() => count((st) => st === 'working'))
const idle = computed(() => count((st) => st === 'idle'))

const h = computed(() => roomHeight(scene.value.sessions))
const walkers = new Map<string, Walker>()
let hits: Hit[] = []
let raf = 0
let k = 1
let hLog = 250
let lastStatic = ''
const hoverId = ref<string | null>(null)
let lastT = 0

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
    const key = JSON.stringify([scene.value.sessions, state.selectedId, Math.floor(state.now / 60000), c.width, c.height, h.value])
    if (key === lastStatic) return
    lastStatic = key
  }
  const dt = lastT ? Math.min(100, t - lastT) : 0
  lastT = t
  hits = drawRoom(ctx, { group: scene.value, selectedId: state.selectedId, t, now: state.now, reduced, walkers, k, h: Math.max(h.value, hLog), hoverId: hoverId.value, dt, moreGhosts: drawn.value.hidden })
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
const onMove = (e: MouseEvent) => { const h = at(e); hoverId.value = h?.id ?? null; canvas.value!.style.cursor = h ? 'pointer' : 'default' }
</script>

<template>
  <article class="room" :style="{ '--tint': group.world.color }">
    <header>
      <h2>{{ group.world.name }}</h2>
      <span class="meta">{{ needN }} need you · {{ working }} working · {{ idle }} idle</span>
      <span v-if="conflictN" class="warn" :title="'Sessions in this room may be working on the same thing'">⚠ {{ conflictN }}</span>
      <button v-if="canCreate" class="room-btn" @click="$emit('new-task', group.world.id)">+ New session</button>
    </header>
    <div ref="wrap" class="canvas-wrap"><canvas ref="canvas" :aria-label="`${group.world.name} room`" @click="onClick" @mousemove="onMove" @mouseleave="hoverId = null" /></div>
    <div class="chips">
      <p v-if="!group.sessions.length" class="meta">No sessions yet.</p>
      <button v-for="s in real" :key="s.id" class="chip" :aria-pressed="state.selectedId === s.id" @click="select(s.id)">
        <span class="k">{{ numbers[s.id] ?? '' }}</span><span :class="['dot', s.state]" />{{ s.repoName }} <span class="st">{{ LABEL[s.state] }}</span><span v-if="s.lastPrompt ?? s.task" class="st chip-task" :title="s.lastPrompt ?? s.task ?? undefined">{{ s.lastPrompt ?? s.task }}</span>
      </button>
      <button v-if="split.ghosts.length" class="chip chip-ghosts" :aria-expanded="ghostsOpen" @click="ghostsOpen = !ghostsOpen">
        <span class="dot ghost" />{{ ghostChipText(split.ghosts.length) }} <span class="st">{{ ghostsOpen ? 'Hide' : 'Show' }}</span>
      </button>
      <template v-if="ghostsOpen">
        <button v-for="s in split.ghosts" :key="s.id" class="chip" :aria-pressed="state.selectedId === s.id" @click="select(s.id)">
          <span class="dot ghost" />{{ s.repoName }} <span class="st chip-task" :title="s.task ?? undefined">{{ s.task ?? 'plain terminal' }}</span>
        </button>
      </template>
    </div>
  </article>
</template>
