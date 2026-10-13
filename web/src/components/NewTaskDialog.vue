<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { state, browseFs, createSession, updateWorld, moveRepo } from '../store'
import { baseName, modeField, withRepo, type ModeChoice } from '../logic'
import FolderBrowser from './FolderBrowser.vue'
import PermissionSelect from './PermissionSelect.vue'

/** worldId is '' when the dialog has to ask which world. */
const props = defineProps<{ worldId: string }>()
const emit = defineEmits<{ close: [] }>()
const wid = ref(props.worldId)
const world = computed(() => state.worlds.find((w) => w.id === wid.value))
const repo = ref(world.value?.repos[0] ?? '')
watch(wid, () => { repo.value = world.value?.repos[0] ?? '' })
const task = ref('')
const mode = ref<ModeChoice>('claude')
const browsing = ref(false)
const worktree = ref(true)
/** Whether the chosen folder is a git repo (null while unknown): worktrees and branches only make sense there. */
const isGit = ref<boolean | null>(null)
watch(repo, async (path) => {
  isGit.value = null
  const parent = path.replace(/\/[^/]+$/, '') || '/'
  const r = path ? await browseFs(parent) : null
  if (repo.value === path) isGit.value = r?.ok ? (r.data.entries.find((e) => e.path === path)?.isRepo ?? false) : null
}, { immediate: true })
const branch = ref('')
const error = ref('')
const sending = ref(false)
const box = ref<HTMLElement | null>(null)
onMounted(() => box.value?.querySelector<HTMLElement>(props.worldId ? 'textarea' : 'select')?.focus())

/** A folder picked in the browser joins this world and becomes the repo to start in. */
async function addFolder(path: string) {
  const w = world.value
  if (!w) return
  const r = await updateWorld(w.id, { repos: withRepo(w.repos, path) })
  if (r.ok) { repo.value = path; browsing.value = false } else error.value = r.error
}
async function moveFolder(path: string, fromId: string) {
  const w = world.value
  if (!w) return
  const err = await moveRepo(path, fromId, w.id)
  if (err) error.value = err; else { repo.value = path; browsing.value = false }
}
async function submit() {
  if (sending.value) return
  if (!wid.value) { error.value = 'Pick a world.'; return }
  if (!repo.value) { error.value = 'Pick a folder.'; return }
  sending.value = true; error.value = ''
  const err = await createSession({ worldId: wid.value, repo: repo.value, task: task.value.trim(), worktree: worktree.value && isGit.value !== false, ...modeField(mode.value), ...(isGit.value !== false && branch.value.trim() ? { branch: branch.value.trim() } : {}) })
  sending.value = false
  if (err) error.value = err
  else emit('close')
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div v-if="browsing && world" class="dialog form" role="dialog" aria-modal="true" aria-label="Add a folder">
      <h2>Add a folder to {{ world.name }}</h2>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <FolderBrowser :world-id="world.id" @pick="addFolder" @move="moveFolder" @back="browsing = false" />
    </div>
    <form v-else ref="box" class="dialog form" role="dialog" aria-modal="true" aria-label="New session" @submit.prevent="submit">
      <h2>New session{{ world ? ` in ${world.name}` : '' }}</h2>
      <label v-if="!worldId">World
        <select v-model="wid" aria-label="World"><option value="" disabled>Choose a world</option><option v-for="w in state.worlds" :key="w.id" :value="w.id">{{ w.name }}</option></select>
      </label>
      <div v-if="wid && !world?.repos.length" class="empty-folders">
        <p class="why">This world has no folders yet.</p>
        <button type="button" class="btn" @click="browsing = true">Add a folder</button>
      </div>
      <label v-else-if="wid">Folder
        <select v-model="repo"><option v-for="r in world?.repos ?? []" :key="r" :value="r">{{ baseName(r) }} ({{ r }})</option></select>
      </label>
      <label>Task (optional)
        <textarea v-model="task" placeholder="Leave empty to start a blank session" />
      </label>
      <PermissionSelect v-model="mode" />
      <template v-if="isGit !== false">
        <label class="row"><input v-model="worktree" type="checkbox"> Use a new worktree</label>
        <label>Branch name (optional)
          <input v-model="branch" type="text" placeholder="feat/something" autocomplete="off">
        </label>
      </template>
      <p v-else class="why">Not a git repo, so the session starts right in this folder.</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="btn primary" :disabled="sending || !repo">{{ sending ? 'Starting…' : 'Start' }}</button>
        <button type="button" class="btn" @click="emit('close')">Cancel</button>
      </div>
    </form>
  </div>
</template>
