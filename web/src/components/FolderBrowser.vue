<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import type { FsListing } from '../types'
import { browseFs } from '../store'
import { breadcrumbs, cleanPath, visibleEntries } from '../fsbrowser'

const props = defineProps<{ taken: string[] }>()
const emit = defineEmits<{ pick: [path: string]; back: [] }>()
const listing = ref<FsListing | null>(null)
const error = ref('')
const loading = ref(false)
const typed = ref('')
const crumbs = computed(() => (listing.value ? breadcrumbs(listing.value.path) : []))
const entries = computed(() => (listing.value ? visibleEntries(listing.value.entries) : []))

async function go(path: string) {
  loading.value = true; error.value = ''
  const r = await browseFs(path)
  loading.value = false
  if (r.ok) { listing.value = r.data; typed.value = r.data.path } else error.value = r.error
}
onMounted(() => go(''))
</script>

<template>
  <div class="browser">
    <div class="actions"><button class="btn" @click="emit('back')">← Back</button><span class="why">Pick a repo folder to add</span></div>
    <nav class="crumbs" aria-label="Folder breadcrumbs">
      <button v-for="c in crumbs" :key="c.path" class="linkbtn" @click="go(c.path)">{{ c.name }}</button>
    </nav>
    <form class="reply" @submit.prevent="go(cleanPath(typed))">
      <input v-model="typed" class="reply-in" aria-label="Folder path" placeholder="/path/to/folder" autocomplete="off">
      <button class="btn">Go</button>
      <button v-if="typed.trim()" type="button" class="btn primary" @click="emit('pick', cleanPath(typed))">Add this path</button>
    </form>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="loading" class="why">Loading…</p>
    <ul v-else-if="listing" class="fs">
      <li v-if="listing.parent"><button class="linkbtn" @click="go(listing.parent!)">.. (up)</button></li>
      <li v-for="e in entries" :key="e.path" :class="{ repo: e.isRepo }">
        <button class="linkbtn" @click="go(e.path)">{{ e.name }}</button>
        <span v-if="e.isRepo" class="tag">git repo</span>
        <button v-if="e.isRepo" class="btn" :disabled="props.taken.includes(e.path)" @click="emit('pick', e.path)">{{ props.taken.includes(e.path) ? 'Added' : 'Add' }}</button>
      </li>
      <li v-if="!entries.length" class="why">No folders here.</li>
    </ul>
  </div>
</template>
