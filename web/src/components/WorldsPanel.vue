<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { World } from '../types'
import { state, createWorld, updateWorld, deleteWorld, reorderWorlds, sessionList, moveRepo, showToast, fetchAgents, saveSpawnAgents, type AgentInfo, type SpawnAgents } from '../store'
import { PALETTE, deleteWorldText, moveId, nextColor, withRepo, baseName, maxSpawnedOf } from '../logic'
import FolderBrowser from './FolderBrowser.vue'

const emit = defineEmits<{ close: [] }>()
const error = ref('')
const newName = ref('')
const browsing = ref<string | null>(null) // world id being given a repo
const confirming = ref<string | null>(null)
const box = ref<HTMLElement | null>(null)
const ids = computed(() => state.worlds.map((w) => w.id))
const sessionsIn = (w: World) => sessionList.value.filter((s) => s.worldId === w.id).length
onMounted(async () => {
  box.value?.focus()
  const r = await fetchAgents()
  if (r.ok) { agents.value = r.data.agents.filter((a) => a.installed); spawnAgents.value = r.data.spawn ?? null }
})
/** Which agents (and models) leads in any world may start their workers on. */
const agents = ref<AgentInfo[]>([])
const spawnAgents = ref<SpawnAgents>(null)
const spawnOn = (id: string) => !spawnAgents.value || id in spawnAgents.value
/** Models of an agent turned off, so turning it back on doesn't quietly widen it to any model. */
const kept: Record<string, string[]> = {}
const modelsOf = (id: string) => (spawnAgents.value?.[id] ?? kept[id])?.join(', ') ?? ''
const noneOn = computed(() => agents.value.length > 0 && agents.value.every((a) => !spawnOn(a.id)))
/** What leads may use now, in words, for the saved toast. */
function spawnSummary(s: SpawnAgents) {
  if (!s) return 'leads may start workers on any agent and model'
  const on = agents.value.filter((a) => a.id in s).map((a) => `${a.name}${s[a.id].length ? ` (${s[a.id].join(', ')})` : ''}`)
  return on.length ? `leads may start workers on ${on.join(', ')}` : 'leads may not start workers on any agent'
}
async function setSpawn(el: HTMLInputElement, id: string, on: boolean, models?: string) {
  const next: Record<string, string[]> = spawnAgents.value ? { ...spawnAgents.value } : Object.fromEntries(agents.value.map((a) => [a.id, []]))
  if (!on) { kept[id] = next[id] ?? []; delete next[id] }
  else next[id] = models === undefined ? next[id] ?? kept[id] ?? [] : models.split(/[\s,]+/).filter(Boolean)
  const res = await saveSpawnAgents(next)
  error.value = res.ok ? '' : (res as { error: string }).error
  if (!res.ok) { if (el.type === 'checkbox') el.checked = spawnOn(id); else el.value = modelsOf(id); return }
  spawnAgents.value = res.data.spawn
  showToast(`Saved: ${spawnSummary(res.data.spawn)}.`)
}

async function run(r: Promise<{ ok: boolean; error?: string }>) {
  const res = await r
  error.value = res.ok ? '' : (res as { error: string }).error
  return res.ok
}
const rename = (w: World, name: string) => { const n = name.trim(); if (n && n !== w.name) return run(updateWorld(w.id, { name: n })) }
/** The name being typed: kept while the box has focus, so a worlds update from another tab or phone can't reset it. */
const draft = ref<{ id: string; text: string } | null>(null)
const recolor = (w: World, color: string) => run(updateWorld(w.id, { color }))
const allowSpawn = (w: World, on: boolean) => run(updateWorld(w.id, { leadSpawn: on }))
function capSpawn(w: World, raw: string) {
  const n = maxSpawnedOf(raw)
  if (n !== null) return run(updateWorld(w.id, { maxSpawned: n }))
  error.value = 'The limit must be a whole number, 0 or more.'
}
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
      <h2>Manage worlds</h2>
      <p class="why">A world is a named group of repos. Sessions in those repos show up in its room. Rename, recolour, reorder or delete each one here. Where sessions may start their own workers, a lead session builds its own team instead of asking you to start each one.</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <FolderBrowser v-if="browsing" :world-id="browsing" @pick="addRepo" @move="moveHere" @back="browsing = null" />

      <template v-else>
        <fieldset v-if="agents.length" class="spawn-agents">
          <legend>Which agents leads may give work to (all worlds)</legend>
          <p class="why">A lead session can start its own worker sessions. Untick an agent to keep leads off it, e.g. to save Claude usage by sending workers to Codex. Name the models a lead may pick (like haiku, sonnet), or leave the box empty for any. Changes save at once.</p>
          <div v-for="a in agents" :key="a.id" class="spawn">
            <label><input type="checkbox" :checked="spawnOn(a.id)" @change="setSpawn($event.target as HTMLInputElement, a.id, ($event.target as HTMLInputElement).checked)"> {{ a.name }}</label>
            <input v-if="a.models" class="reply-in" :value="modelsOf(a.id)" :disabled="!spawnOn(a.id)" placeholder="any model" :aria-label="`Models leads may start ${a.name} on`" @change="setSpawn($event.target as HTMLInputElement, a.id, true, ($event.target as HTMLInputElement).value)">
            <small v-else class="why">uses its own model</small>
          </div>
          <p v-if="noneOn" class="err" role="status">With every agent off, leads cannot start any workers.</p>
        </fieldset>
        <p v-if="!state.worlds.length" class="why">No worlds yet. Create one below.</p>
        <ul class="wlist">
          <li v-for="(w, i) in state.worlds" :key="w.id" class="winfo" :style="{ '--tint': w.color }">
            <label class="soon" :for="`wname-${w.id}`">Name (click to rename)</label>
            <div class="wrow">
              <input :id="`wname-${w.id}`" class="reply-in wname" :value="draft?.id === w.id ? draft.text : w.name" @focus="draft = { id: w.id, text: w.name }" @input="draft = { id: w.id, text: ($event.target as HTMLInputElement).value }" @blur="draft = null" :aria-label="`Name of ${w.name}`" @change="rename(w, ($event.target as HTMLInputElement).value)" @keydown.enter="($event.target as HTMLInputElement).blur()">
              <button class="btn" :disabled="i === 0" :aria-label="`Move ${w.name} up`" @click="move(w.id, -1)">↑</button>
              <button class="btn" :disabled="i === state.worlds.length - 1" :aria-label="`Move ${w.name} down`" @click="move(w.id, 1)">↓</button>
            </div>
            <div class="swatches" role="group" :aria-label="`Colour of ${w.name}`">
              <button v-for="c in PALETTE" :key="c" class="swatch" :style="{ background: c }" :aria-label="c" :aria-pressed="w.color.toLowerCase() === c" @click="recolor(w, c)" />
            </div>
            <div class="spawn">
              <label><input type="checkbox" :checked="!!w.leadSpawn" @change="allowSpawn(w, ($event.target as HTMLInputElement).checked)"> Sessions here may start and end their own workers</label>
              <label v-if="w.leadSpawn">at most <input class="reply-in num" type="number" min="0" :value="w.maxSpawned ?? 6 /* the server's MAX_SPAWNED */" :aria-label="`Most worker sessions in ${w.name} may start at once`" @change="capSpawn(w, ($event.target as HTMLInputElement).value)"> at once</label>
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
