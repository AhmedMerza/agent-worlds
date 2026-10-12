<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { World } from '../types'
import { state, createWorld, updateWorld, deleteWorld, reorderWorlds, sessionList, moveRepo, showToast } from '../store'
import { PALETTE, deleteWorldText, moveId, nextColor, withRepo, baseName } from '../logic'
import FolderBrowser from './FolderBrowser.vue'

const emit = defineEmits<{ close: [] }>()
const error = ref('')
const newName = ref('')
const browsing = ref<string | null>(null) // world id being given a repo
const confirming = ref<string | null>(null)
const box = ref<HTMLElement | null>(null)
const ids = computed(() => state.worlds.map((w) => w.id))
const sessionsIn = (w: World) => sessionList.value.filter((s) => s.worldId === w.id).length
onMounted(() => box.value?.focus())

async function run(r: Promise<{ ok: boolean; error?: string }>) {
  const res = await r
  error.value = res.ok ? '' : (res as { error: string }).error
  return res.ok
}
const rename = (w: World, name: string) => { const n = name.trim(); if (n && n !== w.name) return run(updateWorld(w.id, { name: n })) }
const recolor = (w: World, color: string) => run(updateWorld(w.id, { color }))
const removeRepo = (w: World, repo: string) => run(updateWorld(w.id, { repos: w.repos.filter((r) => r !== repo) }))
const move = (id: string, dir: -1 | 1) => run(reorderWorlds(moveId(ids.value, id, dir)))
async function addWorld() {
  const name = newName.value.trim()
  if (!name) { error.value = 'Give the world a name.'; return }
  if (await run(createWorld(name, nextColor(state.worlds)))) newName.value = ''
}
async function addRepo(path: string) {
  const w = state.worlds.find((x) => x.id === browsing.value)
  if (!w) return
  if (await run(updateWorld(w.id, { repos: withRepo(w.repos, path) }))) showToast(`Added ${baseName(path)} to ${w.name}.`) // the browser stays open: add several in a row
}
async function moveHere(path: string, fromId: string) {
  const w = state.worlds.find((x) => x.id === browsing.value)
  const from = state.worlds.find((x) => x.id === fromId)
  if (!w) return
  const err = await moveRepo(path, fromId, w.id)
  error.value = err ?? ''
  if (!err) showToast(`Moved ${baseName(path)} from ${from?.name ?? 'its old world'} to ${w.name}.`)
}
async function confirmDelete(w: World) {
  if (await run(deleteWorld(w.id))) confirming.value = null
}
/** Esc: step back one level; returns true when it consumed the key (so the panel stays open). */
function escape(): boolean {
  if (browsing.value) { browsing.value = null; return true }
  if (confirming.value) { confirming.value = null; return true }
  return false
}
defineExpose({ escape })
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div ref="box" class="dialog worlds" role="dialog" aria-modal="true" aria-label="Worlds" tabindex="-1">
      <h2>Worlds</h2>
      <p class="why">A world is a named group of repos. Sessions in those repos show up in its room.</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <FolderBrowser v-if="browsing" :world-id="browsing" @pick="addRepo" @move="moveHere" @back="browsing = null" />

      <template v-else>
        <p v-if="!state.worlds.length" class="why">No worlds yet. Create one below.</p>
        <ul class="wlist">
          <li v-for="(w, i) in state.worlds" :key="w.id" class="winfo" :style="{ '--tint': w.color }">
            <div class="wrow">
              <input class="reply-in" :value="w.name" :aria-label="`Name of ${w.name}`" @change="rename(w, ($event.target as HTMLInputElement).value)" @keydown.enter="($event.target as HTMLInputElement).blur()">
              <button class="btn" :disabled="i === 0" :aria-label="`Move ${w.name} up`" @click="move(w.id, -1)">↑</button>
              <button class="btn" :disabled="i === state.worlds.length - 1" :aria-label="`Move ${w.name} down`" @click="move(w.id, 1)">↓</button>
            </div>
            <div class="swatches" role="group" :aria-label="`Colour of ${w.name}`">
              <button v-for="c in PALETTE" :key="c" class="swatch" :style="{ background: c }" :aria-label="c" :aria-pressed="w.color.toLowerCase() === c" @click="recolor(w, c)" />
            </div>
            <ul class="repos">
              <li v-for="r in w.repos" :key="r"><span class="path" :title="r">{{ baseName(r) }} <small>{{ r }}</small></span><button class="linkbtn" :aria-label="`Remove ${r} from ${w.name}`" @click="removeRepo(w, r)">Remove</button></li>
              <li v-if="!w.repos.length" class="why">No repos yet.</li>
            </ul>
            <div class="actions">
              <button class="btn" @click="browsing = w.id">Add repo</button>
              <button class="btn danger" @click="confirming = w.id">Delete world</button>
            </div>
            <div v-if="confirming === w.id" class="confirm" role="alertdialog">
              <p class="why">{{ deleteWorldText(w.name, sessionsIn(w)) }}</p>
              <div class="actions"><button class="btn danger" @click="confirmDelete(w)">Delete world</button><button class="btn" @click="confirming = null">Cancel</button></div>
            </div>
          </li>
        </ul>
        <form class="reply" @submit.prevent="addWorld">
          <input v-model="newName" class="reply-in" aria-label="New world name" placeholder="New world name" autocomplete="off">
          <button class="btn primary">New world</button>
        </form>
      </template>
      <div class="actions" style="margin-top:12px"><button class="btn" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
