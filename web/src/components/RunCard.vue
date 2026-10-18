<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Run } from '../types'
import { STEP_LABEL, agentName, isStepOf } from '../logic'
import { state, runNext, runStop, select, showToast } from '../store'
import { copyText } from '../clipboard'

/** A run's steps and what it waits on; `here` marks the step of the session being looked at. */
const props = defineProps<{ run: Run; here?: number }>()
const busy = ref(false)
const r = computed(() => props.run)
const live = computed(() => r.value.status === 'running' || r.value.status === 'waiting')
const nextLabel = computed(() => {
  const i = r.value.current + 1
  return i < r.value.steps.length ? `Start ${STEP_LABEL[r.value.steps[i].kind]}` : 'Finish the run'
})
const STATUS: Record<Run['status'], string> = { running: 'running', waiting: 'waiting for you', done: 'done', stopped: 'stopped', failed: 'failed' }
async function act(f: (id: string) => ReturnType<typeof runNext>) {
  busy.value = true
  const res = await f(r.value.id)
  busy.value = false
  if (!res.ok) showToast(res.error)
}
/** Sessions its steps started that are still open: stopping can end them too. */
const sessions = computed(() => Object.values(state.sessions).filter((s) => [...r.value.steps, ...(r.value.earlier ?? [])].some((st) => isStepOf(st, s))))
const stopAndEnd = (id: string) => runStop(id, true)
const open = (id: string | null) => { if (id && state.sessions[id]) select(id) }
/** The last step that handed off, and where the steps leave their files (plan.md, reviews). */
const last = computed(() => r.value.steps.filter((s) => s.status === 'handed').at(-1) ?? null)
const files = computed(() => (r.value.dir ? `${r.value.dir}/.aw/run-${r.value.id}` : null))
async function copyFiles() { if (files.value) showToast(await copyText(files.value) ? 'Copied: ' + files.value : files.value) }
</script>

<template>
  <article :class="['card', 'run', r.status]">
    <div class="who"><span :class="['dot', r.status === 'running' ? 'working' : r.status === 'waiting' || r.status === 'failed' ? 'waiting' : 'done']" /><b>Run</b> · {{ STATUS[r.status] }}<template v-if="r.rounds"> · round {{ r.rounds + 1 }}, the code review asked for changes</template></div>
    <p class="ask">{{ r.task }}</p>
    <ol class="steps">
      <li v-for="(st, i) in r.steps" :key="i" :class="[st.status, { current: i === r.current && live, here: i === here }]">
        <button type="button" class="step" :disabled="!st.sessionId || !state.sessions[st.sessionId]" :title="st.summary ?? undefined" @click="open(st.sessionId)">
          {{ st.status === 'handed' ? '✓' : i === r.current && live ? '●' : '○' }} {{ STEP_LABEL[st.kind] }} · {{ agentName(st) }}<template v-if="st.checkpoint"> · then pause</template>
        </button>
      </li>
    </ol>
    <p v-if="last?.summary" class="now"><span class="lbl">{{ STEP_LABEL[last.kind] }} ({{ agentName(last) }}) says</span>{{ last.summary }}</p>
    <p v-if="files" class="why run-files">Plan and reviews: <code>{{ files }}</code> <button type="button" class="btn" @click="copyFiles">Copy</button></p>
    <p v-if="r.note" class="why">{{ r.note }}</p>
    <div v-if="r.status === 'failed'" class="actions">
      <button class="btn" :disabled="busy" @click="act(runStop)">Dismiss</button>
    </div>
    <div v-if="live" class="actions">
      <button v-if="r.status === 'waiting'" class="btn primary" :disabled="busy" @click="act(runNext)">{{ nextLabel }}</button>
      <button v-else class="btn" :disabled="busy" title="Move on without waiting for this step to hand off" @click="act(runNext)">Skip to next step</button>
      <button class="btn" :disabled="busy" @click="act(runStop)">Stop run</button>
      <button v-if="sessions.length" class="btn" :disabled="busy" title="Stop the run, quit its agents and close their terminals" @click="act(stopAndEnd)">Stop and end its {{ sessions.length === 1 ? 'session' : `${sessions.length} sessions` }}</button>
    </div>
    <div v-else-if="sessions.length && r.status !== 'failed'" class="actions">
      <button class="btn" :disabled="busy" title="Quit its agents and close their terminals" @click="act(stopAndEnd)">End its {{ sessions.length === 1 ? 'session' : `${sessions.length} sessions` }}</button>
    </div>
  </article>
</template>

<style scoped>
.steps { list-style: none; padding: 0; margin: 6px 0; display: flex; flex-wrap: wrap; gap: 4px; }
.step { font: inherit; font-size: 12px; padding: 2px 8px; border-radius: 10px; border: 1px solid var(--line, #3a4150); background: transparent; color: inherit; cursor: pointer; }
.step:disabled { cursor: default; opacity: .75; }
.handed .step { border-color: #4f9d6b; }
.current .step { border-color: #d9a441; font-weight: 600; }
.here .step { outline: 1px dashed currentColor; outline-offset: 1px; }
.run-files code { word-break: break-all; }
.run-files .btn { width: auto; display: inline-block; padding: 1px 8px; margin-left: 4px; }
</style>
