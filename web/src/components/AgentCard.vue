<script setup lang="ts">
import type { Session } from '../types'
import { agentName, ctxColor, nameOf, nowText, stateLabel, NEEDS_YOU, teamOf } from '../logic'
import { state, select, focusTerminal, ui } from '../store'
import { tokenText, usageTotal } from '../hq'

/** One person's card in a room (HQ and Classic): what it is doing, its context and tokens; Chat slides its conversation in from the right. */
const props = defineProps<{ s: Session }>()
defineEmits<{ close: [] }>()
// This card's session, even if a shortcut or another view picked someone else since it opened.
const chat = () => { select(props.s.id); ui.chatDrawer = true }
function terminal() { select(props.s.id); ui.chatDrawer = false; focusTerminal() }
</script>

<template>
  <Teleport to="body"><section class="hq-card" :style="{ '--tint': state.worlds.find(w => w.id === s.worldId)?.color ?? '#8a92a0' }" role="dialog" :aria-label="`${nameOf(s)} details`">
    <header>
      <span class="hq-avatar">{{ nameOf(s).slice(0, 1).toUpperCase() }}</span>
      <div><h3>{{ nameOf(s) }}</h3><p>{{ s.ghost ? 'Plain terminal' : agentName(s) }}<template v-if="s.parent"> · on the {{ teamOf(s, state.sessions) }}</template></p></div>
      <button class="hq-x" aria-label="Close" @click="$emit('close')">×</button>
    </header>
    <p><span :class="['pill', s.state]">{{ stateLabel(s, state.now) }}</span><span v-if="s.branch" class="hq-branch">{{ s.branch }}</span></p>
    <template v-if="s.ghost"><p class="why">It runs in a terminal outside Agent Worlds, so there is no live status, chat or token count here. The panel on the right can move it in.</p></template>
    <template v-else>
      <p v-if="s.task" class="hq-line"><span class="lbl">Task</span>{{ s.task }}</p>
      <p class="hq-line"><span class="lbl">Now</span>{{ nowText(s.now) }}</p>
      <div v-if="s.context" class="hq-line">
        <span class="lbl">Context {{ s.context.pct }}% full · {{ tokenText(s.context.used) }} of {{ tokenText(s.context.limit) }}</span>
        <div class="meter"><i :style="{ width: Math.min(100, s.context.pct) + '%', background: ctxColor(s.context.pct) }" /></div>
      </div>
      <div v-if="s.usage" class="hq-line">
        <span class="lbl">Tokens this conversation · {{ tokenText(usageTotal(s.usage)) }}</span>
        <dl class="hq-usage">
          <div><dt>In</dt><dd>{{ tokenText(s.usage.input) }}</dd></div>
          <div><dt>Out</dt><dd>{{ tokenText(s.usage.output) }}</dd></div>
          <div><dt>Cache read</dt><dd>{{ tokenText(s.usage.cacheRead) }}</dd></div>
          <div><dt>Cache write</dt><dd>{{ tokenText(s.usage.cacheWrite) }}</dd></div>
        </dl>
      </div>
      <p v-else-if="s.agent && s.agent !== 'claude'" class="why">{{ agentName(s) }} does not report token totals here yet.</p>
      <p v-if="s.helpers.length" class="hq-line"><span class="lbl">Helpers</span>{{ s.helpers.filter(h => h.state === 'working').length }} working, {{ s.helpers.length }} in all</p>
      <div v-if="s.log.length" class="hq-line"><span class="lbl">Recent steps</span><ol><li v-for="l in s.log.slice(-3)" :key="l.t + l.text">{{ l.text }}</li></ol></div>
      <div class="actions">
        <button :class="['btn', { primary: NEEDS_YOU.includes(s.state) }]" @click="chat">Chat</button>
        <button v-if="s.tmux || s.direct" class="btn" @click="terminal">Terminal</button>
      </div>
    </template>
  </section></Teleport>
</template>
