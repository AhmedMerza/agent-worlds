<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Room from './components/Room.vue'
import Inbox from './components/Inbox.vue'
import Detail from './components/Detail.vue'
import TerminalPanel from './components/TerminalPanel.vue'
import HelpOverlay from './components/HelpOverlay.vue'
import { state, groups, screenSessions, needsYou, sessionList, connect, startClock, select, selectNext } from './store'
import { routeKey, isTypingTarget, isControlTarget } from './logic'

const help = ref(false)
const shown = computed(() => groups.value.filter((g) => state.filter === 'all' || g.world.id === state.filter))
const numbers = computed(() => Object.fromEntries(screenSessions.value.slice(0, 9).map((s, i) => [s.id, i + 1])))
const count = (st: string) => sessionList.value.filter((s) => s.state === st).length

function onKey(e: KeyboardEvent) {
  const a = routeKey({
    key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey,
    typing: isTypingTarget(e.target), onControl: isControlTarget(e.target), overlayOpen: help.value,
  })
  if (!a) return
  e.preventDefault()
  if (a.kind === 'next') selectNext()
  else if (a.kind === 'jump') { const s = screenSessions.value[a.index]; if (s) select(s.id) }
  else if (a.kind === 'help') help.value = !help.value
  else help.value = false
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

onMounted(() => { connect(); startClock(); window.addEventListener('keydown', onKey) })
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
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
      <button class="hdr-btn" aria-label="Keyboard shortcuts" @click="help = true"><kbd>?</kbd> Shortcuts</button>
    </header>
    <div v-if="!state.connected" class="banner" role="alert">Disconnected from the server. Reconnecting… what you see may be out of date.</div>
    <p v-if="!state.loaded" class="loading">Waiting for the server…</p>
    <div v-else class="layout">
      <div class="main-col">
        <section :class="['worlds', { single: state.filter !== 'all' || shown.length === 1 }]" aria-label="Worlds">
          <p v-if="!groups.length" class="empty">No worlds yet. Add one to the config file.</p>
          <Room v-for="g in shown" :key="g.world.id" :group="g" :numbers="numbers" />
        </section>
        <TerminalPanel />
      </div>
      <aside>
        <Inbox />
        <Detail />
      </aside>
    </div>
    <HelpOverlay v-if="help" @close="help = false" />
    <div :class="['toast', { on: toastOn }]" role="status">{{ state.toast?.text }}</div>
  </div>
</template>
