<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { CaptureItem } from '../types'
import { editCaptureItem, fileCaptureItem } from '../store'
import { canFile, type RepoOption } from '../captures'
import { pop } from '../motion'

const props = defineProps<{ captureId: string; item: CaptureItem; repos: RepoOption[]; open?: boolean }>()
const title = ref(props.item.title)
const body = ref(props.item.body)
const expanded = ref(!!props.open)
const busy = ref(false)
const error = ref('')
const fileBtn = ref<HTMLButtonElement | null>(null)
// The server's copy wins when it changes (another device, or the reply to our own edit).
watch(() => props.item.title, (t) => { title.value = t })
watch(() => props.item.body, (b) => { body.value = b })
const paths = computed(() => props.repos.map((r) => r.path))
const fileable = computed(() => canFile(props.item, paths.value))
const locked = computed(() => props.item.status === 'filing' || props.item.status === 'filed')
const shown = computed(() => error.value || props.item.error || '')

async function save(patch: Parameters<typeof editCaptureItem>[2]) {
  error.value = ''
  const r = await editCaptureItem(props.captureId, props.item.id, patch)
  if (!r.ok) error.value = r.error
}
function saveTitle() {
  const t = title.value.trim()
  if (!t) { title.value = props.item.title; return }
  if (t !== props.item.title) void save({ title: t })
}
function saveBody() { if (body.value !== props.item.body) void save({ body: body.value }) }
async function file() {
  if (busy.value || !fileable.value) return
  busy.value = true; error.value = ''
  // A title still being typed is saved first, so the issue gets what is on screen.
  if (title.value.trim() && title.value.trim() !== props.item.title) await save({ title: title.value.trim() })
  if (body.value !== props.item.body) await save({ body: body.value })
  const r = await fileCaptureItem(props.captureId, props.item.id)
  busy.value = false
  if (!r.ok) error.value = r.error
}
/** The title wraps instead of scrolling sideways: a title you can't read can't be reviewed. */
const titleEl = ref<HTMLTextAreaElement | null>(null)
function fit() { const el = titleEl.value; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px` } }
watch(title, () => void nextTick(fit))
onMounted(() => { fit(); if (props.open) void nextTick(() => fileBtn.value?.focus()) })
// Filed: the badge lands where the buttons were (the secondary reaction to Create issue).
const done = ref<HTMLElement | null>(null)
watch(() => props.item.status, (s, was) => { if (s === 'filed' && was !== 'filed') void nextTick(() => pop(done.value?.querySelector('.badge'))) })
</script>

<template>
  <li :class="['cap-item', item.status]" data-enter-row>
    <div class="cap-row">
      <textarea ref="titleEl" v-model="title" class="cap-title" rows="1" dir="auto" maxlength="250" :disabled="locked || item.status === 'dropped'"
                aria-label="Issue title" @input="fit" @blur="saveTitle" @keydown.enter.prevent="($event.target as HTMLTextAreaElement).blur()" />
      <button class="linkbtn cap-more" :aria-expanded="expanded" @click="expanded = !expanded">{{ expanded ? 'Hide details' : 'Details' }}</button>
    </div>
    <textarea v-if="expanded" v-model="body" class="cap-body" dir="auto" rows="3" maxlength="20000" :disabled="locked || item.status === 'dropped'"
              aria-label="Issue description" placeholder="What is wanted, and why" @blur="saveBody" />

    <div v-if="item.status === 'filed'" ref="done" class="cap-done">
      <span class="badge mgd">Filed</span>
      <a v-if="item.issueUrl" :href="item.issueUrl" :title="item.issueUrl" target="_blank" rel="noopener" class="cap-link" dir="ltr">{{ item.issueUrl.replace(/^https?:\/\//, '') }}</a>
    </div>
    <div v-else-if="item.status === 'dropped'" class="cap-done">
      <span class="badge">Dropped</span>
      <button class="linkbtn" @click="save({ status: 'pending' })">Undo</button>
    </div>
    <template v-else-if="item.status === 'check'">
      <p class="err">Agent Worlds restarted while filing this. Check the project's issues before filing again.</p>
      <div class="actions">
        <button class="btn" @click="save({ status: 'pending' })">It wasn't filed</button>
        <button class="btn" @click="save({ status: 'dropped' })">It was filed</button>
      </div>
    </template>
    <div v-else class="cap-acts">
      <select class="cap-repo" :value="item.repo && paths.includes(item.repo) ? item.repo : ''" :disabled="locked" :aria-invalid="!fileable" aria-label="Project"
              @change="save({ repo: ($event.target as HTMLSelectElement).value || null })">
        <option value="" disabled>Pick a project…</option>
        <option v-for="r in repos" :key="r.path" :value="r.path">{{ r.label }}</option>
      </select>
      <button ref="fileBtn" class="btn primary" :disabled="!fileable || busy || item.status === 'filing'" :title="fileable ? '' : 'Pick a project first'" @click="file">
        {{ item.status === 'filing' || busy ? 'Creating…' : 'Create issue' }}
      </button>
      <button class="btn" :disabled="item.status === 'filing'" @click="save({ status: 'dropped' })">Drop</button>
    </div>
    <p v-if="shown" class="err" role="alert">{{ shown }}</p>
  </li>
</template>
