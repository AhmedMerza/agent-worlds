<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Session } from '../types'
import { chatBadge, chatRows, chatTime, inboxOrder, nameOf, stateLabel } from '../logic'
import { state, groups, needsYou, runsNeedingYou, openChat } from '../store'
import RunCard from './RunCard.vue'

// The world filter in the header applies here too; ghosts (Claudes outside Agent Worlds) have no chat.
const shown = computed(() => groups.value.filter((g) => state.filter === 'all' || g.world.id === state.filter))
const fresh = computed(() => chatRows(shown.value.flatMap((g) => g.sessions).filter((s) => !s.ghost)))
// While you are pointing at or touching the list, rows hold their places (new ones go last), so a tap never lands on a row that just moved.
const hold = ref(false)
let release: ReturnType<typeof setTimeout> | undefined
function holdOn() { hold.value = true; clearTimeout(release) }
function holdFor(ms: number) { hold.value = true; clearTimeout(release); release = setTimeout(() => { hold.value = false }, ms) }
const order = ref<string[]>([])
// Also right after the list appears (back from a chat): you aim at a row before you touch the screen.
onMounted(() => holdFor(2500))
watch([() => fresh.value.map((r) => r.s.id).join('|'), hold], () => { order.value = inboxOrder(order.value, fresh.value.map((r) => r.s.id), hold.value) }, { immediate: true })
const rows = computed(() => {
  const by = new Map(fresh.value.map((r) => [r.s.id, r]))
  return order.value.flatMap((id) => by.get(id) ?? [])
})
const worldOf = (s: Session) => shown.value.find((g) => g.sessions.includes(s))?.world
const emit = defineEmits<{ 'new-task': [] }>()
</script>

<template>
  <section class="panel chats" aria-label="Chats" @mouseenter="holdOn" @mouseleave="hold = false" @touchstart.passive="holdFor(4000)" @scroll.capture.passive="holdFor(4000)">
    <h3>Chats <span v-if="needsYou.length" class="count">{{ needsYou.length }}</span><span class="hint">needing you first, then latest</span><button class="btn primary chat-new" @click="emit('new-task')">+ New chat</button></h3>
    <nav v-if="groups.length > 1" class="chat-worlds" aria-label="Show world">
      <button :aria-pressed="state.filter === 'all'" @click="state.filter = 'all'">All</button>
      <button v-for="g in groups" :key="g.world.id" :aria-pressed="state.filter === g.world.id" :style="{ '--tint': g.world.color }" @click="state.filter = g.world.id">{{ g.world.name }}</button>
    </nav>
    <div v-if="runsNeedingYou.length" class="cards"><RunCard v-for="r in runsNeedingYou" :key="r.id" :run="r" /></div>
    <p v-if="!rows.length" class="empty">{{ state.filter === 'all' ? 'No sessions yet.' : 'No sessions in this world.' }} Start one with <b>+ New chat</b>.</p>
    <ul class="chat-rows">
      <li v-for="r in rows" :key="r.s.id">
        <button :class="['chat-row', { current: state.selectedId === r.s.id, needs: r.needs }]" :style="{ '--tint': worldOf(r.s)?.color ?? '#8a92a0' }" @click="openChat(r.s.id)">
          <span :class="['dot', r.s.state]" />
          <span class="chat-main">
            <span class="chat-top"><b>{{ nameOf(r.s) }}</b><span v-if="state.filter === 'all' && worldOf(r.s)" class="chat-wname">{{ worldOf(r.s)!.name }}</span><span v-if="r.s.branch" class="tag">{{ r.s.branch }}</span><span class="chat-time">{{ chatTime(r.at, state.now) }}</span></span>
            <span class="chat-sub"><span v-if="r.s.card && r.needs" :class="['count', 'tone-' + chatBadge(r.s.card).tone]">{{ chatBadge(r.s.card).label }}</span><span v-else :class="['chat-state', { solo: r.preview === stateLabel(r.s, state.now) }]">{{ stateLabel(r.s, state.now) }}</span><span v-if="r.preview !== stateLabel(r.s, state.now)" class="chat-prev">{{ r.preview }}</span></span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>
