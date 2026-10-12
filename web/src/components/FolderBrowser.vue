<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import type { FsListing } from '../types'
import { browseFs, state } from '../store'
import { breadcrumbs, cleanPath, repoStatus, visibleEntries } from '../fsbrowser'

/** Browses for repos to put into world `worldId`. Stays open: the parent decides when to leave. */
const props = defineProps<{ worldId: string }>()
const emit = defineEmits<{ pick: [path: string]; move: [path: string, fromWorldId: string]; back: [] }>()
const listing = ref<FsListing | null>(null)
const error = ref('')
const loading = ref(false)
const typed = ref('')
/** Which folders we have seen listed, and whether they are repos (a listing does not say so about its own folder). */
const known = ref<Record<string, boolean>>({})
const crumbs = computed(() => (listing.value ? breadcrumbs(listing.value.path) : []))
const entries = computed(() => (listing.value ? visibleEntries(listing.value.entries) : []))
const here = computed(() => (listing.value && known.value[listing.value.path] ? listing.value.path : null))
const status = (path: string) => repoStatus(path, props.worldId, state.worlds)
const other = (path: string) => { const s = status(path); return s.kind === 'elsewhere' ? s : null }

const learn = (l: FsListing) => { for (const e of l.entries) known.value[e.path] = e.isRepo }
async function go(path: string) {
  loading.value = true; error.value = ''
  const r = await browseFs(path)
  if (r.ok) {
    listing.value = r.data; typed.value = r.data.path; learn(r.data)
    if (!(r.data.path in known.value) && r.data.parent) { const p = await browseFs(r.data.parent); if (p.ok) learn(p.data) }
  } else error.value = r.error
  loading.value = false
}
onMounted(() => go(''))
</script>

<template>
  <div class="browser">
    <div class="actions"><button class="btn" @click="emit('back')">← Back</button><span class="why">Pick the repo folders to add. You can add several.</span></div>
    <nav class="crumbs" aria-label="Folder breadcrumbs">
      <button v-for="c in crumbs" :key="c.path" class="linkbtn" @click="go(c.path)">{{ c.name }}</button>
    </nav>
    <form class="reply" @submit.prevent="go(cleanPath(typed))">
      <input v-model="typed" class="reply-in" aria-label="Folder path" placeholder="/path/to/folder" autocomplete="off">
      <button class="btn primary">Go</button>
    </form>
    <div v-if="here" class="here">
      <span class="path">{{ here }}</span><span class="tag">git repo</span>
      <span v-if="status(here).kind === 'added'" class="why">Added</span>
      <template v-else-if="other(here)">
        <button class="btn" disabled>In {{ other(here)!.worldName }}</button>
        <button class="btn" @click="emit('move', here, other(here)!.worldId)">Move here</button>
      </template>
      <button v-else class="btn" @click="emit('pick', here)">Add this path</button>
    </div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="loading" class="why">Loading…</p>
    <ul v-else-if="listing" class="fs">
      <li v-if="listing.parent"><button class="linkbtn" @click="go(listing.parent!)">.. (up)</button></li>
      <li v-for="e in entries" :key="e.path" :class="{ repo: e.isRepo }">
        <button class="linkbtn" @click="go(e.path)">{{ e.name }}</button>
        <span v-if="e.isRepo" class="tag">git repo</span>
        <template v-if="e.isRepo">
          <span v-if="status(e.path).kind === 'added'" class="why end">Added</span>
          <template v-else-if="other(e.path)">
            <button class="btn end" disabled>In {{ other(e.path)!.worldName }}</button>
            <button class="btn" @click="emit('move', e.path, other(e.path)!.worldId)">Move here</button>
          </template>
          <button v-else class="btn end" @click="emit('pick', e.path)">Add</button>
        </template>
      </li>
      <li v-if="!entries.length" class="why">No folders here.</li>
    </ul>
  </div>
</template>
