<script setup lang="ts">
import { computed } from 'vue'
import { LABEL, ctxColor, ctxLevel } from '../logic'
import { selected, groups, focusTerminal, sendInput, showToast } from '../store'

const s = computed(() => selected.value)
const world = computed(() => groups.value.find((g) => s.value && g.sessions.includes(s.value))?.world)
const level = computed(() => (s.value?.context ? ctxLevel(s.value.context.pct) : 0))

async function copyAttach() {
  const t = s.value?.tmux
  if (!t) return
  const text = `tmux attach -t ${t.session}`
  try { await navigator.clipboard.writeText(text); showToast('Copied: ' + text); return } catch { /* fall back below */ }
  const ta = document.createElement('textarea')
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* ignore */ }
  ta.remove()
  showToast(ok ? 'Copied: ' + text : 'Could not copy. Run: ' + text)
}
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
        <template v-if="level === 2"><p class="why">Nearly full. Every reply now re-reads all of it. Save the plan and clear before the next task.</p>
          <div class="actions"><button class="btn" @click="sendInput(s.id, '/handover-save')">/handover-save</button><button class="btn primary" @click="sendInput(s.id, '/clear')">/clear</button></div></template>
        <template v-else-if="level === 1"><p class="why">Getting heavy. Check whether it is still worth keeping.</p>
          <div class="actions"><button class="btn" @click="sendInput(s.id, '/checkpoint')">/checkpoint</button></div></template>
      </div>
      <p v-for="c in s.conflicts ?? []" :key="c.withId" class="conflicts">⚠ Overlaps with {{ c.withId }}: {{ c.reason }}</p>
      <div v-if="s.helpers.length">
        <span class="lbl">Helpers ({{ s.helpers.length }})</span>
        <ul><li v-for="h in s.helpers" :key="h.id"><span :class="['dot', h.state === 'done' ? 'done' : 'working']" />{{ h.task }}</li></ul>
      </div>
      <div v-if="s.log.length">
        <span class="lbl">Recent steps</span>
        <ol><li v-for="l in s.log.slice(-6)" :key="l.t + l.text">{{ l.text }}</li></ol>
      </div>
      <div class="actions">
        <button class="btn" @click="focusTerminal">Open in terminal</button>
        <button v-if="s.tmux" class="btn" @click="copyAttach">Copy attach command</button>
      </div>
    </div>
  </section>
</template>
