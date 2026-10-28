<script setup lang="ts">
import { usageText } from '../hq'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { stateLabel, catchupView, isLeaveTerminalKey, isTouch, agentName, nameOf, cardLive, queueRestart } from '../logic'
import { state, selected, terminalOf, worldOf, termFocusTick, requestCatchup, needsYou, sessionConversation, showToast, uploadFile, restartSession, endSession, renameSession, restartQueued } from '../store'
import { copyText, osc52Text } from '../clipboard'
import QuestionOptions from './QuestionOptions.vue'
import type { Turn } from '../types'

const s = computed(() => selected.value)
const world = computed(() => (s.value ? worldOf(s.value) : undefined))
const cu = computed(() => (s.value ? catchupView(s.value, state.now) : null))
const touch = isTouch()
/** The key that drags a selection past tmux's mouse mode (xterm.js: Shift, Option on a Mac). */
const selectKey = /Mac/.test(navigator.platform) ? 'Option' : 'Shift'
/** Said when the app chose this session itself, so nobody wonders why it is showing. */
const autoLabel = computed(() => (state.autoSelected && s.value ? (needsYou.value.some((n) => n.id === s.value!.id) ? 'Showing: oldest needing you' : 'Showing: first session') : ''))
const root = ref<HTMLElement | null>(null)
const host = ref<HTMLElement | null>(null)
const link = ref<'connecting' | 'live' | 'closed'>('connecting')
/** A live terminal: tmux, or a session the server runs itself (no tmux). */
const hasTmux = computed(() => !!s.value?.tmux || !!s.value?.direct)
const termFocused = ref(false)
const showCatchup = computed(() => !!s.value && !s.value.ghost && s.value.state !== 'starting')
const attachId = computed(() => (hasTmux.value ? s.value!.id : null))
/** A non-live question card: the terminal asks it, so its options show here while you type the number. */
const termQuestion = computed(() => (s.value?.card?.kind === 'question' && !cardLive(s.value.card) ? s.value.card : null))
const termKey = computed(() => terminalOf(state, s.value))

let term: Terminal | null = null
let fit: FitAddon | null = null
let sock: WebSocket | null = null
let ro: ResizeObserver | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined
let gen = 0

/** "Scroll back": Claude's full-screen view keeps no terminal scrollback, so show the conversation from the transcript. */
const history = ref<Turn[] | null>(null)
const historyOpen = ref(false)
/** On short screens a filled catch-up folds to its "It needs" line so the terminal keeps its rows. */
const catchOpen = ref(false)
const historyErr = ref('')
const historyBox = ref<HTMLElement | null>(null)
async function loadHistory() {
  if (!s.value) return
  historyErr.value = ''
  const r = await sessionConversation(s.value.id)
  if (!r.ok) { historyErr.value = r.error; return }
  history.value = r.data.turns
  await nextTick()
  if (historyBox.value) historyBox.value.scrollTop = historyBox.value.scrollHeight
}
/** Pasted or dropped files: upload each, then type its path so Claude attaches it (as a native terminal would). */
async function sendFiles(files: File[]) {
  if (!s.value || !files.length) return
  for (const f of files) {
    const r = await uploadFile(s.value.id, f)
    if (!r.ok) { showToast(`Could not add ${f.name || 'the file'}: ${r.error}`); continue }
    if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'in', d: r.data.path + ' ' }))
  }
  term?.focus()
}
/** Claude's full-screen view jumps to the latest output on Ctrl+End; phones and Mac keyboards have no such key. */
function jumpToLatest() { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ t: 'in', d: '\x1b[1;5F' })) }
/**
 * A fresh claude resumes this conversation and draws it from scratch: the fix for a wrecked screen.
 * Mid-turn the first click queues it for when the turn ends; a second click restarts now and stops the turn.
 */
const restartArmed = computed(() => !!s.value && restartQueued.has(s.value.id))
async function restart() {
  const cur = s.value
  if (!cur) return
  if (queueRestart(cur.state, restartQueued.has(cur.id))) {
    restartQueued.add(cur.id)
    showToast(`${cur.repoName} restarts when this turn ends. Click Restart again to restart now and stop the turn.`)
    return
  }
  restartQueued.delete(cur.id)
  const r = await restartSession(cur.id, cur.state === 'working')
  showToast(r.ok ? `Restarting ${cur.repoName}: Claude comes back with the same conversation.` : `Could not restart: ${r.error}`)
}
/** Quits its agent and closes its terminal. There is no undo, so it always asks once; mid-turn it says what it cuts short. */
const endArmed = ref(false)
let endTimer: ReturnType<typeof setTimeout> | undefined
async function end() {
  const cur = s.value
  if (!cur) return
  if (!endArmed.value) { endArmed.value = true; clearTimeout(endTimer); endTimer = setTimeout(() => { endArmed.value = false }, 6000); return }
  endArmed.value = false
  const r = await endSession(cur.id, true)
  showToast(r.ok ? `Ended ${nameOf(cur)}.` : `Could not end it: ${r.error}`)
}
const endLabel = computed(() => !endArmed.value ? 'End session' : s.value?.state === 'working' ? 'Stop the turn and end?' : s.value?.state === 'waiting' ? 'It is waiting on you. End?' : 'End it? Click again')
/** Your name for the session, edited in place of its name in the header. */
const renaming = ref<string | null>(null)
const renameIn = ref<HTMLInputElement | null>(null)
function startRename() { renaming.value = s.value?.label ?? ''; void nextTick(() => renameIn.value?.select()) }
async function saveRename() {
  const cur = s.value, v = renaming.value
  renaming.value = null
  if (!cur || v === null || v.trim() === (cur.label ?? '')) return
  const r = await renameSession(cur.id, v)
  if (!r.ok) showToast(`Could not rename: ${r.error}`)
}
watch(() => s.value?.id, () => { endArmed.value = false; renaming.value = null })
function openHistory() { historyOpen.value = true; history.value = null; void loadHistory() }
watch(() => s.value?.id, () => { historyOpen.value = false; history.value = null })

/** tmux sizes the window to the device used last; nudging our size when this tab comes back takes the window back. */
function reclaimSize() {
  if (document.visibilityState !== 'visible' || sock?.readyState !== WebSocket.OPEN || !term) return
  sock.send(JSON.stringify({ t: 'resize', cols: Math.max(2, term.cols - 1), rows: term.rows }))
  sendResize()
}

const sendResize = () => {
  if (sock?.readyState === WebSocket.OPEN && term) sock.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
}
/** A hidden panel (phone tab, scroll back) measures 0×0: sending that would squeeze the tmux window to 2 columns. */
function refit() { if (!host.value?.offsetWidth) return; try { fit?.fit() } catch { /* host not laid out yet */ } sendResize() }


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
    retryTimer = setTimeout(() => { if (myGen === gen) { term?.reset(); attach(attachId.value ?? id, myGen) } }, 2000) // the new attach repaints everything
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
      fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: 13, cursorBlink: true, macOptionClickForcesSelection: true,
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
    // Copying: programs inside (Claude Code, tmux) send OSC 52, which xterm.js drops unless handled;
    // and a selection made with Shift+drag (past tmux's mouse mode) is copied on release.
    const copy = async (text: string) => showToast(await copyText(text) ? 'Copied to your clipboard.' : 'The browser blocked the clipboard.')
    term.parser.registerOscHandler(52, (data) => { const t = osc52Text(data); if (t) void copy(t); return true })
    host.value.addEventListener('mouseup', () => { const t = term?.getSelection().replace(/[ \t]+$/gm, ''); if (t) void copy(t) }) // no padding a terminal row adds
    // Capture phase, so a pasted image never reaches xterm.js (it would paste nothing); plain text still pastes as usual.
    host.value.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])]
      if (files.length) { e.preventDefault(); e.stopPropagation(); void sendFiles(files) }
    }, true)
    host.value.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault() })
    host.value.addEventListener('drop', (e) => { const files = [...(e.dataTransfer?.files ?? [])]; if (files.length) { e.preventDefault(); void sendFiles(files) } })
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

// Keyed on the terminal, not the session: /clear swaps the session but the tmux pane (and this socket) stay the same.
watch(termKey, () => reattach(attachId.value), { flush: 'post' })
onMounted(() => {
  reattach(attachId.value)
  void document.fonts?.ready.then(refit) // the first fit may have measured the fallback font's cells
  window.addEventListener('focus', reclaimSize)
  document.addEventListener('visibilitychange', reclaimSize)
})
onBeforeUnmount(() => {
  detach(); ro?.disconnect(); term?.dispose()
  window.removeEventListener('focus', reclaimSize)
  document.removeEventListener('visibilitychange', reclaimSize)
})
watch(termFocusTick, async () => {
  await nextTick()
  root.value?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  term?.focus()
})
</script>

<template>
  <section ref="root" :class="['term', { typing: hasTmux && termFocused }]" aria-label="Session terminal" :style="{ '--tint': world?.color ?? '#8a92a0' }">
    <div class="term-head">
      <template v-if="s">
        <span :class="['dot', s.state]" /><input v-if="renaming !== null" ref="renameIn" v-model="renaming" class="rename-in" maxlength="40" :placeholder="nameOf(s)" aria-label="Name this session (empty: its first task or repo name)" @keydown.enter.prevent="saveRename" @keydown.esc.prevent="renaming = null" @blur="saveRename" /><b v-else :title="s.label ? s.repoName : undefined">{{ nameOf(s) }}</b> {{ world?.name }} · {{ stateLabel(s, state.now) }}
        <span v-if="s.context"> · {{ s.context.pct }}% context</span><span v-if="s.usage" title="Tokens this conversation (in, out and cache)"> · {{ usageText(s.usage) }}</span>
        <span v-if="autoLabel" class="term-auto">{{ autoLabel }}</span>
        <span v-if="hasTmux && termFocused" class="term-paused"><b>⌨ Typing into {{ s ? agentName(s) : 'Claude' }}</b> · shortcuts paused · {{ touch ? 'Tap outside the terminal to leave' : `Ctrl+] to leave · ${selectKey}+drag to copy` }}</span>
        <button v-if="!s.ghost" class="hdr-btn term-scroll" :aria-pressed="historyOpen" @click="historyOpen ? (historyOpen = false) : openHistory()">{{ historyOpen ? 'Back to live terminal' : 'Scroll back' }}</button>
        <button v-if="hasTmux && !historyOpen && link === 'live'" class="hdr-btn term-scroll" :title="`Jump to ${agentName(s)}'s latest output (Ctrl+End)`" @click="jumpToLatest">Jump to latest</button>
        <button v-if="hasTmux && !historyOpen && link === 'live' && (s?.agent ?? 'claude') === 'claude'" :class="['hdr-btn', 'term-scroll', { danger: restartArmed }]" title="Screen looks wrecked? Quit this Claude and resume the same conversation in a fresh one" @click="restart">{{ !restartArmed ? 'Restart' : s?.state === 'working' ? 'Restart now (stops the turn)' : 'Restart now' }}</button>
        <button v-if="!s.ghost && renaming === null" class="hdr-btn term-scroll" title="Give this session a name for its name tag" @click="startRename">Rename</button>
        <button v-if="hasTmux" :class="['hdr-btn', 'term-scroll', { danger: endArmed }]" :title="`Quit ${agentName(s)} and close this terminal`" @click="end">{{ endLabel }}</button>
        <span v-if="hasTmux && !termFocused && !touch" class="term-paused idle">Press <kbd>T</kbd> or click to type here</span>
        <span v-if="hasTmux" class="term-state" :style="termFocused ? 'margin-left:12px' : ''">{{ link === 'live' ? 'Live terminal' : link === 'connecting' ? 'Connecting…' : 'Reconnecting…' }}</span>
        <span v-if="s?.direct" class="term-note" title="tmux is not installed, so Agent Worlds runs this session itself. Install tmux to keep sessions running across restarts.">Runs without tmux · stops if Agent Worlds restarts</span>
      </template>
      <template v-else>No session selected</template>
    </div>
    <dl v-if="s && cu && showCatchup" :class="['catch', { filled: cu.mode === 'filled', folded: !catchOpen }]">
      <template v-if="cu.asked"><dt>You asked</dt><dd>{{ cu.asked }}</dd></template>
      <template v-if="cu.mode === 'filled'">
        <template v-if="cu.did"><dt>It did</dt><dd>{{ cu.did }}</dd></template>
        <dt class="need"><button class="catch-more" :aria-expanded="catchOpen" :aria-label="catchOpen ? 'Show less of the catch-up' : 'Show the whole catch-up'" @click="catchOpen = !catchOpen">{{ catchOpen ? '▾' : '▸' }}</button>It needs</dt><dd :class="['needs', 'need', { none: !cu.needs }]">{{ cu.needs || cu.needsFallback }}</dd>
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
    <div v-if="historyOpen" ref="historyBox" class="history" aria-label="Conversation so far">
      <p v-if="historyErr" class="err" role="alert">{{ historyErr }}</p>
      <p v-else-if="!history" class="why">Loading the conversation…</p>
      <p v-else-if="!history.length" class="why">Nothing said yet.</p>
      <template v-else>
        <p class="why">The conversation so far, newest at the bottom.</p>
        <div v-for="(t, i) in history" :key="i" :class="['turn', t.who]">
          <span v-if="t.who !== 'step'" class="who">{{ t.who === 'you' ? 'You' : 'Claude' }}</span>{{ t.text }}
        </div>
        <div class="actions"><button class="btn" @click="loadHistory">Refresh</button><button class="btn" @click="historyOpen = false">Back to live terminal</button></div>
      </template>
    </div>
    <div v-if="termQuestion && hasTmux && !historyOpen" class="term-q">
      <QuestionOptions :card="termQuestion" show-question />
      <p class="why">{{ termQuestion.questions.every(q => q.options.length) ? 'Type the number in the terminal below.' : 'Answer in the terminal below.' }}</p>
    </div>
    <div v-show="hasTmux && !historyOpen" ref="host" class="term-body" />
  </section>
</template>
