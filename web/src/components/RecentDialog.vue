<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { HistorySession } from '../types'
import { fetchHistory, select, state } from '../store'
import { ageText, baseName, filterHistory } from '../logic'
import { type ModeChoice } from '../logic'
import ResumeButton from './ResumeButton.vue'
import PermissionSelect from './PermissionSelect.vue'

const emit = defineEmits<{ close: [] }>()
const list = ref<HistorySession[] | null>(null)
const error = ref('')
const q = ref('')
const mode = ref<ModeChoice>('claude')
const search = ref<HTMLInputElement | null>(null)
const shown = computed(() => filterHistory(list.value ?? [], q.value))
onMounted(async () => {
  search.value?.focus()
  const r = await fetchHistory()
  if (r.ok) list.value = r.data.sessions
  else error.value = r.error
})
// A session this server already manages is open here: show it instead of resuming a second copy.
function show(id: string) {
  if (state.sessions[id]) { select(id); emit('close') }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog recent" role="dialog" aria-modal="true" aria-label="Recent sessions">
      <h2>Recent sessions</h2>
      <p class="why">Claude sessions on this computer, including ones started before Agent Worlds. Resuming keeps the whole conversation.</p>
      <input ref="search" v-model="q" type="text" class="search" placeholder="Search by repo or last prompt" aria-label="Search recent sessions" autocomplete="off">
      <div class="form"><PermissionSelect v-model="mode" /></div>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-else-if="!list" class="why">Loading…</p>
      <p v-else-if="!shown.length" class="why">{{ list.length ? 'No session matches.' : 'No past sessions found.' }}</p>
      <ul class="recent-list">
        <li v-for="h in shown" :key="h.sessionId">
          <div class="r-main">
            <b>{{ h.repo ? baseName(h.repo) : h.cwd ? baseName(h.cwd) : h.sessionId.slice(0, 8) }}</b>
            <span class="r-age">{{ ageText(h.lastActivity, state.now) }}</span>
            <span v-if="h.running" class="badge run">running</span>
            <span v-if="h.managed" class="badge mgd">in Agent Worlds</span>
            <p v-if="h.cwd" class="r-path" :title="h.cwd">{{ h.cwd }}</p>
            <p class="r-prompt">{{ h.lastPrompt ?? 'No prompt recorded' }}</p>
          </div>
          <button v-if="h.managed && state.sessions[h.sessionId]" class="btn" @click="show(h.sessionId)">Show</button>
          <ResumeButton v-else-if="!h.managed" :session-id="h.sessionId" :mode="mode" @started="emit('close')" />
        </li>
      </ul>
      <div class="actions"><button class="btn" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
