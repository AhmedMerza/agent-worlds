<script setup lang="ts">
import { ref } from 'vue'
import { resumeSession } from '../store'
import { modeField, type ModeChoice } from '../logic'

/** `agent`: a Kimi session (permission modes are Claude-only). */
const props = defineProps<{ sessionId: string; label?: string; primary?: boolean; mode?: ModeChoice; agent?: 'kimi' }>()
const emit = defineEmits<{ started: [] }>()
const busy = ref(false)
const error = ref('')
/** Set when the server says the session is still open elsewhere (pid may be unknown). */
const running = ref<{ pid: number | null } | null>(null)

async function go(stop: boolean) {
  if (busy.value) return
  busy.value = true; error.value = ''
  const r = await resumeSession(props.sessionId, stop, props.agent ? undefined : modeField(props.mode ?? 'claude').permissionMode, props.agent)
  busy.value = false
  if (r.kind === 'ok') { running.value = null; emit('started') }
  else if (r.kind === 'running') running.value = { pid: r.pid }
  else error.value = r.message
}
</script>

<template>
  <div class="resume">
    <template v-if="running">
      <p class="warn-note" role="alert">
        This session is still open{{ running.pid ? ` in another terminal (pid ${running.pid})` : ' somewhere else' }}. Two copies writing to one conversation can garble it, so the other one has to quit first. It keeps everything said so far.
      </p>
      <div class="actions">
        <button v-if="running.pid" class="btn primary" :disabled="busy" @click="go(true)">{{ busy ? 'Stopping it…' : 'Stop it and resume here' }}</button>
        <button class="btn" :disabled="busy" @click="running = null">Cancel</button>
      </div>
    </template>
    <button v-else :class="['btn', { primary }]" :disabled="busy" @click="go(false)">{{ busy ? 'Resuming…' : label ?? 'Resume here' }}</button>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
  </div>
</template>
