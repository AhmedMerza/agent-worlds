<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Room from './components/Room.vue'
import Inbox from './components/Inbox.vue'
import Detail from './components/Detail.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import HelpOverlay from './components/HelpOverlay.vue'
import NewTaskDialog from './components/NewTaskDialog.vue'
import WorldsPanel from './components/WorldsPanel.vue'
import PutInWorldDialog from './components/PutInWorldDialog.vue'
import { prefs, toggleMute, toggleNotifications, notifySupported } from './notify'
import { state, groups, screenSessions, needsYou, sessionList, connect, startClock, select, selectNext, selected, showToast, termFocusTick, requestCatchup, ui } from './store'
import { routeKey, isTypingTarget, isControlTarget } from './logic'

const help = ref(false)
const worldsPanel = ref<InstanceType<typeof WorldsPanel> | null>(null)
const newTaskWorld = ref<string | null>(null)
type Tab = 'inbox' | 'rooms' | 'term'
const tab = ref<Tab>('inbox')
const mq = matchMedia('(max-width: 699px)')
const phone = ref(mq.matches)
const onMq = () => { phone.value = mq.matches }
const showTab = (t: Tab) => !phone.value || tab.value === t
watch(termFocusTick, () => { if (phone.value) tab.value = 'term' })
const tabs = computed<[Tab, string][]>(() => [['inbox', 'Inbox'], ['rooms', 'Rooms'], ['term', 'Terminal']])

function openNewTask(worldId?: string) {
  const g = groups.value.find((x) => x.sessions.includes(selected.value!))
  const id = worldId ?? g?.world.id
  const w = state.worlds.find((x) => x.id === id)
  if (!w) { showToast('Select a session in a world first. Unsorted sessions have no world to start a task in.'); return }
  newTaskWorld.value = w.id
}
async function onNotify() {
  const r = await toggleNotifications()
  if (r === 'denied') showToast('Notifications are blocked. Allow them in the browser site settings.')
}
const shown = computed(() => groups.value.filter((g) => state.filter === 'all' || g.world.id === state.filter))
const numbers = computed(() => Object.fromEntries(screenSessions.value.slice(0, 9).map((s, i) => [s.id, i + 1])))
const count = (st: string) => sessionList.value.filter((s) => s.state === st).length

function onKey(e: KeyboardEvent) {
  const a = routeKey({
    key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey,
    typing: isTypingTarget(e.target), onControl: isControlTarget(e.target), overlayOpen: help.value || newTaskWorld.value !== null || ui.worldsOpen || ui.putSession !== null,
  })
  if (!a) return
  e.preventDefault()
  if (a.kind === 'next') selectNext()
  else if (a.kind === 'jump') { const s = screenSessions.value[a.index]; if (s) select(s.id) }
  else if (a.kind === 'help') help.value = !help.value
  else if (a.kind === 'new-task') openNewTask()
  else if (a.kind === 'catchup') { if (selected.value && !selected.value.catchupRunning) requestCatchup(selected.value.id) }
  else if (a.kind === 'worlds') ui.worldsOpen = true
  else if (a.kind === 'mute') { toggleMute(); showToast(prefs.muted ? 'Sounds muted.' : 'Sounds on.') }
  else if (ui.worldsOpen && worldsPanel.value?.escape()) return
  else { help.value = false; newTaskWorld.value = null; ui.worldsOpen = false; ui.putSession = null }
}

let toastTimer: ReturnType<typeof setTimeout> | undefined
const toastOn = ref(false)
watch(() => state.toast?.n, () => {
  toastOn.value = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastOn.value = false }, 2800)
})
// If the filtered world disappears, show everything again.
watch(groups, (g) => { if (state.filter !== 'all' && !g.some((x) => x.world.id === state.filter)) state.filter = 'all' })

onMounted(() => { connect(); startClock(); window.addEventListener('keydown', onKey); mq.addEventListener('change', onMq) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); mq.removeEventListener('change', onMq) })
</script>

<template>
  <div class="wrap">
    <header class="top">
      <h1 class="brand"><i aria-hidden="true" />Agent Worlds</h1>
      <div class="stats">
        <span class="stat"><b>{{ sessionList.length }}</b> sessions</span>
        <span class="stat"><span class="dot working" /><b>{{ count('working') }}</b> working</span>
        <span class="stat"><span class="dot waiting" /><b>{{ needsYou.length }}</b> need you</span>
        <span class="stat"><span class="dot" /><b>{{ count('idle') }}</b> idle</span>
      </div>
      <nav class="filters" aria-label="Show world">
        <button :aria-pressed="state.filter === 'all'" @click="state.filter = 'all'">All worlds</button>
        <button v-for="g in groups" :key="g.world.id" :aria-pressed="state.filter === g.world.id" @click="state.filter = g.world.id">{{ g.world.name }}</button>
      </nav>
      <button class="hdr-btn" @click="ui.worldsOpen = true"><kbd>W</kbd> Worlds</button>
      <button class="hdr-btn" :aria-pressed="prefs.muted" :title="'Sounds for new requests (M)'" @click="toggleMute">{{ prefs.muted ? 'Sound off' : 'Sound on' }}</button>
      <button v-if="notifySupported" class="hdr-btn" :aria-pressed="prefs.notify" @click="onNotify">{{ prefs.notify ? 'Notifications on' : 'Enable notifications' }}</button>
      <button class="hdr-btn" aria-label="Keyboard shortcuts" @click="help = true"><kbd>?</kbd> Shortcuts</button>
    </header>
    <div v-if="!state.connected" class="banner" role="alert">Disconnected from the server. Reconnecting… what you see may be out of date.</div>
    <p v-if="!state.loaded" class="loading">Waiting for the server…</p>
    <nav v-if="phone && state.loaded" class="tabs" aria-label="View">
      <button v-for="[t, label] in tabs" :key="t" :aria-pressed="tab === t" @click="tab = t">{{ label }}<span v-if="t === 'inbox' && needsYou.length" class="count">{{ needsYou.length }}</span></button>
    </nav>
    <div v-if="state.loaded" class="layout">
      <div class="main-col">
        <section v-show="showTab('rooms')" :class="['worlds', { single: state.filter !== 'all' || shown.length === 1 }]" aria-label="Worlds">
          <div v-if="!state.worlds.length" class="empty-world">
            <h2>Create your first world</h2>
            <p class="why">A world is a named group of repos. Its sessions get their own room.</p>
            <button class="btn primary" @click="ui.worldsOpen = true">Create your first world</button>
          </div>
          <Room v-for="g in shown" :key="g.world.id" :group="g" :numbers="numbers" @new-task="openNewTask" />
        </section>
        <TerminalPanel v-show="showTab('term')" />
      </div>
      <aside>
        <Inbox v-show="showTab('inbox')" />
        <Detail v-show="showTab('term')" />
      </aside>
    </div>
    <HelpOverlay v-if="help" @close="help = false" />
    <WorldsPanel v-if="ui.worldsOpen" ref="worldsPanel" @close="ui.worldsOpen = false" />
    <PutInWorldDialog v-if="ui.putSession" :session-id="ui.putSession" @close="ui.putSession = null" @open-worlds="ui.worldsOpen = true" />
    <NewTaskDialog v-if="newTaskWorld" :world-id="newTaskWorld" @close="newTaskWorld = null" />
    <div :class="['toast', { on: toastOn }]" role="status">{{ state.toast?.text }}</div>
  </div>
</template>
