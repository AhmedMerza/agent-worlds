<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MODE_HELP, modeOptions, type ModeChoice } from '../logic'
import { fetchClaudeDefault } from '../store'

const model = defineModel<ModeChoice>({ required: true })
const claudeDefault = ref<string | null>(null)
const options = computed(() => modeOptions(claudeDefault.value))
onMounted(async () => { claudeDefault.value = await fetchClaudeDefault() })
</script>

<template>
  <label class="perm">Permissions
    <select v-model="model" aria-label="Permissions"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>
    <span class="why">{{ MODE_HELP[model] }}</span>
  </label>
</template>
