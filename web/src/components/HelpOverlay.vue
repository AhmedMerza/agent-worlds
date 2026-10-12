<script setup lang="ts">
import { onMounted, ref } from 'vue'
defineEmits<{ close: [] }>()
const box = ref<HTMLElement | null>(null)
onMounted(() => box.value?.focus())
const rows: [string, string][] = [
  ['Space', 'Jump to the next session that needs you (queue order)'],
  ['1 – 9', 'Select the session with that number (the small number on each chip)'],
  ['N', 'New task in the selected session\'s world'],
  ['M', 'Mute or unmute the alert sound'],
  ['?', 'Show this list'],
  ['Esc', 'Close this list or any dialog'],
]
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div ref="box" class="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabindex="-1">
      <h2>Keyboard shortcuts</h2>
      <dl class="keys"><template v-for="[k, d] in rows" :key="k"><dt><kbd>{{ k }}</kbd></dt><dd>{{ d }}</dd></template></dl>
      <p class="why">Shortcuts pause while you type in the terminal or a field.</p>
      <div class="actions"><button class="btn primary" @click="$emit('close')">Close</button></div>
    </div>
  </div>
</template>
