<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { SavedRules } from '../types'
import { deleteSavedRule, fetchSavedRules, showToast } from '../store'

const emit = defineEmits<{ close: [] }>()
const box = ref<HTMLElement | null>(null)
const saved = ref<SavedRules | null>(null)
const error = ref('')
const busy = ref(false)
const confirming = ref<{ worldId: string; rule: string } | null>(null)
const anyRules = computed(() => !!saved.value && (saved.value.global.length > 0 || saved.value.worlds.some((w) => w.repos.some((r) => r.rules.length)) || saved.value.other.some((r) => r.rules.length)))
const worldRules = (repos: SavedRules['other']) => [...new Set(repos.flatMap((r) => r.rules))]

async function load() {
  const result = await fetchSavedRules()
  if (result.ok) { saved.value = result.data; error.value = '' }
  else error.value = result.error
}
async function remove(body: { scope: 'all' | 'world' | 'repo'; rule: string; worldId?: string; repo?: string }) {
  busy.value = true
  const result = await deleteSavedRule(body)
  if (result.ok) {
    confirming.value = null
    showToast(result.data.removed ? 'Saved permission removed.' : 'That rule was already removed.')
    await load()
  } else error.value = result.error
  busy.value = false
}
onMounted(() => { box.value?.focus(); void load() })
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div ref="box" class="dialog saved-permissions" role="dialog" aria-modal="true" aria-label="Saved permissions" tabindex="-1">
      <h2>Saved permissions</h2>
      <p class="why">Rules saved in Claude settings. Removing one affects future requests; a running session may keep an allowance until it restarts.</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="!saved && !error" class="why">Loading…</p>
      <template v-if="saved">
        <p v-if="!anyRules" class="why empty-rules">No saved allow rules in the listed locations.</p>
        <section v-if="saved.global.length" class="rule-scope">
          <h3>Everywhere</h3>
          <p class="why">Your Claude user settings</p>
          <ul class="rule-list"><li v-for="rule in saved.global" :key="rule"><code>{{ rule }}</code><button class="linkbtn" :disabled="busy" :aria-label="`Remove ${rule} from everywhere`" @click="remove({ scope: 'all', rule })">Remove</button></li></ul>
        </section>
        <section v-for="world in saved.worlds.filter((w) => w.repos.some((r) => r.rules.length))" :key="world.id" class="rule-scope">
          <h3>{{ world.name }}</h3>
          <p class="why">Stored separately in each repo. You can remove a rule from one repo or all repos in this world.</p>
          <div v-for="repo in world.repos.filter((r) => r.rules.length)" :key="repo.repo" class="rule-repo">
            <h4 :title="repo.repo">{{ repo.repo }}</h4>
            <ul class="rule-list"><li v-for="rule in repo.rules" :key="rule"><code>{{ rule }}</code><button class="linkbtn" :disabled="busy" :aria-label="`Remove ${rule} from ${repo.repo}`" @click="remove({ scope: 'repo', repo: repo.repo, rule })">Remove from repo</button></li></ul>
          </div>
          <div class="world-rule-actions" v-for="rule in worldRules(world.repos)" :key="rule">
            <template v-if="confirming?.worldId === world.id && confirming.rule === rule">
              <p class="why">Remove <code>{{ rule }}</code> from every repo in {{ world.name }}?</p>
              <button class="btn danger" :disabled="busy" @click="remove({ scope: 'world', worldId: world.id, rule })">Remove from all repos</button>
              <button class="btn" @click="confirming = null">Cancel</button>
            </template>
            <button v-else class="linkbtn" :disabled="busy" @click="confirming = { worldId: world.id, rule }">Remove {{ rule }} from all repos in {{ world.name }}</button>
          </div>
        </section>
        <section v-if="saved.other.some((r) => r.rules.length)" class="rule-scope">
          <h3>Other active repos</h3>
          <div v-for="repo in saved.other.filter((r) => r.rules.length)" :key="repo.repo" class="rule-repo">
            <h4 :title="repo.repo">{{ repo.repo }}</h4>
            <ul class="rule-list"><li v-for="rule in repo.rules" :key="rule"><code>{{ rule }}</code><button class="linkbtn" :disabled="busy" :aria-label="`Remove ${rule} from ${repo.repo}`" @click="remove({ scope: 'repo', repo: repo.repo, rule })">Remove from repo</button></li></ul>
          </div>
        </section>
      </template>
      <div class="actions" style="margin-top:16px"><button class="btn" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
