<script setup lang="ts">
import { computed } from 'vue'
import { state, moveSession, showToast } from '../store'

/** Moves one session to another world. Its repo stays where it is, and so do the repo's other sessions. */
const props = defineProps<{ sessionId: string }>()
const emit = defineEmits<{ close: [] }>()
const s = computed(() => state.sessions[props.sessionId])
async function move(worldId: string) {
  const w = state.worlds.find((x) => x.id === worldId)
  if (!w || !s.value) return
  const r = await moveSession(s.value.id, w.id)
  if (r.ok) { showToast(`This ${s.value.repoName} session is now in ${w.name}.`); emit('close') } else showToast(r.error)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" :aria-label="`Move this ${s?.repoName} session to another world`">
      <h2>Move this session to another world</h2>
      <p class="why">Only this session moves, and it stays there after /clear and restarts. {{ s?.repoName }} and its other sessions stay where they are. Pick the world its folder is in to move it back.</p>
      <div class="actions">
        <button v-for="w in state.worlds" :key="w.id" class="btn" :style="{ borderColor: w.color }" :disabled="w.id === s?.worldId" @click="move(w.id)">{{ w.name }}{{ w.id === s?.worldId ? ' (here now)' : '' }}</button>
      </div>
      <div class="actions" style="margin-top:12px"><button class="btn" @click="emit('close')">Cancel</button></div>
    </div>
  </div>
</template>
