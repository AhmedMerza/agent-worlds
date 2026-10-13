<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RoomGroup } from '../types'
import { drawRoom, hitTest, W, type Hit } from '../canvas'
import { roomHeight, type Walker } from '../zones'
import { dropTarget, stateLabel, NEEDS_YOU, roomConflicts, UNSORTED, splitGhosts, drawnSessions, ghostChipText, isTouch } from '../logic'
import { state, select, focusTerminal, ui, moveSession, showToast } from '../store'

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
/** A mouse click also puts you in the session's terminal, so what you type next goes to Claude.
 *  Not on touch (it would leave the Rooms tab and pop the keyboard); 1-9 keep the shortcuts. */
function open(id: string) {
  select(id)
  const s = state.sessions[id]
  if (!isTouch() && (s?.tmux || s?.direct)) focusTerminal()
}
const onMove = (e: MouseEvent) => { const h = at(e); hoverId.value = h?.id ?? null; canvas.value!.style.cursor = h ? 'pointer' : 'default' }

// Drag a character onto another room to move that one session there (mouse and pen; on touch it would fight scrolling).
let press: { id: string; x: number; y: number } | null = null
let dropped = false
const roomUnder = (x: number, y: number) => document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-world]')?.dataset.world ?? null
function onDown(e: PointerEvent) {
  if (e.pointerType === 'touch' || e.button !== 0) return
  const h = at(e)
  if (!h || !state.sessions[h.id]) return // ghosts are not ours to move
  press = { id: h.id, x: e.clientX, y: e.clientY }
  canvas.value!.setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!press) return onMove(e)
  if (!ui.drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return // a click, not a drag yet
  ui.drag = { id: press.id, x: e.clientX, y: e.clientY, over: roomUnder(e.clientX, e.clientY) }
  canvas.value!.style.cursor = 'grabbing'
}
async function onUp() {
  const d = ui.drag
  press = null; ui.drag = null
  if (!d) return
  dropped = true // the click that ends a drag must not also open the session
  const s = state.sessions[d.id], to = dropTarget(s, d.over, state.worlds)
  if (!s || !to) return
  const r = await moveSession(s.id, to.id)
  showToast(r.ok ? `This ${s.repoName} session is now in ${to.name}.` : r.error)
}
const onCancel = () => { press = null; ui.drag = null }
const onClick = (e: MouseEvent) => { if (dropped) { dropped = false; return } const h = at(e); if (h) open(h.id) }
</script>

<template>
  <article class="room" :class="{ drop: ui.drag && ui.drag.over === group.world.id && dropTarget(state.sessions[ui.drag.id], ui.drag.over, state.worlds) }" :data-world="canCreate ? group.world.id : undefined" :style="{ '--tint': group.world.color }">
    <header>
      <h2>{{ group.world.name }}</h2>
      <span class="meta">{{ needN }} need you · {{ working }} working · {{ idle }} idle</span>
      <span v-if="conflictN" class="warn" :title="'Sessions in this room may be working on the same thing'">⚠ {{ conflictN }}</span>
      <button v-if="canCreate" class="room-btn" @click="$emit('new-task', group.world.id)">+ New session</button>
    </header>
    <div ref="wrap" class="canvas-wrap"><canvas ref="canvas" :aria-label="`${group.world.name} room`" @click="onClick" @pointerdown="onDown" @pointermove="onPointerMove" @pointerup="onUp" @pointercancel="onCancel" @mouseleave="hoverId = null" /></div>
    <div class="chips">
      <p v-if="!group.sessions.length" class="meta">No sessions yet.</p>
      <button v-for="s in real" :key="s.id" class="chip" :aria-pressed="state.selectedId === s.id" @click="open(s.id)">
        <span class="k">{{ numbers[s.id] ?? '' }}</span><span :class="['dot', s.state]" />{{ s.repoName }} <span class="st">{{ stateLabel(s, state.now) }}</span><span v-if="s.lastPrompt ?? s.task" class="st chip-task" :title="s.lastPrompt ?? s.task ?? undefined">{{ s.lastPrompt ?? s.task }}</span>
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
