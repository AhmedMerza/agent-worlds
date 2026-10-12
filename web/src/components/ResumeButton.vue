<script setup lang="ts">
import { ref } from 'vue'
import { resumeSession } from '../store'

const props = defineProps<{ sessionId: string; label?: string; primary?: boolean }>()
const emit = defineEmits<{ started: [] }>()
const busy = ref(false)
const error = ref('')
/** Set when the server says the session is still open elsewhere (pid may be unknown). */
const running = ref<{ pid: number | null } | null>(null)

async function go(force: boolean) {
  if (busy.value) return
  busy.value = true; error.value = ''
  const r = await resumeSession(props.sessionId, force)
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
        This session is still open{{ running.pid ? ` in another terminal (pid ${running.pid})` : ' somewhere else' }}. Two copies writing to one conversation can garble it. Quit it there first.
      </p>
      <div class="actions">
        <button class="btn danger" :disabled="busy" @click="go(true)">{{ busy ? 'Resuming…' : 'Resume anyway' }}</button>
        <button class="btn" :disabled="busy" @click="running = null">Cancel</button>
      </div>
    </template>
    <button v-else :class="['btn', { primary }]" :disabled="busy" @click="go(false)">{{ busy ? 'Resuming…' : label ?? 'Resume here' }}</button>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
  </div>
</template>
