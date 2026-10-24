<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Session, Card } from '../types'
import { agentLabel, fmtWait, permissionWho, waitMinutes, cardLive, inboxOrder, nameOf, cardKey, teamOf } from '../logic'
import { state, needsYou, runsNeedingYou, groups, select, focusTerminal as focusTerm } from '../store'
import CardActions from './CardActions.vue'
import RunCard from './RunCard.vue'

const keyOf = cardKey
// While the pointer is over the inbox the cards hold their places (so a click never lands on a different card); new ones go last, highlighted.
const hover = ref(false)
const order = ref<string[]>([])
const fresh = ref<string[]>([])
let freshTimer: ReturnType<typeof setTimeout> | undefined
watch([() => needsYou.value.map(keyOf).join('|'), hover], () => {
  const next = needsYou.value.map(keyOf)
  if (hover.value) fresh.value = [...new Set([...fresh.value, ...next.filter((k) => !order.value.includes(k))])]
  else { clearTimeout(freshTimer); freshTimer = setTimeout(() => { fresh.value = [] }, 2500) }
  order.value = inboxOrder(order.value, next, hover.value)
}, { immediate: true })
const items = computed(() => {
  const by = new Map(needsYou.value.map((s) => [keyOf(s), s]))
  return order.value.flatMap((k) => { const s = by.get(k); return s ? [{ s, c: s.card!, k }] : [] })
})
const world = (s: Session) => groups.value.find((g) => g.sessions.includes(s))?.world
const WHO = { question: 'is asking you', asking: 'is asking you', done: 'finished', error: 'hit a problem' } as const
const who = (c: Card): string => (c.kind === 'permission' ? permissionWho(c) : WHO[c.kind])
</script>

<template>
  <section class="panel" aria-label="Needs you" @mouseenter="hover = true" @mouseleave="hover = false">
    <h3>Needs you <span class="count">{{ needsYou.length + runsNeedingYou.length }}</span><span class="hint">permissions first, then oldest</span></h3>
    <div v-if="runsNeedingYou.length" class="cards"><RunCard v-for="r in runsNeedingYou" :key="r.id" :run="r" /></div>
    <p v-if="!needsYou.length && !runsNeedingYou.length" class="empty">Nothing needs you. Every session is working or idle.</p>
    <TransitionGroup name="card" tag="div" class="cards">
    <article v-for="{ s, c, k } in items" :key="k" :class="['card', { current: state.selectedId === s.id, fresh: fresh.includes(k) }]" :style="{ '--tint': world(s)?.color ?? '#8a92a0' }">
      <div class="who">
        <span :class="['dot', s.state]" /><b>{{ nameOf(s) }}</b><span v-if="agentLabel(s)" class="tag">{{ agentLabel(s) }}</span>
        <span v-if="s.branch" class="tag" :title="s.cwd">{{ s.branch }}</span><span v-if="s.worktree" class="tag">worktree</span><span v-if="s.parent" class="tag">{{ teamOf(s, state.sessions) }}</span>
        {{ who(c) }} ·
        <span :class="['wait', { late: waitMinutes(s, state.now) >= 20 }]">{{ fmtWait(waitMinutes(s, state.now), s.state) }}</span>
      </div>
      <CardActions :s="s" :c="c" />

      <button v-if="cardLive(c)" class="linkbtn" @click="select(s.id); focusTerm()">Open its terminal</button>
    </article>
    </TransitionGroup>
  </section>
</template>
