<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { isTouch } from '../logic'
defineEmits<{ close: [] }>()
const box = ref<HTMLElement | null>(null)
onMounted(() => box.value?.focus())
const touch = isTouch()
const all: [string, string][] = [
  ['Space', 'Jump to the next session that needs you (queue order)'],
  ['1 – 9', 'Select the session with that number (the small number on each chip)'],
  ['N', 'New session in the selected session\'s world'],
  ['R', 'Recent sessions: resume one, including sessions started before Agent Worlds'],
  ['C', 'Catch me up on the selected session (Haiku reads its transcript)'],
  ['W', 'Open the Worlds panel (create, rename, reorder, delete)'],
  ['M', 'Mute or unmute the alert sound'],
  ['Ctrl+]', 'Leave the terminal and get the shortcuts back (Esc still goes to Claude)'],
  ['?', 'Show this list'],
  ['Esc', 'Close this list or any dialog'],
]
const rows = touch ? all.filter(([k]) => k !== 'Ctrl+]') : all
</script>

<template>
  <div class="overlay" @click.self="$emit('close')">
    <div ref="box" class="dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" tabindex="-1">
      <h2>Keyboard shortcuts</h2>
      <dl class="keys"><template v-for="[k, d] in rows" :key="k"><dt><kbd>{{ k }}</kbd></dt><dd>{{ d }}</dd></template></dl>
      <p class="why">Shortcuts pause while you type in the terminal or a field. {{ touch ? 'Tap outside the terminal to leave it.' : 'Press Ctrl+] to leave the terminal.' }}</p>
      <div class="actions"><button class="btn primary" @click="$emit('close')">Close</button></div>
    </div>
  </div>
</template>
