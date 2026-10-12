<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { state, createSession } from '../store'
import { baseName } from '../logic'

/** worldId is '' when the dialog has to ask which world. */
const props = defineProps<{ worldId: string }>()
const emit = defineEmits<{ close: [] }>()
const wid = ref(props.worldId)
const world = computed(() => state.worlds.find((w) => w.id === wid.value))
const repo = ref(world.value?.repos[0] ?? '')
watch(wid, () => { repo.value = world.value?.repos[0] ?? '' })
const task = ref('')
const worktree = ref(true)
const branch = ref('')
const error = ref('')
const sending = ref(false)
const box = ref<HTMLElement | null>(null)
onMounted(() => box.value?.querySelector<HTMLElement>(props.worldId ? 'textarea' : 'select')?.focus())

async function submit() {
  if (sending.value) return
  if (!wid.value) { error.value = 'Pick a world.'; return }
  if (!repo.value) { error.value = 'Pick a repo.'; return }
  sending.value = true; error.value = ''
  const err = await createSession({ worldId: wid.value, repo: repo.value, task: task.value.trim(), worktree: worktree.value, ...(branch.value.trim() ? { branch: branch.value.trim() } : {}) })
  sending.value = false
  if (err) error.value = err
  else emit('close')
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <form ref="box" class="dialog form" role="dialog" aria-modal="true" aria-label="New session" @submit.prevent="submit">
      <h2>New session{{ world ? ` in ${world.name}` : '' }}</h2>
      <label v-if="!worldId">World
        <select v-model="wid" aria-label="World"><option value="" disabled>Choose a world</option><option v-for="w in state.worlds" :key="w.id" :value="w.id">{{ w.name }}</option></select>
      </label>
      <p v-if="wid && !world?.repos.length" class="why">This world has no repos in the config yet.</p>
      <label>Repo
        <select v-model="repo"><option v-for="r in world?.repos ?? []" :key="r" :value="r">{{ baseName(r) }} ({{ r }})</option></select>
      </label>
      <label>Task (optional)
        <textarea v-model="task" placeholder="Leave empty to start a blank session" />
      </label>
      <label class="row"><input v-model="worktree" type="checkbox"> Use a new worktree</label>
      <label>Branch name (optional)
        <input v-model="branch" type="text" placeholder="feat/something" autocomplete="off">
      </label>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="btn primary" :disabled="sending">{{ sending ? 'Starting…' : 'Start' }}</button>
        <button type="button" class="btn" @click="emit('close')">Cancel</button>
      </div>
    </form>
  </div>
</template>
