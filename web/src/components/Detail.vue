<script setup lang="ts">
import { computed } from 'vue'
import { LABEL, ctxColor } from '../logic'
import { selected, groups, focusTerminal } from '../store'

const s = computed(() => selected.value)
const world = computed(() => groups.value.find((g) => s.value && g.sessions.includes(s.value))?.world)
</script>

<template>
  <section class="panel" aria-live="polite" :style="{ '--tint': world?.color ?? '#8a92a0' }">
    <p v-if="!s" class="empty">Select a session.</p>
    <div v-else class="detail">
      <div class="d-head"><h3>{{ s.repoName }}</h3><span :class="['pill', s.state]">{{ LABEL[s.state] }}</span></div>
      <p class="path">{{ world?.name }} · {{ s.worktree ? 'worktree on' : 'branch' }} {{ s.branch ?? 'unknown' }}</p>
      <p v-if="s.task" class="now"><span class="lbl">Task</span>{{ s.task }}</p>
      <p class="now"><span class="lbl">Now</span>{{ s.now }}</p>
      <div v-if="s.context">
        <span class="lbl">Context {{ s.context.pct }}% full</span>
        <div class="meter"><i :style="{ width: Math.min(100, s.context.pct) + '%', background: ctxColor(s.context.pct) }" /></div>
      </div>
      <p v-for="c in s.conflicts ?? []" :key="c.withId" class="conflicts">Overlaps with {{ c.withId }}: {{ c.reason }}</p>
      <div v-if="s.helpers.length">
        <span class="lbl">Helpers ({{ s.helpers.length }})</span>
        <ul><li v-for="h in s.helpers" :key="h.id"><span :class="['dot', h.state === 'done' ? 'done' : 'working']" />{{ h.task }}</li></ul>
      </div>
      <div v-if="s.log.length">
        <span class="lbl">Recent steps</span>
        <ol><li v-for="l in s.log.slice(-6)" :key="l.t + l.text">{{ l.text }}</li></ol>
      </div>
      <div class="actions"><button class="btn" @click="focusTerminal">Open in terminal</button></div>
    </div>
  </section>
</template>
