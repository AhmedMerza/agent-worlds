<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RoomGroup, Session } from '../types'
import { drawnSessions, isTouch, nameOf, nowText, stateLabel, NEEDS_YOU, UNSORTED } from '../logic'
import { state, select, openSession, ui } from '../store'
import AgentCard from './AgentCard.vue'
import { cameraOn, viewCentre, hqPlaces, tokenText, usageTotal, HQ_PAGE_SIZE, HQ_MAX_ZOOM, HQ_MIN_ZOOM, type Camera } from '../hq'

/** The HQ design: one world as an office you can zoom around. A person opens their card; Chat slides their conversation in from the right. */
const props = defineProps<{ group: RoomGroup }>()
defineEmits<{ 'new-task': [worldId: string] }>()

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const canCreate = computed(() => props.group.world.id !== UNSORTED.id)
const drawn = computed(() => drawnSessions(props.group.sessions).sessions)
const real = computed(() => drawn.value.filter(s => !s.ghost))
const page = ref(0)
const pages = computed(() => Math.max(1, Math.ceil(drawn.value.length / HQ_PAGE_SIZE)))
watch(pages, n => { page.value = Math.min(page.value, n - 1) })
const places = computed(() => hqPlaces(drawn.value, page.value))
const working = computed(() => real.value.filter(s => s.state === 'working').length)
const needN = computed(() => real.value.filter(s => NEEDS_YOU.includes(s.state)).length)
/** A session that started workers of its own runs the floor; Ask goes to it. */
const lead = computed(() => real.value.find(s => real.value.some(c => c.parent === s.id)) ?? null)
const greeting = computed(() => { const h = new Date(state.now).getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening' })

const openId = ref<string | null>(null)
const open = computed<Session | null>(() => drawn.value.find(s => s.id === openId.value) ?? null)
// Another view picked someone else (a chip, a number key): this card follows only while it is open.
watch(() => state.selectedId, id => { if (openId.value && id && id !== openId.value && drawn.value.some(s => s.id === id)) show(id) })

const stage = ref<HTMLElement | null>(null)
const cam = ref<Camera>({ z: 1, x: 0, y: 0 })
const size = () => ({ w: stage.value?.clientWidth ?? 1, h: stage.value?.clientHeight ?? 1 })
/** Any camera, kept inside the office. */
function setCam(z: number, x: number, y: number) {
  const { w, h } = size()
  z = Math.min(HQ_MAX_ZOOM, Math.max(HQ_MIN_ZOOM, z))
  cam.value = cameraOn(w, h, (w / 2 - x) / z, (h / 2 - y) / z, z)
}
/** Zoom by `f` keeping stage point (mx, my) where it is. */
function zoomAt(f: number, mx: number, my: number) {
  const c = cam.value, z = Math.min(HQ_MAX_ZOOM, Math.max(HQ_MIN_ZOOM, c.z * f))
  setCam(z, mx - (mx - c.x) / c.z * z, my - (my - c.y) / c.z * z)
}
const zoomBy = (f: number) => { const { w, h } = size(); zoomAt(f, w / 2, h / 2) }
const resetCam = () => { cam.value = { z: 1, x: 0, y: 0 } }

function show(id: string) {
  select(id)
  openId.value = id
  const el = stage.value?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)
  if (!el || !stage.value) return
  // Where they stand with the camera at rest: undo the current transform.
  const b = stage.value.getBoundingClientRect(), r = el.getBoundingClientRect(), c = cam.value
  const px = (r.left + r.width / 2 - b.left - c.x) / c.z, py = (r.top + r.height * .6 - b.top - c.y) / c.z
  const { w, h } = size()
  const v = viewCentre(stage.value)
  cam.value = cameraOn(w, h, px, py, 1.7, v.x, v.y)
}
/** Left click opens them where you work; on touch (no right click) it opens their card. */
function pick(id: string) { if (isTouch()) return show(id); openId.value = null; openSession(id) } // the camera stays where you put it
function close() { openId.value = null; resetCam() }

// Drag the floor to look around once zoomed in; a drag never also counts as a click.
let press: { x: number; y: number; cx: number; cy: number } | null = null
let dragged = false
function onDown(e: PointerEvent) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
  press = { x: e.clientX, y: e.clientY, cx: cam.value.x, cy: cam.value.y }; dragged = false
}
function onMove(e: PointerEvent) {
  if (!press) return
  const dx = e.clientX - press.x, dy = e.clientY - press.y
  if (!dragged && Math.hypot(dx, dy) < 6) return
  if (!dragged) stage.value?.setPointerCapture(e.pointerId)
  dragged = true
  setCam(cam.value.z, press.cx + dx, press.cy + dy)
}
function onUp() { press = null }
function onStageClick(e: MouseEvent) {
  if (dragged) { dragged = false; return }
  if (!(e.target as HTMLElement).closest('button') && openId.value) close()
}
// Ctrl/⌘ + wheel (also a trackpad pinch) zooms; a plain wheel still scrolls the page.
function onWheel(e: WheelEvent) {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  const b = stage.value!.getBoundingClientRect()
  zoomAt(Math.exp(-e.deltaY / 300), e.clientX - b.left, e.clientY - b.top)
}
// Escape closes the card unless the page already used it (a dialog, or the chat drawer on top).
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !e.defaultPrevented && openId.value && !ui.chatDrawer) close() }
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

const variant = (s: Session) => [...s.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 3
const seated = (s: Session) => s.state === 'working'
/** Crop of agents.png: top row (45% of its height) sits at desks, the bottom row stands. */
const sprite = (s: Session) => seated(s)
  ? { backgroundSize: '300% 222.2%', backgroundPosition: `${variant(s) * 50}% 0%` }
  : { backgroundSize: '300% 181.8%', backgroundPosition: `${(s.state === 'idle' || s.state === 'starting' ? 2 : variant(s) % 2) * 50}% 100%` }
/** What a working person is doing, over their head; the open card's person always says theirs. Others get a badge, not a bubble, so a busy floor stays readable. */
const bubble = (s: Session) => !s.ghost && (s.state === 'working' || s.id === openId.value) ? nowText(s.now) : null
const badge = (s: Session) => s.ghost ? null : s.state === 'waiting' ? '!' : s.state === 'done' ? '✓' : s.state === 'error' ? '×' : null
const stat = (s: Session) => [s.context ? `${s.context.pct}% ctx` : '', s.usage ? `${tokenText(usageTotal(s.usage))} tok` : ''].filter(Boolean).join(' · ')
</script>

<template>
  <article class="hq" :style="{ '--tint': group.world.color }">
    <header class="hq-bar">
      <div class="hq-hello">
        <h2>{{ greeting }} · {{ group.world.name }}</h2>
        <p><span class="dot working" />{{ real.length }} agent{{ real.length === 1 ? '' : 's' }} · {{ working }} working · {{ needN }} need{{ needN === 1 ? 's' : '' }} you<template v-if="lead"> · {{ nameOf(lead) }} is running the floor</template></p>
      </div>
      <div class="hq-actions">
        <button v-if="lead" class="hq-btn" @click="show(lead.id); ui.chatDrawer = true"><span class="dot waiting" />Ask {{ nameOf(lead) }}</button>
        <button v-if="canCreate" class="hq-btn primary" @click="$emit('new-task', group.world.id)">+ New session</button>
      </div>
    </header>
    <div ref="stage" :class="['hq-stage', { zoomed: cam.z > 1, still: reduced }]" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @click="onStageClick" @wheel="onWheel">
      <div class="hq-cam" :style="{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }">
        <div class="hq-floor">
          <img class="hq-office" src="/art/office.png" alt="" draggable="false" />
          <p v-if="!drawn.length" class="hq-empty">No one here yet.</p>
          <button v-for="p in places" :key="p.s.id" :data-id="p.s.id" :class="['hq-person', p.s.state, { seated: seated(p.s), ghost: !!p.s.ghost, on: openId === p.s.id }]" :style="{ left: `${p.x}%`, top: `${p.y}%` }" :aria-label="`${nameOf(p.s)}, ${stateLabel(p.s, state.now)}`" title="Click to open · right-click for details" @click.stop="pick(p.s.id)" @contextmenu.prevent.stop="show(p.s.id)">
            <span v-if="bubble(p.s)" class="hq-bubble">{{ bubble(p.s) }}</span>
            <span v-else-if="badge(p.s)" class="hq-badge" aria-hidden="true">{{ badge(p.s) }}</span>
            <span class="hq-sprite" :style="sprite(p.s)" />
            <span class="hq-tag"><span :class="['dot', p.s.ghost ? 'ghost' : p.s.state]" />{{ nameOf(p.s) }}<small v-if="stat(p.s)">{{ stat(p.s) }}</small></span>
          </button>
        </div>
      </div>
      <div class="hq-zoom" role="group" aria-label="Zoom">
        <button class="hq-btn" aria-label="Zoom in" :disabled="cam.z >= HQ_MAX_ZOOM" @click="zoomBy(1.4)">+</button>
        <button class="hq-btn" aria-label="Zoom out" :disabled="cam.z <= HQ_MIN_ZOOM" @click="zoomBy(1 / 1.4)">−</button>
        <button class="hq-btn" aria-label="Show the whole office" :disabled="cam.z === 1" @click="close">⤢</button>
      </div>
      <nav v-if="pages > 1" class="hq-pages" :aria-label="`${group.world.name} agent pages`">
        <button class="hq-btn" :disabled="page === 0" aria-label="Previous agents" @click="close(); page--">←</button>
        <span>{{ page * HQ_PAGE_SIZE + 1 }}–{{ Math.min((page + 1) * HQ_PAGE_SIZE, drawn.length) }} of {{ drawn.length }}</span>
        <button class="hq-btn" :disabled="page === pages - 1" aria-label="Next agents" @click="close(); page++">→</button>
      </nav>
      <AgentCard v-if="open" :s="open" @close="close" />
    </div>
  </article>
</template>
