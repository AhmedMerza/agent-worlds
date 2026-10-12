<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { LABEL } from '../logic'
import { selected, groups, termFocusTick } from '../store'

const s = computed(() => selected.value)
const world = computed(() => groups.value.find((g) => s.value && g.sessions.includes(s.value))?.world)
const root = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)
const link = ref<'connecting' | 'live' | 'closed'>('connecting')
const hasTmux = computed(() => !!s.value?.tmux)
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
  sock = ws
  ws.onopen = () => { link.value = 'live'; refit() }
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') term?.write(e.data)
    else if (e.data instanceof Blob) e.data.arrayBuffer().then((b) => term?.write(new Uint8Array(b)))
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
        <span v-if="hasTmux" class="term-state">{{ link === 'live' ? 'Live terminal' : link === 'connecting' ? 'Connecting…' : 'Reconnecting…' }}</span>
      </template>
      <template v-else>No session selected</template>
    </div>
    <dl v-if="s?.catchup" class="catch">
      <dt>You asked</dt><dd>{{ s.catchup.asked }}</dd>
      <dt>It did</dt><dd>{{ s.catchup.did }}</dd>
      <dt>It needs</dt><dd :class="['needs', { none: !s.catchup.needs }]">{{ s.catchup.needs || 'Nothing right now.' }}</dd>
    </dl>
    <p v-if="s && !hasTmux" class="term-view">This session is not running inside tmux, so it is view-only.</p>
    <div v-show="hasTmux" ref="host" class="term-body" />
  </section>
</template>
