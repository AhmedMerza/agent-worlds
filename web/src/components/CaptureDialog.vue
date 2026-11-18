<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watchEffect } from 'vue'
import { captureTranscript, deleteCapture, retryCapture, state, uploadCapture } from '../store'
import { ageText } from '../logic'
import { clock, inbox, recordingName, repoOptions, stageText, OPEN } from '../captures'
import CaptureItemRow from './CaptureItemRow.vue'
import { enterRow, leaveRow, openOverlay } from '../motion'

const emit = defineEmits<{ close: [] }>()
const repos = computed(() => repoOptions(state.worlds))
/** In-page recording needs a secure context: this computer (localhost) or https. A phone over http records with its own app. */
const canRecord = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined'
const fromRepo = computed(() => (state.selectedId ? state.sessions[state.selectedId]?.repo : null) ?? null)

const busyCapture = Object.values(state.captures).filter((c) => c.status === 'transcribing' || c.status === 'extracting').sort((a, b) => b.createdAt - a.createdAt)[0]
/** The capture shown on top: the one just sent, or one still being processed when the dialog opens. */
const currentId = ref<string | null>(busyCapture?.id ?? null)
const current = computed(() => (currentId.value ? state.captures[currentId.value] : undefined))
/** Inbox items seen while the dialog is open stay listed until it closes, so filing one shows its result instead of making it vanish. */
const seen = reactive(new Set<string>())
const rest = computed(() => inbox(state.captures, currentId.value ?? undefined, seen, state.now))
watchEffect(() => { for (const r of rest.value) if (!seen.has(r.item.id)) seen.add(r.item.id) })
const restGroups = computed(() => {
  const g: { id: string; createdAt: number; rows: typeof rest.value }[] = []
  for (const r of rest.value) {
    if (g.at(-1)?.id !== r.capture.id) g.push({ id: r.capture.id, createdAt: r.capture.createdAt, rows: [] })
    g.at(-1)!.rows.push(r)
  }
  return g
})
const failed = computed(() => Object.values(state.captures).filter((c) => c.status === 'failed' && c.id !== currentId.value).sort((a, b) => b.createdAt - a.createdAt))
const waiting = computed(() => rest.value.filter((r) => r.item.status !== 'filed' && r.item.status !== 'dropped').length + failed.value.length)
const openCount = computed(() => current.value?.items.filter((i) => OPEN.includes(i.status)).length ?? 0)

const phase = ref<'idle' | 'starting' | 'recording' | 'uploading'>('idle')
const error = ref('')
const elapsed = ref(0)
let rec: MediaRecorder | null = null
let chunks: Blob[] = []
let started = 0
let tick: number | undefined
let keep = true

/** Set on unmount: a mic prompt answered after the dialog closed must not start a recorder nobody can stop. */
let gone = false
async function startRecording() {
  if (phase.value !== 'idle') return
  error.value = ''; phase.value = 'starting'
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (gone || phase.value !== 'starting') { stream.getTracks().forEach((t) => t.stop()); return }
    rec = new MediaRecorder(stream)
    chunks = []; keep = true
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      clearInterval(tick)
      const type = rec?.mimeType || chunks[0]?.type || 'audio/webm'
      rec = null
      if (keep && chunks.length) void send(new Blob(chunks, { type }), recordingName(type))
      else phase.value = 'idle'
    }
    rec.start(1000)
    started = Date.now(); elapsed.value = 0
    tick = window.setInterval(() => { elapsed.value = Date.now() - started }, 250)
    phase.value = 'recording'
  } catch (e) {
    phase.value = 'idle'
    error.value = (e as Error).name === 'NotAllowedError' ? 'The browser was not allowed to use the microphone. Allow it in the address bar, or choose a recording instead.' : (e as Error).name === 'NotFoundError' ? 'No microphone found. Plug one in, or choose a recording instead.' : `Could not start recording (${(e as Error).message}). Choose a recording instead.`
  }
}
function stopRecording(use: boolean) { keep = use; if (rec?.state === 'recording') rec.stop() }

const picker = ref<HTMLInputElement | null>(null)
const phoneRecorder = ref<HTMLInputElement | null>(null)
function picked(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) void send(f, f.name || recordingName(f.type))
}

async function send(audio: Blob, name: string) {
  phase.value = 'uploading'; error.value = ''
  const r = await uploadCapture(audio, name, fromRepo.value)
  phase.value = 'idle'
  if (!r.ok) { error.value = r.error; return }
  state.captures[r.data.capture.id] ??= r.data.capture
  currentId.value = r.data.capture.id
}

const transcript = ref<string | null>(null)
const transcriptOpen = ref(false)
async function toggleTranscript() {
  transcriptOpen.value = !transcriptOpen.value
  if (!transcriptOpen.value || !currentId.value) return
  transcript.value = null
  const r = await captureTranscript(currentId.value)
  transcript.value = r.ok ? (r.data.transcript ?? '') : r.error
}
async function retry(id: string) { const r = await retryCapture(id); if (r.ok) currentId.value = id; else error.value = r.error }
async function discard(id: string) {
  const r = await deleteCapture(id)
  if (!r.ok) { error.value = r.error; return }
  if (currentId.value === id) currentId.value = null
}

function close() { if (phase.value === 'recording') stopRecording(false); emit('close') }
/** Esc and a click outside never throw a recording away: only Stop, Cancel or × end one. */
function dismiss() { if (phase.value !== 'recording' && phase.value !== 'starting') close() }
const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
let motion: ReturnType<typeof openOverlay> = null
/** Modal: focus moves in, Tab stays inside, and goes back to the button that opened it. */
const opener = document.activeElement as HTMLElement | null
onMounted(() => {
  motion = openOverlay(root.value!, panel.value!, document.querySelector('.cap-btn'), matchMedia('(max-width: 760px)').matches)
  panel.value?.querySelector<HTMLElement>('.cap-input .btn')?.focus()
  window.addEventListener('keydown', onKey)
})
/** On window, not the overlay: Drop or Create issue removes the focused button, and focus falls to <body>. */
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') dismiss(); else if (e.key === 'Tab') trap(e) }
function trap(e: KeyboardEvent) {
  const f = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], input:not([hidden])') ?? [])].filter((x) => x.offsetParent)
  if (!f.length) return
  const i = f.indexOf(document.activeElement as HTMLElement)
  if (e.shiftKey && i <= 0) { e.preventDefault(); f.at(-1)!.focus() } else if (!e.shiftKey && (i < 0 || i === f.length - 1)) { e.preventDefault(); f[0].focus() }
}
onBeforeUnmount(() => { gone = true; window.removeEventListener('keydown', onKey); if (rec) stopRecording(false); clearInterval(tick); motion?.revert(); opener?.focus?.() })
</script>

<template>
  <div ref="root" class="overlay cap-overlay" @click.self="dismiss">
    <div ref="panel" class="dialog capture" role="dialog" aria-modal="true" aria-labelledby="cap-h">
      <header class="ch-head" data-enter>
        <div>
          <h2 id="cap-h">Capture</h2>
          <p class="why">Record what needs doing, or a whole meeting, or choose a recording you made. It is transcribed on this computer, and nothing is filed until you press Create issue.</p>
        </div>
        <button class="hq-x" aria-label="Close" @click="close">×</button>
      </header>
      <div class="cap-scroll">

      <section class="cap-input" aria-label="New recording" data-enter>
        <template v-if="phase === 'recording'">
          <span class="cap-rec" role="timer" aria-live="off"><i class="cap-live" aria-hidden="true" />Recording <b>{{ clock(elapsed) }}</b></span>
          <button class="btn primary" @click="stopRecording(true)">Stop and use</button>
          <button class="btn" @click="stopRecording(false)">Cancel</button>
        </template>
        <p v-else-if="phase === 'starting'" class="why" role="status">Waiting for the microphone…</p>
        <p v-else-if="phase === 'uploading'" class="why" role="status">Uploading the recording…</p>
        <template v-else>
          <button v-if="canRecord" class="btn primary cap-big" @click="startRecording"><i class="cap-mic" aria-hidden="true" />Record</button>
          <button v-else class="btn primary cap-big" @click="phoneRecorder?.click()"><i class="cap-mic" aria-hidden="true" />Record</button>
          <button class="btn cap-big" @click="picker?.click()">Choose a recording</button>
        </template>
        <input ref="picker" type="file" accept="audio/*,video/mp4,.m4a,.amr,.3gp,.caf,.opus" hidden @change="picked">
        <input ref="phoneRecorder" type="file" accept="audio/*" capture hidden @change="picked">
      </section>
      <p v-if="error" class="err" role="alert">{{ error }}</p>

      <section v-if="current" class="cap-current" aria-live="polite" data-enter>
        <div class="cap-head">
          <b>{{ ageText(current.createdAt, state.now) }}</b>
          <span :class="['cap-stage', current.status]"><i v-if="current.status === 'transcribing' || current.status === 'extracting'" class="cap-live" aria-hidden="true" />{{ stageText(current) }}</span>
          <button v-if="current.hasTranscript" class="linkbtn" :aria-expanded="transcriptOpen" @click="toggleTranscript">{{ transcriptOpen ? 'Hide transcript' : 'Transcript' }}</button>
        </div>
        <p v-if="transcriptOpen" class="cap-transcript" dir="auto">{{ transcript ?? 'Loading…' }}</p>
        <div v-if="current.status === 'ready' && !current.items.length" class="actions"><button class="btn" @click="discard(current.id)">Discard</button></div>
        <div v-if="current.status === 'failed'" class="actions">
          <button class="btn primary" @click="retry(current.id)">Try again</button>
          <button class="btn danger" @click="discard(current.id)">Discard</button>
        </div>
        <TransitionGroup v-if="current.status === 'ready' && current.items.length" tag="ul" class="cap-list" move-class="cap-move" @enter="enterRow" @leave="leaveRow">
          <CaptureItemRow v-for="(i, n) in current.items" :key="i.id" :data-index="n" :capture-id="current.id" :item="i" :repos="repos" :open="current.items.length === 1" />
        </TransitionGroup>
        <p v-if="current.status === 'ready' && openCount" class="why">Anything you don't file or drop stays in the inbox for later.</p>
      </section>

      <section v-if="restGroups.length || failed.length" class="cap-inbox" data-enter>
        <h3>Inbox <span v-if="waiting" class="count">{{ waiting }}</span></h3>
        <div v-for="c in failed" :key="c.id" class="cap-failed" data-enter-row>
          <span class="err">Recording from {{ ageText(c.createdAt, state.now) }} failed{{ c.error ? `: ${c.error}` : '' }}</span>
          <span class="actions"><button class="btn" @click="retry(c.id)">Try again</button><button class="btn danger" @click="discard(c.id)">Discard</button></span>
        </div>
        <div v-for="g in restGroups" :key="g.id" class="cap-group">
          <p class="cap-when">From {{ ageText(g.createdAt, state.now) }}</p>
          <TransitionGroup tag="ul" class="cap-list" move-class="cap-move" @enter="enterRow" @leave="leaveRow">
            <CaptureItemRow v-for="(r, n) in g.rows" :key="r.item.id" :data-index="n" :capture-id="g.id" :item="r.item" :repos="repos" />
          </TransitionGroup>
        </div>
      </section>
      <p v-else-if="!current" class="why cap-empty" data-enter>Nothing waiting. Items you keep for later show up here.</p>
      </div>
    </div>
  </div>
</template>
