<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MODE_HELP, modeOptions, type ModeChoice } from '../logic'
import { fetchClaudeDefault } from '../store'

const model = defineModel<ModeChoice>({ required: true })
withDefaults(defineProps<{ label?: string }>(), { label: 'Permissions' })
const claudeDefault = ref<string | null>(null)
const options = computed(() => modeOptions(claudeDefault.value))
onMounted(async () => { claudeDefault.value = await fetchClaudeDefault() })
</script>

<template>
  <label class="perm">{{ label }}
    <select v-model="model" :aria-label="label"><option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option></select>
    <span class="why">{{ MODE_HELP[model] }}</span>
  </label>
</template>
