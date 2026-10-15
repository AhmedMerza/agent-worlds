<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { continueIn, fetchAgents, showToast, type AgentInfo } from '../store'

/**
 * "Continue in ▾": hands the session's folder to another installed agent (the handoff is written
 * server-side; this session stays open). A real menu: arrows move, Escape closes and refocuses the
 * trigger, a click anywhere outside closes it.
 */
const props = defineProps<{ sessionId: string; current: string; repoName: string; primary?: boolean }>()
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const open = ref(false)
const busy = ref(false)
/** Which trigger edge the menu aligns to; chosen on open so it never clips its scrolling column. */
const align = ref<'right' | 'left'>('right')
const placed = ref(false)
const agents = ref<AgentInfo[] | null>(null) // null = still loading
const failed = ref(false)
onMounted(async () => {
  const r = await fetchAgents()
  if (r.ok) agents.value = r.data.agents.filter((a) => a.installed && a.id !== props.current)
  else failed.value = true
})

/** The box the menu must stay inside: the nearest ancestor that clips, else the viewport. */
function clipBounds(el: HTMLElement): { left: number; right: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).overflowX !== 'visible') {
      const r = p.getBoundingClientRect()
      return { left: r.left, right: r.right }
    }
  }
  return { left: 0, right: window.innerWidth }
}
async function place() {
  align.value = 'right'
  await nextTick()
  const m = menu.value
  if (!m) return
  const b = clipBounds(m)
  if (m.getBoundingClientRect().left < b.left + 4) {
    align.value = 'left'
    await nextTick()
    if (m.getBoundingClientRect().right > b.right - 4) align.value = 'right' // clips either way: right is the default
  }
  placed.value = true
}

function onDocClick(e: MouseEvent) {
  if (!root.value?.contains(e.target as Node)) close()
}
async function openMenu() {
  open.value = true
  placed.value = false
  document.addEventListener('click', onDocClick, true)
  await place()
  items()[0]?.focus()
}
function close(refocus = false) {
  if (!open.value) return
  open.value = false
  document.removeEventListener('click', onDocClick, true)
  if (refocus) trigger.value?.focus()
}
const toggle = () => (open.value ? close(true) : openMenu())
const items = () => [...(menu.value?.querySelectorAll<HTMLButtonElement>('button.menu-item') ?? [])]
function onMenuKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.stopPropagation(); close(true); return }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const list = items().filter((b) => !b.disabled)
  const at = list.indexOf(document.activeElement as HTMLButtonElement)
  const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length
  list[next]?.focus()
}
onUnmounted(() => document.removeEventListener('click', onDocClick, true))

async function pick(a: AgentInfo) {
  if (busy.value) return
  busy.value = true
  const err = await continueIn(props.sessionId, a.id)
  busy.value = false
  if (err) { showToast(err); close(true) }
  else { showToast(`Started ${a.name} in ${props.repoName} — original session left open`); close() }
}
</script>

<template>
  <span ref="root" class="continue-in">
    <button ref="trigger" :class="['btn', { primary }]" :disabled="busy || (agents !== null && !agents.length && !failed)"
      :title="agents !== null && !agents.length && !failed ? 'No other agent is installed' : undefined"
      aria-haspopup="menu" :aria-expanded="open" @click.stop="toggle">{{ busy ? 'Starting…' : 'Continue in ▾' }}</button>
    <div v-if="open" ref="menu" class="menu" :class="align" :style="{ visibility: placed ? 'visible' : 'hidden' }" role="menu" aria-label="Continue in another agent" @keydown="onMenuKeydown">
      <p class="why note">Starts it in the same folder with a handoff of this session; this session stays open.</p>
      <p v-if="failed" class="why note">Couldn't load the agent list.</p>
      <p v-else-if="agents === null" class="why note">Loading…</p>
      <button v-for="a in agents ?? []" :key="a.id" class="btn menu-item" role="menuitem" :disabled="busy" @click="pick(a)">{{ a.name }}</button>
    </div>
  </span>
</template>

<style scoped>
.continue-in { position: relative; display: inline-block }
.menu { position: absolute; z-index: 30; bottom: calc(100% + 4px); display: flex; flex-direction: column; gap: 4px; min-width: 200px; max-width: 260px; padding: 6px; background: var(--panel-2); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 6px 24px #0008 }
.menu.right { right: 0 }
.menu.left { left: 0 }
.menu .btn { text-align: left }
.note { margin: 2px 6px 4px }
</style>
