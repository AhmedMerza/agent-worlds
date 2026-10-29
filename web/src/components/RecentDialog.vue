<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { HistorySession } from '../types'
import { dismissRecovery, fetchHistory, select, state, ui } from '../store'
import { ageText, agentName, baseName, filterHistory, groupByFolder } from '../logic'
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
const folders = computed(() => groupByFolder(shown.value))
/** Folders folded shut, by cwd. */
const folded = reactive(new Set<string>())
const toggle = (cwd: string) => (folded.has(cwd) ? folded.delete(cwd) : folded.add(cwd))
async function load() {
  list.value = null; error.value = ''
  const repo = ui.recentRepo
  const r = await fetchHistory(repo ?? undefined)
  if (repo !== ui.recentRepo) return // switched while loading
  if (r.ok) list.value = r.data.sessions
  else error.value = r.error
}
onMounted(() => { search.value?.focus(); void load() })
watch(() => ui.recentRepo, load)
// A session this server already manages is open here: show it instead of resuming a second copy.
function show(id: string) {
  if (state.sessions[id]) { select(id); emit('close') }
}
async function dismiss(id: string) {
  if (await dismissRecovery(id)) await load()
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog recent" role="dialog" aria-modal="true" aria-label="Recent sessions">
      <h2>{{ ui.recentRepo ? `Past sessions in ${baseName(ui.recentRepo)}` : 'Recent sessions' }}</h2>
      <p v-if="ui.recentRepo" class="why">Every folder of {{ ui.recentRepo }}, its worktrees included. <button class="linkbtn" @click="ui.recentRepo = null">Show all folders</button></p>
      <p v-else class="why">Agent conversations on this computer by folder, including ones started before Agent Worlds and ones interrupted by a restart. Resuming keeps the whole conversation.</p>
      <input ref="search" v-model="q" type="text" class="search" placeholder="Search by folder or last prompt" aria-label="Search recent sessions" autocomplete="off">
      <div class="form"><PermissionSelect v-model="mode" label="Claude Code permissions" /><p class="why">Only affects Claude Code rows below.</p></div>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-else-if="!list" class="why">Loading…</p>
      <p v-else-if="!shown.length" class="why">{{ list.length ? 'No session matches.' : 'No past sessions found.' }}</p>
      <div class="recent-groups">
        <section v-for="g in folders" :key="g.cwd" class="r-folder">
          <button class="r-fhead" :aria-expanded="!folded.has(g.cwd)" :title="g.cwd" @click="toggle(g.cwd)">
            <span aria-hidden="true">{{ folded.has(g.cwd) ? '▸' : '▾' }}</span><b>{{ g.label }}</b>
            <span class="r-age">{{ g.items.length }} · {{ ageText(g.items[0].lastActivity, state.now) }}</span>
          </button>
          <ul v-if="!folded.has(g.cwd)" class="recent-list">
            <li v-for="h in g.items" :key="h.sessionId" :class="{ 'codex-resume': h.agent === 'codex' && !h.managed }">
              <div class="r-main">
                <span class="r-age">{{ ageText(h.lastActivity, state.now) }}</span>
                <span v-if="h.agent" class="badge">{{ agentName(h) }}</span>
                <span v-if="h.running" class="badge run">running</span>
                <span v-if="h.managed" class="badge mgd">in Agent Worlds</span>
                <span v-if="h.interrupted" class="badge">interrupted</span>
                <p class="r-prompt">{{ h.lastPrompt ?? 'No prompt recorded' }}</p>
              </div>
              <button v-if="h.managed && state.sessions[h.sessionId]" class="btn" @click="show(h.sessionId)">Show</button>
              <ResumeButton v-else-if="!h.managed" :session-id="h.sessionId" :mode="mode" :agent="h.agent" @started="emit('close')" />
              <button v-if="h.interrupted" class="btn" title="Remove this restart reminder without deleting the agent's saved conversation" @click="dismiss(h.sessionId)">Dismiss reminder</button>
            </li>
          </ul>
        </section>
      </div>
      <div class="actions"><button class="btn" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
