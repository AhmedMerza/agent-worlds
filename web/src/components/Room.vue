<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { RoomGroup } from '../types'
import { drawRoom, hitTest, W, type Hit } from '../canvas'
import { illustrationReady, officePage, OFFICE_PAGE_SIZE } from '../illustratedRoom'
import { roomHeight, type Walker } from '../zones'
import { agentLabel, nameOf, roleOf, dropTarget, stateLabel, NEEDS_YOU, roomConflicts, UNSORTED, splitGhosts, drawnSessions, ghostChipText, isTouch } from '../logic'
import { state, select, openSession, ui, moveSession, showToast, steps } from '../store'
import { usageText } from '../hq'
import AgentCard from './AgentCard.vue'

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
const sessionsOpen = ref(false)
const query = ref('')
const page = ref(0)
/** The scene draws every real session but only a few ghosts; the rest wait in the chip. */
const drawn = computed(() => drawnSessions(props.group.sessions))
const pages = computed(() => Math.max(1, Math.ceil(drawn.value.sessions.length / OFFICE_PAGE_SIZE)))
const illustrated = computed(() => ui.worldDesign === 'illustrated')
/** A right-clicked (on touch: tapped) person gets their floating card. */
/** This room's open card: the page has one (ui.card); another room taking it closes ours. */
const cardId = computed({ get: () => (ui.card && props.group.sessions.some(s => s.id === ui.card) ? ui.card : null), set: (id: string | null) => { ui.card = id } })
const card = computed(() => (cardId.value ? props.group.sessions.find(s => s.id === cardId.value) ?? null : null))
watch(illustrated, () => closeCard())
const scene = computed<RoomGroup>(() => ({ world: props.group.world, sessions: illustrated.value ? officePage(drawn.value.sessions, page.value) : drawn.value.sessions }))
const filtered = computed(() => real.value.filter(s => `${nameOf(s)} ${s.branch ?? ''} ${s.task ?? ''} ${stateLabel(s, state.now)}`.toLowerCase().includes(query.value.trim().toLowerCase())))
/** A busy room lists its first chips; the rest (and anyone past the room's seats) behind "Show all". */
const CHIP_CAP = 24
const allChips = ref(false)
const chips = computed(() => {
  if (allChips.value || query.value) return filtered.value
  const top = filtered.value.slice(0, CHIP_CAP), sel = filtered.value.find(s => s.id === state.selectedId)
  return sel && !top.includes(sel) ? [...top, sel] : top // the session you picked stays in view
})
watch(pages, n => { page.value = Math.min(page.value, n - 1) })
watch(() => state.selectedId, id => {
  const sorted = [...drawn.value.sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
  const i = sorted.findIndex(s => s.id === id)
  if (i >= 0) page.value = Math.floor(i / OFFICE_PAGE_SIZE)
})
const count = (st: (s: string) => boolean) => real.value.filter((s) => st(s.state)).length
const needN = computed(() => count((st) => NEEDS_YOU.includes(st as never)))
const working = computed(() => count((st) => st === 'working'))
const idle = computed(() => count((st) => st === 'idle'))
const roles = computed(() => Object.fromEntries(Object.values(state.sessions).map(s => [s.id, roleOf(s, state.sessions)])))

const h = computed(() => Math.max(illustrated.value ? 480 : 0, roomHeight(scene.value.sessions)))
const walkers = new Map<string, Walker>()
const arrivals = new Set<string>()
let hits: Hit[] = []
let raf = 0
let k = 1
let hLog = 250
let lastStatic = ''
let revision = 0
const hoverId = ref<string | null>(null)
watch([scene, steps, roles, () => state.selectedId, hoverId, () => Math.floor(state.now / 60000)], () => { revision++ })
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

/** Each room redraws its whole scene, so only rooms on screen draw, at ~30fps. */
const FRAME_MS = 1000 / 30
let onScreen = true

function frame(t: number) {
  const c = canvas.value
  if (!c || !onScreen) { raf = 0; return } // off screen the loop stops; coming back on screen restarts it
  raf = requestAnimationFrame(frame)
  if (document.hidden || c.offsetParent === null) return
  if (lastT && t - lastT < FRAME_MS - 2) return
  const ctx = c.getContext('2d')
  if (!ctx) return
  // Illustrated artwork is static: repaint only for data, hover, selection, size or asset changes.
  if (reduced || (illustrated.value && illustrationReady())) {
    const key = `${revision}/${illustrationReady()}/${c.width}/${c.height}`
    if (key === lastStatic) return
    lastStatic = key
  }
  const dt = lastT ? Math.min(100, t - lastT) : 0
  lastT = t
  hits = drawRoom(ctx, { group: scene.value, worldDesign: ui.worldDesign, steps: steps.value, roles: roles.value, selectedId: state.selectedId, t, now: state.now, reduced, walkers, arrivals, k, h: Math.max(h.value, hLog), hoverId: hoverId.value, dt, moreGhosts: drawn.value.hidden })
}
let ro: ResizeObserver | null = null
let io: IntersectionObserver | null = null
onMounted(() => {
  fitCanvas()
  ro = new ResizeObserver(fitCanvas)
  if (wrap.value) ro.observe(wrap.value)
  if (typeof IntersectionObserver !== 'undefined' && wrap.value) {
    io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; lastT = 0; lastStatic = ''; if (onScreen && !raf) raf = requestAnimationFrame(frame) })
    io.observe(wrap.value)
  }
  raf = requestAnimationFrame(frame)
})
watch(h, fitCanvas, { flush: 'post' })
// Escape closes the card unless the page already used it (a dialog, or the chat drawer on top).
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && cardId.value && !ui.chatDrawer) closeCard() }
onMounted(() => window.addEventListener('keydown', onKey))
// The card's person left this room (moved or ended): the card closes instead of reopening elsewhere uncentred.
watch(() => !!ui.card && props.group.sessions.some(s => s.id === ui.card), (here, was) => { if (was && !here) ui.card = null })
onBeforeUnmount(() => { cancelAnimationFrame(raf); ro?.disconnect(); io?.disconnect(); window.removeEventListener('keydown', onKey) })

function at(e: MouseEvent): Hit | undefined {
  const b = canvas.value!.getBoundingClientRect()
  return hitTest(hits, (e.clientX - b.left) / b.width * W, (e.clientY - b.top) / b.height * hLog)
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
function showCard(id: string) {
  select(id)
  cardId.value = id
}
function closeCard() { if (cardId.value) cardId.value = null }
function open(id: string) { if (isTouch()) select(id); else openSession(id) }
const onClick = (e: MouseEvent) => {
  if (dropped) { dropped = false; return }
  const h = at(e)
  if (!h) { if (cardId.value) closeCard(); return }
  closeCard()
  if (isTouch()) showCard(h.id)
  else open(h.id)
}
/** Right-click a person for their card; elsewhere the browser's own menu. */
function onContext(e: MouseEvent) {
  const h = at(e)
  if (!h) return
  e.preventDefault()
  showCard(h.id)
}
</script>

<template>
  <article class="room" :class="{ drop: ui.drag && ui.drag.over === group.world.id && dropTarget(state.sessions[ui.drag.id], ui.drag.over, state.worlds) }" :data-world="canCreate ? group.world.id : undefined" :style="{ '--tint': group.world.color }">
    <header>
      <h2>{{ group.world.name }}</h2>
      <span v-if="group.world.leadSpawn" class="badge mgd" title="Lead sessions here may start and end their own workers (Manage worlds)">leads start workers</span>
      <span class="meta">{{ needN }} need you · {{ working }} working · {{ idle }} idle</span>
      <span v-if="conflictN" class="warn" :title="'Sessions in this room may be working on the same thing'">⚠ {{ conflictN }}</span>
      <button v-if="illustrated" class="room-btn" :aria-expanded="sessionsOpen" @click="sessionsOpen = !sessionsOpen">Sessions ({{ group.sessions.length }})</button>
      <button v-if="canCreate" class="room-btn" @click="$emit('new-task', group.world.id)">+ New session</button>
    </header>
    <div ref="wrap" class="canvas-wrap">
      <canvas ref="canvas" :aria-label="`${group.world.name} room`" title="Click a person to open them · right-click for their task and stats" @click="onClick" @contextmenu="onContext" @pointerdown="onDown" @pointermove="onPointerMove" @pointerup="onUp" @pointercancel="onCancel" @mouseleave="hoverId = null" />
      <AgentCard v-if="card" :s="card" @close="closeCard" />
    </div>
    <nav v-if="illustrated && pages > 1" class="room-pages" :aria-label="`${group.world.name} agent pages`">
      <button class="btn" :disabled="page === 0" aria-label="Previous agents" @click="page--">←</button>
      <span>Agents {{ page * OFFICE_PAGE_SIZE + 1 }}–{{ Math.min((page + 1) * OFFICE_PAGE_SIZE, drawn.sessions.length) }} of {{ drawn.sessions.length }}</span>
      <button class="btn" :disabled="page === pages - 1" aria-label="Next agents" @click="page++">→</button>
    </nav>
    <div v-if="sessionsOpen || !illustrated" :class="{ 'room-roster': illustrated }">
      <input v-if="illustrated" v-model="query" type="search" :aria-label="`Search ${group.world.name} sessions`" placeholder="Search sessions…" />
    <div class="chips">
      <p v-if="!group.sessions.length" class="meta">No sessions yet.</p>
      <p v-else-if="query && !filtered.length" class="meta">No matching sessions.</p>
      <button v-for="s in chips" :key="s.id" class="chip" :aria-pressed="state.selectedId === s.id" @click="open(s.id)">
        <span class="k">{{ numbers[s.id] ?? '' }}</span><span :class="['dot', s.state]" /><span v-if="roleOf(s, state.sessions)" class="tag">{{ roleOf(s, state.sessions) }}</span>{{ nameOf(s) }}<span v-if="agentLabel(s)" class="tag">{{ agentLabel(s) }}</span><span v-if="steps[s.id]" class="st chip-step">{{ steps[s.id] }}</span><span v-if="s.branch" class="st chip-branch">{{ s.branch }}</span> <span class="st">{{ stateLabel(s, state.now) }}</span><span v-if="s.context || s.usage" class="st" title="Context use and tokens this conversation">{{ [s.context ? `${s.context.pct}% ctx` : '', s.usage ? usageText(s.usage) : ''].filter(Boolean).join(' · ') }}</span><span v-if="s.lastPrompt ?? s.task" class="st chip-task" :title="s.lastPrompt ?? s.task ?? undefined">{{ s.lastPrompt ?? s.task }}</span>
      </button>
      <button v-if="filtered.length > CHIP_CAP && !query" class="chip chip-ghosts" :aria-expanded="allChips" @click="allChips = !allChips">{{ allChips ? 'Show fewer' : `Show all ${filtered.length}` }}</button>
      <button v-if="split.ghosts.length" class="chip chip-ghosts" :aria-expanded="ghostsOpen" @click="ghostsOpen = !ghostsOpen">
        <span class="dot ghost" />{{ ghostChipText(split.ghosts.length) }} <span class="st">{{ ghostsOpen ? 'Hide' : 'Show' }}</span>
      </button>
      <template v-if="ghostsOpen">
        <button v-for="s in split.ghosts" :key="s.id" class="chip" :aria-pressed="state.selectedId === s.id" @click="select(s.id)">
          <span class="dot ghost" />{{ s.repoName }} <span class="st chip-task" :title="s.task ?? undefined">{{ s.task ?? 'plain terminal' }}</span>
        </button>
      </template>
    </div>
    </div>
  </article>
</template>
