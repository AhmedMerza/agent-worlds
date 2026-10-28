<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Room from './components/Room.vue'
import WorldConnections from './components/WorldConnections.vue'
import Inbox from './components/Inbox.vue'
import ChatList from './components/ChatList.vue'
import ChatView from './components/ChatView.vue'
import Detail from './components/Detail.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import HelpOverlay from './components/HelpOverlay.vue'
import NewTaskDialog from './components/NewTaskDialog.vue'
import WorldsPanel from './components/WorldsPanel.vue'
import PhoneDialog from './components/PhoneDialog.vue'
import PutInWorldDialog from './components/PutInWorldDialog.vue'
import MoveSessionDialog from './components/MoveSessionDialog.vue'
import RecentDialog from './components/RecentDialog.vue'
import { prefs, toggleMute, toggleNotifications, notifySupported } from './notify'
import { state, groups, worldOf, screenSessions, needsYou, sessionList, connect, startClock, select, selectNext, selected, showToast, termFocusTick, chatTick, clampSplit, requestCatchup, ui, updateNow, focusTerminal, resumeAll } from './store'
import { routeKey, isTypingTarget, isControlTarget, defaultWorld, needSplit } from './logic'

const help = ref(false)
const worldsPanel = ref<InstanceType<typeof WorldsPanel> | null>(null)
const newTaskWorld = ref<string | null>(null)
const newTaskRun = ref(false)
/** Opened from a room's own button: its world is the answer, not a guess. */
const newTaskFixed = ref(false)
type Tab = 'chats' | 'rooms' | 'term'
const tab = ref<Tab>('chats')
const mq = matchMedia('(max-width: 699px)')
const phone = ref(mq.matches)
const onMq = () => { phone.value = mq.matches }
const showTab = (t: Tab) => !phone.value || tab.value === t
watch(termFocusTick, () => { if (phone.value) tab.value = 'term' })
// Full height layout (wide windows): the world beside the terminal or chat, split where you drag the divider; Needs you and the details float.
const wq = matchMedia('(min-width: 1000px)')
const wide = ref(wq.matches)
const onWq = () => { wide.value = wq.matches }
const fullLayout = computed(() => ui.layout === 'full' && wide.value && !phone.value)
watch(fullLayout, (v) => { if (!v) ui.needsOpen = false })
// A press outside the floating Needs you panel (and its button) closes it.
const onOutside = (e: PointerEvent) => { if (ui.needsOpen && !(e.target as HTMLElement).closest('#needs-panel, .needs-btn')) ui.needsOpen = false }
const sideBySide = computed(() => fullLayout.value && ui.left === 'world')
const mainCol = ref<HTMLElement | null>(null)
function onSplitDown(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (m: PointerEvent) => { const b = mainCol.value!.getBoundingClientRect(); ui.split = clampSplit(((m.clientX - b.left) / b.width) * 100) }
  const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up) }
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up)
}
function onSplitKey(e: KeyboardEvent) {
  const step = e.key === 'ArrowLeft' ? -2 : e.key === 'ArrowRight' ? 2 : e.key === 'Home' ? -100 : e.key === 'End' ? 100 : 0
  if (!step) return
  e.preventDefault(); e.stopPropagation(); ui.split = clampSplit(ui.split + step)
}
const tabs = computed<[Tab, string][]>(() => [['chats', 'Chats'], ['rooms', 'Rooms'], ['term', 'Terminal']])
// On a phone a chat opens over the list, like a messaging app; it gets a history entry so Back closes it, not the app.
const chatOpen = ref(false)
watch(chatTick, async () => {
  // One column (tablet, narrow window): the chat sits below the list, so bring it into view.
  if (!phone.value) { await nextTick(); document.querySelector('.chat')?.scrollIntoView({ block: 'nearest' }); return }
  tab.value = 'chats'
  if (!chatOpen.value) { chatOpen.value = true; history.pushState({ awChat: true }, '') }
})
function closeChat() { if (history.state?.awChat) history.back(); else chatOpen.value = false }
const onPop = () => { chatOpen.value = false }
watch(tab, (t) => { if (t !== 'chats' && chatOpen.value) closeChat() })
// Phone: the Chats tab is the list or one chat. Wide: World or Chats on the left, a chat or the terminal beside it.
const listShown = computed(() => (phone.value ? tab.value === 'chats' && !chatOpen.value : ui.left === 'chats'))
const chatShown = computed(() => (phone.value ? tab.value === 'chats' && chatOpen.value : ui.pane === 'chat'))
/** A chat opened from a person's card slides in over the page instead of taking the pane. */
const chatDrawer = computed(() => ui.chatDrawer && !!selected.value && !selected.value.ghost)
// Selecting a plain-terminal session (no chat) closes the drawer, so it does not pop back for the next one.
watch(selected, (s) => { if (!s || s.ghost) ui.chatDrawer = false })
const termShown = computed(() => (phone.value ? tab.value === 'term' : ui.pane === 'term'))

function openNewTask(worldId?: string, run = false) {
  newTaskRun.value = run
  newTaskFixed.value = !!worldId
  const c = defaultWorld(state.worlds, { explicit: worldId, selectedWorldId: selected.value ? worldOf(selected.value)?.id : undefined, filter: state.filter })
  if (c.kind === 'world') newTaskWorld.value = c.id
  else if (c.kind === 'pick') newTaskWorld.value = ''
  else ui.worldsOpen = true // no worlds yet: creating one is the next step
}
const menuOpen = ref(false)
const updating = ref(false)
const recovering = ref(false)
const updateError = ref('')
/** The session the update refusal names: only permission and question cards hold the server's pending requests. */
const unanswered = computed(() => needsYou.value.find((s) => s.card?.kind === 'permission' || s.card?.kind === 'question'))
async function onUpdate(force = false) {
  updating.value = true; updateError.value = ''
  const err = await updateNow(force)
  if (err) { updateError.value = err; updating.value = false }
}
async function onRecover() {
  recovering.value = true
  const r = await resumeAll()
  recovering.value = false
  if (r) showToast(r.failed.length ? `Restoring ${r.started.length}; ${r.failed.length} could not be resumed.` : `Restoring ${r.started.length} saved conversation${r.started.length === 1 ? '' : 's'}…`)
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
/** The same object until the numbered sessions change, so rooms do not redraw for it. */
const numbers = computed<Record<string, number>>((prev) => {
  const ids = screenSessions.value.slice(0, 9).map((s) => s.id)
  return prev && ids.length === Object.keys(prev).length && ids.every((id, i) => prev[id] === i + 1) ? prev : Object.fromEntries(ids.map((id, i) => [id, i + 1]))
})
const count = (st: string) => sessionList.value.filter((s) => s.state === st).length

const dialogOpen = () => help.value || newTaskWorld.value !== null || ui.recentOpen || ui.worldsOpen || ui.phoneOpen || ui.putSession !== null || ui.moveSession !== null
function onKey(e: KeyboardEvent) {
  const a = routeKey({
    key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey,
    typing: isTypingTarget(e.target), onControl: isControlTarget(e.target), overlayOpen: dialogOpen() || chatDrawer.value || ui.needsOpen,
  })
  if (!a) return
  e.preventDefault()
  if (a.kind === 'next') selectNext()
  else if (a.kind === 'jump') { const s = screenSessions.value[a.index]; if (s) select(s.id) }
  else if (a.kind === 'help') help.value = !help.value
  else if (a.kind === 'new-task') openNewTask()
  else if (a.kind === 'catchup') { if (selected.value && !selected.value.catchupRunning) requestCatchup(selected.value.id) }
  else if (a.kind === 'worlds') ui.worldsOpen = true
  else if (a.kind === 'recent') { ui.recentRepo = null; ui.recentOpen = true }
  else if (a.kind === 'terminal') focusTerminal()
  else if (a.kind === 'leave-terminal') (document.activeElement as HTMLElement | null)?.blur()
  else if (a.kind === 'mute') onMute()
  else if (ui.worldsOpen && worldsPanel.value?.escape()) return
  else if (chatDrawer.value && !dialogOpen()) ui.chatDrawer = false
  else if (ui.needsOpen && !dialogOpen()) ui.needsOpen = false
  else { menuOpen.value = false; help.value = false; newTaskWorld.value = null; ui.worldsOpen = false; ui.recentOpen = false; ui.phoneOpen = false; ui.putSession = null; ui.moveSession = null }
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

onMounted(() => { connect(); startClock(); window.addEventListener('keydown', onKey); window.addEventListener('popstate', onPop); mq.addEventListener('change', onMq); wq.addEventListener('change', onWq); document.addEventListener('pointerdown', onOutside) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); window.removeEventListener('popstate', onPop); mq.removeEventListener('change', onMq); wq.removeEventListener('change', onWq); document.removeEventListener('pointerdown', onOutside) })
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
        <button class="hdr-btn" title="One task through plan, review, build and review, each step on its own agent" @click="openNewTask(undefined, true)">New run</button>
        <button class="hdr-btn" @click="ui.worldsOpen = true"><kbd>W</kbd> Manage worlds</button>
        <label class="world-design">World design
          <select v-model="ui.worldDesign" class="hdr-btn" aria-label="World design">
            <option value="classic">Classic</option>
            <option value="illustrated">Illustrated</option>
          </select>
        </label>
        <label v-if="!phone" class="world-design" title="Full height: the world and the terminal or chat side by side at full height; Needs you and the details open from a button">Layout
          <select v-model="ui.layout" class="hdr-btn" aria-label="Layout">
            <option value="full">Full height</option>
            <option value="stacked">Stacked</option>
          </select>
        </label>
        <button class="hdr-btn" @click="ui.recentRepo = null; ui.recentOpen = true"><kbd>R</kbd> Recent sessions</button>
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
      <button v-if="!updating && /waiting for your answer/.test(updateError) && unanswered" class="btn" @click="select(unanswered.id)">Show it</button>
      <pre v-if="updateError" class="err">{{ updateError }}</pre>
    </div>
    <div v-else-if="!state.connected" class="banner" role="alert">Disconnected from the server. Reconnecting… what you see may be out of date.</div>
    <div v-if="state.connected && state.recoverable.length" class="banner recovery" role="status">
      <span><b>{{ state.recoverable.length }}</b> session{{ state.recoverable.length === 1 ? '' : 's' }} interrupted when this computer or Agent Worlds stopped.</span>
      <button class="btn primary" :disabled="recovering" @click="onRecover">{{ recovering ? 'Resuming…' : 'Resume all' }}</button>
      <button class="btn" @click="ui.recentRepo = null; ui.recentOpen = true">Review individually</button>
    </div>
    <p v-if="!state.loaded" class="loading">Waiting for the server…</p>
    <nav v-if="phone && state.loaded" class="tabs" aria-label="View">
      <button v-for="[t, label] in tabs" :key="t" :aria-pressed="tab === t" @click="tab = t">{{ label }}<span v-if="t === 'chats' && needsYou.length" class="count">{{ needsYou.length }}</span></button>
    </nav>
    <nav v-if="!phone && state.loaded" class="views" aria-label="Show">
      <button :aria-pressed="ui.left === 'world'" @click="ui.left = 'world'">World</button>
      <button :aria-pressed="ui.left === 'chats'" @click="ui.left = 'chats'">Chats<span v-if="needsYou.length" class="count">{{ needsYou.length }}</span></button>
      <span class="views-gap" />
      <button :aria-pressed="ui.pane === 'chat'" @click="ui.pane = 'chat'">Conversation</button>
      <button :aria-pressed="ui.pane === 'term'" @click="ui.pane = 'term'">Terminal</button>
      <button v-if="fullLayout" :class="['needs-btn', { on: needsYou.length }]" :aria-expanded="ui.needsOpen" aria-controls="needs-panel" @click="ui.needsOpen = !ui.needsOpen">Needs you<span class="count">{{ needsYou.length }}</span></button>
    </nav>
    <div v-if="state.loaded" :class="['layout', { full: fullLayout }]">
      <div ref="mainCol" :class="['main-col', { 'chats-mode': !phone && ui.left === 'chats', split: sideBySide }]" :style="sideBySide ? { '--split': `${ui.split}%` } : undefined">
        <ChatList v-if="listShown" @new-task="ui.pane = 'chat'; openNewTask()" />
        <section v-show="phone ? tab === 'rooms' : ui.left === 'world'" :class="['worlds', ui.worldDesign, { single: state.filter !== 'all' || shown.length === 1, campus: ui.worldDesign === 'illustrated' && state.filter === 'all' && shown.length > 1 }]" aria-label="Worlds">
          <div v-if="!state.worlds.length" class="empty-world">
            <h2>Create your first world</h2>
            <p class="why">A world is a named group of repos. Its sessions get their own room.</p>
            <button class="btn primary" @click="ui.worldsOpen = true">Create your first world</button>
          </div>
          <Room v-for="g in shown" :key="g.world.id" :group="g" :numbers="numbers" @new-task="openNewTask" />
          <WorldConnections v-if="ui.worldDesign === 'illustrated' && state.filter === 'all' && shown.length > 1 && shown.length <= 6" :worlds="shown.map(g => g.world.id)" />
        </section>
        <div v-if="sideBySide" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize the world and the terminal" tabindex="0" :aria-valuenow="ui.split" aria-valuemin="25" aria-valuemax="75" title="Drag to resize" @pointerdown="onSplitDown" @keydown="onSplitKey" @dblclick="ui.split = 45" />
        <ChatView v-if="chatShown && !chatDrawer" :back="phone" @back="closeChat" />
        <TerminalPanel v-show="termShown" />
      </div>
      <aside id="needs-panel" :class="{ floating: fullLayout, open: ui.needsOpen }" :aria-label="fullLayout ? 'Needs you and details' : undefined">
        <Inbox v-show="!phone && (fullLayout || ui.left !== 'chats')" />
        <Detail v-show="showTab('term')" />
      </aside>
    </div>
    <HelpOverlay v-if="help" @close="help = false" />
    <WorldsPanel v-if="ui.worldsOpen" ref="worldsPanel" @close="ui.worldsOpen = false" />
    <PhoneDialog v-if="ui.phoneOpen" @close="ui.phoneOpen = false" />
    <MoveSessionDialog v-if="ui.moveSession" :session-id="ui.moveSession" @close="ui.moveSession = null" />
    <PutInWorldDialog v-if="ui.putSession" :session-id="ui.putSession" @close="ui.putSession = null" @open-worlds="ui.worldsOpen = true" />
    <div v-if="ui.drag" class="drag-tag" :style="{ left: `${ui.drag.x}px`, top: `${ui.drag.y}px` }" aria-hidden="true">
      {{ state.sessions[ui.drag.id]?.repoName }}<template v-if="ui.drag.over && ui.drag.over !== state.sessions[ui.drag.id]?.worldId"> → {{ state.worlds.find((w) => w.id === ui.drag!.over)?.name }}</template>
    </div>
    <Transition name="hq-drawer">
      <aside v-if="chatDrawer" class="hq-drawer" aria-label="Conversation">
        <button class="hq-x hq-drawer-x" aria-label="Close the conversation" @click="ui.chatDrawer = false">×</button>
        <ChatView />
      </aside>
    </Transition>
    <RecentDialog v-if="ui.recentOpen" @close="ui.recentOpen = false" />
    <NewTaskDialog v-if="newTaskWorld !== null" :world-id="newTaskWorld" :run="newTaskRun" :fixed-world="newTaskFixed" @close="newTaskWorld = null" />
    <div :class="['toast', { on: toastOn }]" role="status">{{ state.toast?.text }}</div>
  </div>
</template>
