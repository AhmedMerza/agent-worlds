<script setup lang="ts">
import type { Card } from '../types'

defineProps<{ card: Extract<Card, { kind: 'question' }>; showQuestion?: boolean }>()
</script>

<template>
  <div v-for="q in card.questions" :key="q.question" class="ro">
    <p v-if="showQuestion || card.questions.length > 1" class="why">{{ q.header ? q.header + ': ' : '' }}{{ q.question }}</p>
    <ol v-if="q.options.length" class="ro-opts"><li v-for="o in q.options" :key="o.label"><b>{{ o.label }}</b><small v-if="o.description" class="why">{{ o.description }}</small></li></ol>
  </div>
</template>
