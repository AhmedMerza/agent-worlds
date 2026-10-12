<script setup lang="ts">
import { computed } from 'vue'
import { state, updateWorld, showToast } from '../store'
import { withRepo } from '../logic'

const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ close: []; 'open-worlds': [] }>()
const s = computed(() => state.sessions[props.sessionId])
async function put(id: string) {
  const w = state.worlds.find((x) => x.id === id)
  if (!w || !s.value) return
  const r = await updateWorld(w.id, { repos: withRepo(w.repos, s.value.repo) })
  if (r.ok) { showToast(`${s.value.repoName} is now in ${w.name}.`); emit('close') } else showToast(r.error)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="`Put ${s?.repoName} in a world`">
      <h2>Put {{ s?.repoName }} in a world</h2>
      <p v-if="!state.worlds.length" class="why">There are no worlds yet.</p>
      <div class="actions">
        <button v-for="w in state.worlds" :key="w.id" class="btn" :style="{ borderColor: w.color }" @click="put(w.id)">{{ w.name }}</button>
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn" @click="emit('close'); emit('open-worlds')">Manage worlds…</button>
        <button class="btn" @click="emit('close')">Cancel</button>
      </div>
    </div>
  </div>
</template>
