<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Room from './components/Room.vue'
import Inbox from './components/Inbox.vue'
import Detail from './components/Detail.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import HelpOverlay from './components/HelpOverlay.vue'
import NewTaskDialog from './components/NewTaskDialog.vue'
import WorldsPanel from './components/WorldsPanel.vue'
import PhoneDialog from './components/PhoneDialog.vue'
import PutInWorldDialog from './components/PutInWorldDialog.vue'
import RecentDialog from './components/RecentDialog.vue'
import { prefs, toggleMute, toggleNotifications, notifySupported } from './notify'
import { state, groups, screenSessions, needsYou, sessionList, connect, startClock, select, selectNext, selected, showToast, termFocusTick, requestCatchup, ui, updateNow, focusTerminal } from './store'
import { routeKey, isTypingTarget, isControlTarget, defaultWorld, needSplit } from './logic'

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
  const g = selected.value ? groups.value.find((x) => x.sessions.includes(selected.value!)) : undefined
  const c = defaultWorld(state.worlds, { explicit: worldId, selectedWorldId: g?.world.id, filter: state.filter })
  if (c.kind === 'world') newTaskWorld.value = c.id
  else if (c.kind === 'pick') newTaskWorld.value = ''
  else ui.worldsOpen = true // no worlds yet: creating one is the next step
}
const menuOpen = ref(false)
const updating = ref(false)
const updateError = ref('')
async function onUpdate(force = false) {
  updating.value = true; updateError.value = ''
  const err = await updateNow(force)
  if (err) { updateError.value = err; updating.value = false }
}
watch(phone, () => { menuOpen.value = false })
async function onNotify() {
  const r = await toggleNotifications()
  if (r === 'denied') showToast('Notifications are blocked. Allow them in the browser site settings.')
  else showToast(r === 'on' ? 'Notifications on. You will get one when a session needs you and this tab is hidden.' : 'Notifications off.')
}
function onCtrlClick(e: MouseEvent) { if (phone.value && (e.target as HTMLElement).closest('button')) menuOpen.value = false }
function onMute() { toggleMute(); showToast(prefs.muted ? 'Sounds muted.' : 'Sounds on.') }
const split = computed(() => needSplit(needsYou.value))
const shown = computed(() => groups.value.filter((g) => state.filter === 'all' || g.world.id === state.filter))
const numbers = computed(() => Object.fromEntries(screenSessions.value.slice(0, 9).map((s, i) => [s.id, i + 1])))
const count = (st: string) => sessionList.value.filter((s) => s.state === st).length

function onKey(e: KeyboardEvent) {
  const a = routeKey({
    key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey,
    typing: isTypingTarget(e.target), onControl: isControlTarget(e.target), overlayOpen: help.value || newTaskWorld.value !== null || ui.recentOpen || ui.worldsOpen || ui.phoneOpen || ui.putSession !== null,
  })
  if (!a) return
  e.preventDefault()
  if (a.kind === 'next') selectNext()
  else if (a.kind === 'jump') { const s = screenSessions.value[a.index]; if (s) select(s.id) }
  else if (a.kind === 'help') help.value = !help.value
  else if (a.kind === 'new-task') openNewTask()
  else if (a.kind === 'catchup') { if (selected.value && !selected.value.catchupRunning) requestCatchup(selected.value.id) }
  else if (a.kind === 'worlds') ui.worldsOpen = true
  else if (a.kind === 'recent') ui.recentOpen = true
  else if (a.kind === 'terminal') focusTerminal()
  else if (a.kind === 'leave-terminal') (document.activeElement as HTMLElement | null)?.blur()
  else if (a.kind === 'mute') onMute()
  else if (ui.worldsOpen && worldsPanel.value?.escape()) return
  else { menuOpen.value = false; help.value = false; newTaskWorld.value = null; ui.worldsOpen = false; ui.recentOpen = false; ui.phoneOpen = false; ui.putSession = null }
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
      <div class="stats" aria-label="Summary">
        <template v-if="!phone">
          <span class="stat opt"><b>{{ sessionList.length }}</b> sessions</span>
          <span class="stat"><span class="dot working" /><b>{{ count('working') }}</b> working</span>
        </template>
        <span class="stat need"><span class="dot waiting" /><b>{{ split.waiting }}</b> waiting on you · <b>{{ split.review }}</b> to review</span>
        <span v-if="!phone" class="stat opt"><span class="dot" /><b>{{ count('idle') }}</b> idle</span>
      </div>
      <button v-if="phone" class="hdr-btn more" aria-label="Menu" aria-haspopup="true" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">⋯</button>
      <div v-show="!phone || menuOpen" :class="['ctrl', { menu: phone }]" @click="onCtrlClick">
        <nav class="filters" aria-label="Show world">
          <button :aria-pressed="state.filter === 'all'" @click="state.filter = 'all'">All worlds</button>
          <button v-for="g in groups" :key="g.world.id" :aria-pressed="state.filter === g.world.id" @click="state.filter = g.world.id">{{ g.world.name }}</button>
        </nav>
        <button class="hdr-btn" @click="ui.worldsOpen = true"><kbd>W</kbd> Manage worlds</button>
        <button class="hdr-btn" @click="ui.recentOpen = true"><kbd>R</kbd> Recent sessions</button>
        <button class="hdr-btn toggle" :aria-pressed="!prefs.muted" title="Sound for new requests (M)" @click="onMute"><i aria-hidden="true" />Sound {{ prefs.muted ? 'off' : 'on' }}</button>
        <button v-if="notifySupported" class="hdr-btn toggle" :aria-pressed="prefs.notify" @click="onNotify"><i aria-hidden="true" />Notifications {{ prefs.notify ? 'on' : 'off' }}</button>
        <button class="hdr-btn" @click="ui.phoneOpen = true">Connect a phone</button>
        <button class="hdr-btn" aria-label="Keyboard shortcuts" @click="help = true"><kbd>?</kbd> Shortcuts</button>
      </div>
    </header>
    <div v-if="state.update || updating" class="banner update" role="status">
      <span>{{ updating ? 'Updating… the page reloads when the new version is up. Your sessions keep running.' : 'A new version of Agent Worlds is ready.' }}</span>
      <button v-if="!updating" class="btn primary" @click="onUpdate()">Update now</button>
      <button v-if="!updating && /will end/.test(updateError)" class="btn" @click="onUpdate(true)">Update anyway</button>
      <pre v-if="updateError" class="err">{{ updateError }}</pre>
    </div>
    <div v-else-if="!state.connected" class="banner" role="alert">Disconnected from the server. Reconnecting… what you see may be out of date.</div>
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
    <PhoneDialog v-if="ui.phoneOpen" @close="ui.phoneOpen = false" />
    <PutInWorldDialog v-if="ui.putSession" :session-id="ui.putSession" @close="ui.putSession = null" @open-worlds="ui.worldsOpen = true" />
    <RecentDialog v-if="ui.recentOpen" @close="ui.recentOpen = false" />
    <NewTaskDialog v-if="newTaskWorld !== null" :world-id="newTaskWorld" @close="newTaskWorld = null" />
    <div :class="['toast', { on: toastOn }]" role="status">{{ state.toast?.text }}</div>
  </div>
</template>
