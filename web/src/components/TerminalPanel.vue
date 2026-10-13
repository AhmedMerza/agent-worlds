<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { LABEL, catchupView, isLeaveTerminalKey, isTouch } from '../logic'
import { state, selected, groups, termFocusTick, requestCatchup, needsYou } from '../store'

const s = computed(() => selected.value)
const world = computed(() => groups.value.find((g) => s.value && g.sessions.includes(s.value))?.world)
const cu = computed(() => (s.value ? catchupView(s.value, state.now) : null))
const touch = isTouch()
/** Said when the app chose this session itself, so nobody wonders why it is showing. */
const autoLabel = computed(() => (state.autoSelected && s.value ? (needsYou.value.some((n) => n.id === s.value!.id) ? 'Showing: oldest needing you' : 'Showing: first session') : ''))
const root = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)
const link = ref<'connecting' | 'live' | 'closed'>('connecting')
const hasTmux = computed(() => !!s.value?.tmux)
const termFocused = ref(false)
const showCatchup = computed(() => !!s.value && !s.value.ghost && s.value.state !== 'starting')
const attachId = computed(() => (hasTmux.value ? s.value!.id : null))

let term: Terminal | null = null
let fit: FitAddon | null = null
let sock: WebSocket | null = null
let ro: ResizeObserver | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined
let gen = 0

const sendResize = () => {
  if (sock?.readyState === WebSocket.OPEN && term) sock.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
}
function refit() { try { fit?.fit() } catch { /* host not laid out yet */ } sendResize() }

function attach(id: string, myGen: number) {
  if (!term) return
  link.value = 'connecting'
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/pty?session=${encodeURIComponent(id)}`)
  ws.binaryType = 'arraybuffer' // synchronous binary frames, so they stay in order with text frames
  sock = ws
  // A late frame from a replaced socket must not reach the shared terminal after it was reset for another session.
  ws.onopen = () => { if (myGen !== gen) return; link.value = 'live'; refit() }
  ws.onmessage = (e) => {
    if (myGen !== gen) return
    term?.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data))
  }
  ws.onclose = () => {
    if (myGen !== gen) return // a newer attach replaced this one
    link.value = 'closed'
    retryTimer = setTimeout(() => { if (myGen === gen) attach(id, myGen) }, 2000)
  }
}

function detach() {
  gen++
  clearTimeout(retryTimer)
  if (sock) { sock.onclose = null; sock.close(); sock = null }
}

async function reattach(id: string | null) {
  detach()
  await nextTick()
  if (!id || !host.value) { term?.dispose(); term = null; fit = null; return }
  if (!term) {
    term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 13, cursorBlink: true,
      theme: { background: '#0c0f14', foreground: '#ece6d9' },
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.value)
    // Ctrl+] hands the keyboard back to the page (Esc still goes to Claude). Returning false keeps it from reaching Claude.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && isLeaveTerminalKey(e)) { term?.blur(); return false }
      return true
    })
    term.textarea?.addEventListener('focus', () => { termFocused.value = true })
    term.textarea?.addEventListener('blur', () => { termFocused.value = false })
    term.onData((d) => { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'in', d })) })
    ro = new ResizeObserver(refit)
    ro.observe(host.value)
  } else {
    term.reset()
  }
  refit()
  attach(id, gen)
}

watch(attachId, (id) => reattach(id), { flush: 'post' })
onMounted(() => reattach(attachId.value))
onBeforeUnmount(() => { detach(); ro?.disconnect(); term?.dispose() })
watch(termFocusTick, async () => {
  await nextTick()
  root.value?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  term?.focus()
})
</script>

<template>
  <section ref="root" class="term" aria-label="Session terminal" :style="{ '--tint': world?.color ?? '#8a92a0' }">
    <div class="term-head">
      <template v-if="s">
        <span :class="['dot', s.state]" /><b>{{ s.repoName }}</b> {{ world?.name }} · {{ LABEL[s.state] }}
        <span v-if="s.context"> · {{ s.context.pct }}% context</span>
        <span v-if="autoLabel" class="term-auto">{{ autoLabel }}</span>
        <span v-if="hasTmux && termFocused" class="term-paused">Shortcuts paused · {{ touch ? 'Tap outside the terminal to leave' : 'Ctrl+] to leave' }}</span>
        <span v-if="hasTmux" class="term-state" :style="termFocused ? 'margin-left:12px' : ''">{{ link === 'live' ? 'Live terminal' : link === 'connecting' ? 'Connecting…' : 'Reconnecting…' }}</span>
      </template>
      <template v-else>No session selected</template>
    </div>
    <dl v-if="s && cu && showCatchup" class="catch">
      <template v-if="cu.asked"><dt>You asked</dt><dd>{{ cu.asked }}</dd></template>
      <template v-if="cu.mode === 'filled'">
        <template v-if="cu.did"><dt>It did</dt><dd>{{ cu.did }}</dd></template>
        <dt>It needs</dt><dd :class="['needs', { none: !cu.needs }]">{{ cu.needs || cu.needsFallback }}</dd>
        <span class="tag">Catch-up written by Haiku</span>
        <span v-if="cu.stale" class="stale" role="status">May be out of date · <button class="linkbtn" @click="requestCatchup(s.id)">Refresh</button></span>
      </template>
      <p v-if="cu.mode === 'running'" class="catch-run" role="status">Haiku is reading the transcript…</p>
      <p v-else class="catch-act">
        <span v-if="cu.written" class="why">{{ cu.written }} ·</span>
        <button class="btn" @click="requestCatchup(s.id)">{{ cu.mode === 'filled' ? 'Refresh' : 'Catch me up' }}</button>
        <span class="why">(C)</span>
      </p>
    </dl>
    <p v-if="s?.ghost" class="term-view">This Claude is running in a plain terminal outside Agent Worlds, so there is no terminal here. Quit it there, then move it in from the panel on the right.</p>
    <p v-else-if="s && !hasTmux" class="term-view">This session did not start in tmux, so there is no live terminal. It is view-only here: its status shows, and its cards can still be answered from the inbox.</p>
    <div v-show="hasTmux" ref="host" class="term-body" />
  </section>
</template>
