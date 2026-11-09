<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ChangedFile } from '../types'
import { baseName, changeSummary, diffLines, isViewed, nameOf, sharedFiles, splitRows } from '../logic'
import { sessionChanges, sessionFileDiff, setViewed, state } from '../store'

/** What one session changed since it started: files on the left, the picked file's diff on the right (one at a time on a phone). */
const props = defineProps<{ id: string }>()
const emit = defineEmits<{ close: [] }>()
const s = computed(() => state.sessions[props.id])
const files = computed(() => s.value?.changes?.files ?? [])
const groups = computed(() => [
  { label: 'Not committed yet', items: files.value.filter((f) => f.uncommitted) },
  { label: 'Committed', items: files.value.filter((f) => !f.uncommitted) },
].filter((g) => g.items.length))
const order = computed(() => groups.value.flatMap((g) => g.items))
const sum = computed(() => (s.value ? changeSummary(s.value) : null))
const shared = computed(() => (s.value ? sharedFiles(s.value, state.sessions) : new Map<string, string[]>()))

const loading = ref(true)
const error = ref<string | null>(null)
onMounted(async () => {
  const r = await sessionChanges(props.id)
  loading.value = false
  if (!r.ok) error.value = r.error
  pick(order.value.find((f) => s.value && !isViewed(s.value, f)) ?? order.value[0] ?? null)
})

const picked = ref<string | null>(null)
const file = computed(() => files.value.find((f) => f.path === picked.value) ?? null)
const diff = ref<string | null>(null)
const diffError = ref<string | null>(null)
let asked = 0
async function load(f: ChangedFile) {
  const n = ++asked
  diffError.value = null
  const r = await sessionFileDiff(props.id, f.path)
  if (n !== asked) return // a later pick won
  if (r.ok) diff.value = r.data.diff; else { diff.value = null; diffError.value = r.error }
}
function pick(f: ChangedFile | null) { picked.value = f?.path ?? null; diff.value = null; if (f) void load(f) }
// The agent edited the open file again: show the new version.
watch(() => file.value?.sig, (sig, was) => { if (sig && was && sig !== was && file.value) void load(file.value) })

const SPLIT_KEY = 'aw-diff-split'
const split = ref((() => { try { return localStorage.getItem(SPLIT_KEY) === '1' } catch { return false } })())
// Two columns of code do not fit a phone: it always gets the unified view.
const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches
const sideBySide = computed(() => split.value && !narrow)
watch(split, (v) => { try { localStorage.setItem(SPLIT_KEY, v ? '1' : '0') } catch { /* not remembered */ } })

const LINES_MAX = 3000
// A 1 MB diff is tens of thousands of rows: show it a chunk at a time, not all at once.
const limit = ref(LINES_MAX)
watch(picked, () => { limit.value = LINES_MAX })
const lines = computed(() => (diff.value === null ? [] : diffLines(diff.value)))
const shownLines = computed(() => lines.value.slice(0, limit.value))
const rows = computed(() => splitRows(shownLines.value))

const viewed = (f: ChangedFile) => !!s.value && isViewed(s.value, f)
async function toggleViewed(f: ChangedFile, e: Event) {
  const box = e.target as HTMLInputElement
  const on = !viewed(f)
  const ok = await setViewed(props.id, f.path, on)
  // The box shows what was saved, not the click: a failed save, or the server's update arriving later, must not leave it wrong.
  box.checked = ok ? on : viewed(f)
  if (!ok || !on || f.path !== picked.value) return
  // Ticking the open file moves on to the next one you have not seen, as in a PR review.
  const i = order.value.findIndex((x) => x.path === f.path)
  const next = [...order.value.slice(i + 1), ...order.value.slice(0, i)].find((x) => x.path !== f.path && !viewed(x))
  if (next) pick(next)
}
const step = (d: 1 | -1) => { const i = order.value.findIndex((f) => f.path === picked.value); const f = order.value[i + d]; if (f) pick(f) }
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '')
const n = (x: number) => x.toLocaleString('en')
const STATUS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed' } as const
</script>

<template>
  <div class="overlay ch-overlay" @click.self="emit('close')">
    <div :class="['dialog', 'changes', { reading: picked }]" role="dialog" aria-modal="true" :aria-label="`Changes in ${s ? nameOf(s) : 'this session'}`">
      <header class="ch-head">
        <div>
          <h2>Changes<template v-if="s"> · {{ nameOf(s) }}</template></h2>
          <p class="why">
            <template v-if="sum">{{ n(sum.files) }} {{ sum.files === 1 ? 'file' : 'files' }} <b class="add">+{{ n(sum.added) }}</b> <b class="del">−{{ n(sum.deleted) }}</b> · {{ sum.unseen ? `${sum.unseen} not viewed` : 'all viewed' }} · </template>
            since this session started<template v-if="s?.branch"> on <code>{{ s.branch }}</code></template>
          </p>
        </div>
        <div v-if="!narrow" class="seg" role="group" aria-label="Diff layout">
          <button :aria-pressed="!split" @click="split = false">Unified</button>
          <button :aria-pressed="split" @click="split = true">Side by side</button>
        </div>
        <button class="hq-x" aria-label="Close" @click="emit('close')">×</button>
      </header>

      <p v-if="!s" class="why">This session has ended.</p>
      <p v-else-if="loading && !files.length" class="why">Loading…</p>
      <p v-else-if="error && !files.length" class="err" role="alert">{{ error }}</p>
      <p v-else-if="!files.length" class="why">No files changed since this session started.</p>
      <div v-else class="ch-body">
        <nav class="ch-list" aria-label="Changed files">
          <section v-for="g in groups" :key="g.label">
            <span class="lbl">{{ g.label }} ({{ g.items.length }})</span>
            <ul>
              <li v-for="f in g.items" :key="f.path" :class="{ on: f.path === picked, seen: viewed(f) }">
                <label class="ch-tick" :title="`Mark ${baseName(f.path)} as viewed`"><input type="checkbox" :checked="viewed(f)" :aria-label="`Mark ${f.path} as viewed`" @change="toggleViewed(f, $event)"></label>
                <button class="ch-file" :aria-current="f.path === picked ? 'true' : undefined" :title="f.from ? `${f.from} → ${f.path}` : f.path" @click="pick(f)">
                  <span :class="['ch-st', f.status]" :title="STATUS[f.status]" :aria-label="STATUS[f.status]">{{ f.status }}</span>
                  <span class="ch-name"><span class="ch-dir">{{ dirOf(f.path) }}</span><span class="ch-base">{{ baseName(f.path) }}</span></span>
                  <span v-if="shared.has(f.path)" class="ch-shared" role="img" :title="`Also changed by ${shared.get(f.path)!.join(', ')}`" :aria-label="`Also changed by ${shared.get(f.path)!.join(', ')}`">⚠</span>
                  <span class="ch-n"><b class="add">+{{ n(f.added) }}</b> <b class="del">−{{ n(f.deleted) }}</b></span>
                </button>
              </li>
            </ul>
          </section>
          <p v-if="s.changes?.more" class="why">And {{ s.changes.more }} more files not listed.</p>
        </nav>

        <section class="ch-diff">
          <template v-if="file">
            <div class="ch-fhead">
              <button class="btn ch-back" @click="picked = null">‹ Files</button>
              <code class="ch-path"><template v-if="file.from"><template v-for="(seg, i) in file.from.split('/')" :key="'f' + i"><template v-if="i">/</template><bdi>{{ seg }}</bdi></template> → </template><template v-for="(seg, i) in file.path.split('/')" :key="i"><template v-if="i">/</template><bdi>{{ seg }}</bdi></template></code>
              <label class="ch-viewed"><input :key="file.path" type="checkbox" :checked="viewed(file)" @change="toggleViewed(file, $event)"> Viewed</label>
              <button class="btn" :disabled="order[0]?.path === file.path" aria-label="Previous file" @click="step(-1)">‹</button>
              <button class="btn" :disabled="order.at(-1)?.path === file.path" aria-label="Next file" @click="step(1)">›</button>
            </div>
            <p v-if="shared.has(file.path)" class="conflicts">⚠ Also changed by <template v-for="(who, i) in shared.get(file.path)!" :key="i"><template v-if="i">, </template><bdi>{{ who }}</bdi></template>. Merging both will likely conflict here.</p>
            <p v-if="diffError" class="err" role="alert">{{ diffError }} <button class="linkbtn" @click="load(file)">Try again</button></p>
            <p v-else-if="diff === null" class="why" aria-live="polite">Loading…</p>
            <p v-else-if="!lines.length" class="why">{{ file.status === 'R' ? 'Renamed with no change to its content.' : 'No text change to show (an empty file or a mode change).' }}</p>
            <div v-else class="ch-scroll">
              <table v-if="!sideBySide" class="ch-table">
                <tbody>
                  <tr v-for="(l, i) in shownLines" :key="i" :class="l.kind">
                    <template v-if="l.kind === 'hunk' || l.kind === 'note'"><td colspan="3">{{ l.kind === 'hunk' ? `@@ ${l.text}` : l.text }}</td></template>
                    <template v-else><td class="ln">{{ l.old ?? '' }}</td><td class="ln">{{ l.new ?? '' }}</td><td class="code"><span class="sign" aria-hidden="true">{{ l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ' }}</span>{{ l.text }}</td></template>
                  </tr>
                </tbody>
              </table>
              <table v-else class="ch-table split">
                <colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup>
                <tbody>
                  <tr v-for="(r, i) in rows" :key="i" :class="'hunk' in r ? 'hunk' : 'note' in r ? 'note' : ''">
                    <template v-if="'hunk' in r"><td colspan="4">@@ {{ r.hunk }}</td></template>
                    <template v-else-if="'note' in r"><td colspan="4">{{ r.note }}</td></template>
                    <template v-else>
                      <td class="ln">{{ r.left?.old ?? '' }}</td><td :class="['code', r.left ? (r.left.kind === 'del' ? 'del' : '') : 'gap']">{{ r.left?.text ?? '' }}</td>
                      <td class="ln">{{ r.right?.new ?? '' }}</td><td :class="['code', r.right ? (r.right.kind === 'add' ? 'add' : '') : 'gap']">{{ r.right?.text ?? '' }}</td>
                    </template>
                  </tr>
                </tbody>
              </table>
              <button v-if="lines.length > limit" class="linkbtn" @click="limit += LINES_MAX">Show {{ n(Math.min(LINES_MAX, lines.length - limit)) }} more lines ({{ n(lines.length - limit) }} left)</button>
            </div>
          </template>
          <p v-else class="why ch-pick">Pick a file to see what changed.</p>
        </section>
      </div>
    </div>
  </div>
</template>
