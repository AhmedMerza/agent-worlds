<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Review } from '../types'
import { baseName, capDiff, diffClass, reviewView } from '../logic'
import { askClaude, acknowledge } from '../store'

const props = defineProps<{ id: string; name: string; branch: string | null; review: Review; agent?: string }>()
const all = ref(false)
const diff = computed(() => capDiff(props.review.diff, 400, all.value))
const v = computed(() => reviewView(props.review))
// A branch far ahead of its base can list thousands of files; drawing them all froze the page.
const LIST_MAX = 50
const more = ref(false)
const cap = <T,>(xs: T[]) => (more.value ? xs : xs.slice(0, LIST_MAX))
const capped = computed(() => !more.value && [v.value.changed, v.value.commits, v.value.uncommitted].some((xs) => xs.length > LIST_MAX))
</script>

<template>
  <p v-if="review.elsewhere && review.dir" class="why rv-where">Worked in <b :title="review.dir">{{ baseName(review.dir) }}</b>{{ review.branch ? ` on ${review.branch}` : '' }}, not the folder it started in.</p>
  <div v-if="v.changed.length" class="rv">
    <span class="lbl">Changed since this session started</span>
    <ul class="files"><li v-for="f in cap(v.changed)" :key="f.path"><span>{{ f.path }}</span><b class="add">+{{ f.added }}</b><b class="del">−{{ f.deleted }}</b></li></ul>
  </div>
  <p v-else-if="!v.commits.length && !v.uncommitted.length && !review.diff" class="why">No files changed since this session started.</p>
  <div v-if="v.commits.length" class="rv">
    <span class="lbl">{{ v.commits.length }} {{ v.commits.length === 1 ? 'commit' : 'commits' }} on {{ review.branch ?? branch ?? 'this branch' }}</span>
    <ul class="commits"><li v-for="c in cap(v.commits)" :key="c.sha"><code>{{ c.sha.slice(0, 7) }}</code> {{ c.subject }}</li></ul>
  </div>
  <div v-if="v.uncommitted.length" class="rv">
    <span class="lbl">Not committed yet ({{ v.uncommitted.length }})</span>
    <ul class="files"><li v-for="f in cap(v.uncommitted)" :key="f.path"><span>{{ f.path }}</span><b class="add">+{{ f.added }}</b><b class="del">−{{ f.deleted }}</b></li></ul>
  </div>
  <button v-if="capped" class="linkbtn" @click="more = true">Show every file and commit</button>
  <p v-if="review.tests" :class="['why', 'review-tests', { bad: !review.tests.ok }]">Tests {{ review.tests.ok ? 'passed' : 'failed' }}: {{ review.tests.line }}</p>
  <details v-if="review.diff"><summary>View the diff</summary>
    <pre class="diff"><span v-for="(l, i) in diff.lines" :key="i" :class="diffClass(l)">{{ l }}{{ '\n' }}</span></pre>
    <button v-if="diff.hidden" class="linkbtn" @click="all = true">Show all ({{ diff.hidden }} more lines)</button>
  </details>
  <div class="actions">
    <button v-if="v.canCommit" class="btn go" @click="askClaude(id, name, '/commit')">Ask {{ agent ?? 'Claude' }} to commit</button>
    <button v-if="v.canMr" class="btn" @click="askClaude(id, name, '/mr-create')">Open MR</button>
    <button class="btn" @click="askClaude(id, name, '/ship-check')">/ship-check</button>
    <button class="btn" @click="acknowledge(id)">Dismiss</button>
  </div>
</template>
