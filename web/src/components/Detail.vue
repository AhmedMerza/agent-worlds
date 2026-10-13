<script setup lang="ts">
import { computed } from 'vue'
import { LABEL, ctxColor, ctxLevel, UNSORTED, nowText, isTouch, ageText } from '../logic'
import { selected, groups, focusTerminal, askClaude, showToast, ui, state } from '../store'
import ResumeButton from './ResumeButton.vue'

const s = computed(() => selected.value)
const world = computed(() => groups.value.find((g) => s.value && g.sessions.includes(s.value))?.world)
const touch = isTouch()
const level = computed(() => (s.value?.context ? ctxLevel(s.value.context.pct) : 0))

const attachText = computed(() => (s.value?.tmux ? `tmux attach -t ${s.value.tmux.session}` : ''))
async function copyAttach() {
  const text = attachText.value
  if (!text) return
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
    <div v-else-if="s.ghost" class="detail">
      <div class="d-head"><h3>{{ s.repoName }}</h3><span class="pill">Plain terminal</span></div>
      <p class="path">{{ world?.name }} · {{ s.cwd }}</p>
      <p v-if="s.ghost.lastPrompt" class="now"><span class="lbl">Last thing you asked it</span>{{ s.ghost.lastPrompt }}</p>
      <p v-if="s.ghost.lastActivity" class="now"><span class="lbl">Last active</span>{{ ageText(s.ghost.lastActivity, state.now) }}</p>
      <p class="why">It runs in a terminal outside Agent Worlds (pid {{ s.ghost.pid }}), so there is no live status or terminal here. Move it in to get them.</p>
      <template v-if="s.ghost.sessionId"><ResumeButton :session-id="s.ghost.sessionId" label="Move into Agent Worlds" primary /></template>
      <p v-else class="why">Which conversation this is could not be told, so it cannot be moved automatically. Use Recent sessions (R) to pick it.</p>
    </div>
    <div v-else class="detail">
      <p v-if="s.state === 'starting'" class="why">Claude may be asking to trust this folder. Answer below in the terminal.</p>
      <div class="d-head"><h3>{{ s.repoName }}</h3><span :class="['pill', s.state]">{{ LABEL[s.state] }}</span></div>
      <p class="path">{{ world?.name }}<template v-if="s.branch || s.worktree"> · {{ s.worktree ? 'worktree on' : 'branch' }} {{ s.branch ?? 'unknown' }}</template></p>
      <p class="path" :title="s.cwd">{{ s.cwd }}</p>
      <p v-if="s.task" class="now"><span class="lbl">Task (first prompt)</span>{{ s.task }}</p>
      <p v-if="s.lastPrompt && s.lastPrompt !== s.task" class="now"><span class="lbl">Last message you sent</span>{{ s.lastPrompt }}</p>
      <p class="now"><span class="lbl">Now</span>{{ nowText(s.now) }}</p>
      <div v-if="s.context">
        <span class="lbl">Context {{ s.context.pct }}% full</span>
        <div class="meter"><i :style="{ width: Math.min(100, s.context.pct) + '%', background: ctxColor(s.context.pct) }" /></div>
        <template v-if="level === 2"><p class="why">Nearly full. Every reply now re-reads all of it. Save the plan and clear before the next task.</p>
          <div class="actions"><button class="btn" @click="askClaude(s.id, s.repoName, '/handover-save')">/handover-save</button><button class="btn primary" @click="askClaude(s.id, s.repoName, '/clear')">/clear</button></div></template>
        <template v-else-if="level === 1"><p class="why">Getting heavy. Check whether it is still worth keeping.</p>
          <div class="actions"><button class="btn" @click="askClaude(s.id, s.repoName, '/checkpoint')">/checkpoint</button></div></template>
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
      <div v-if="s.tmux && !touch" class="attach-cmd">
        <code>{{ attachText }}</code><button class="btn" @click="copyAttach">Copy</button>
        <span class="why">Or run <code>agent-worlds attach</code> to pick one, e.g. from Ghostty.</span>
      </div>
      <div class="actions">
        <button class="btn" @click="focusTerminal">Open in terminal</button>
        <button v-if="world?.id === UNSORTED.id" class="btn" @click="ui.putSession = s.id">Put {{ s.repoName }} in a world…</button>
      </div>
    </div>
  </section>
</template>
