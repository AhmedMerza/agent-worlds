<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Review } from '../types'
import { capDiff, diffClass } from '../logic'
import { sendInput, acknowledge } from '../store'

const props = defineProps<{ id: string; review: Review }>()
const all = ref(false)
const diff = computed(() => capDiff(props.review.diff, 400, all.value))
const cmds: [string, string][] = [['Commit', '/commit'], ['Open MR', '/mr-create'], ['/ship-check', '/ship-check']]
</script>

<template>
  <ul class="files"><li v-for="f in review.files" :key="f.path"><span>{{ f.path }}</span><b class="add">+{{ f.added }}</b><b class="del">−{{ f.deleted }}</b></li></ul>
  <p v-if="review.tests" :class="['why', 'review-tests', { bad: !review.tests.ok }]">Tests {{ review.tests.ok ? 'passed' : 'failed' }}: {{ review.tests.line }}</p>
  <details v-if="review.diff"><summary>View the diff</summary>
    <pre class="diff"><span v-for="(l, i) in diff.lines" :key="i" :class="diffClass(l)">{{ l }}{{ '\n' }}</span></pre>
    <button v-if="diff.hidden" class="linkbtn" @click="all = true">Show all ({{ diff.hidden }} more lines)</button>
  </details>
  <div class="actions">
    <button v-for="[label, text] in cmds" :key="text" :class="['btn', { go: text === '/commit' }]" @click="sendInput(id, text)">{{ label }}</button>
    <button class="btn" @click="acknowledge(id)">Done, no action</button>
  </div>
</template>
