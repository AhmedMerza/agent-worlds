<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Turn } from '../types'
import { NEEDS_YOU, agentName, cardLive, cardKey, chatItems, chatPreview, hasChat, nameOf, nextChat, stateLabel } from '../logic'
import { state, selected as s, groups, needsYou, sessionConversation, sendInput, focusTerminal, openChat, skipped, chatRun, showToast } from '../store'
import { renderMarkdown } from '../markdown'
import CardActions from './CardActions.vue'

/** The selected session as a conversation, read from its transcript and refetched as it changes. `back`: show a back button (phone). */
defineProps<{ back?: boolean }>()
const emit = defineEmits<{ back: [] }>()

const world = computed(() => (s.value ? groups.value.find((g) => g.sessions.includes(s.value!))?.world : undefined))
const turns = ref<Turn[] | null>(null)
const err = ref('')
/** No transcript yet: the session is starting, or nothing has been said. The next update tries again. */
const noTranscript = ref(false)
const box = ref<HTMLElement | null>(null)
const items = computed(() => chatItems(turns.value ?? []))
/** A question the agent can only take in its terminal: a message typed here would not answer it. */
const terminalOnly = computed(() => !!card.value && !cardLive(card.value) && card.value.kind === 'question')
const card = computed(() => (s.value?.card && NEEDS_YOU.includes(s.value.state) ? s.value.card : null))

const text = ref('')
const sending = ref(false)
/** What you just sent, shown until the transcript has it. */
const sent = ref<string | null>(null)
/** What you did on its cards while this chat was open, placed after the message it followed (the transcript does not record it). */
const acted = ref<{ at: number; text: string }[]>([])
const actedAt = (n: number) => acted.value.filter((a) => a.at === n)
function onActed(text: string) {
  acted.value.push({ at: items.value.length, text }); follow = true; soon()
  moveOn(text)
}
/** Working through requests: say what you did and where you are now, and open the next one. */
function moveOn(did: string) {
  const n = next.value
  const from = s.value
  if (!chatRun.value || !n || !from) return
  showToast(`${did} · now ${nameOf(n)}`)
  openChat(n.id, true)
  // The thumb that just answered is still moving: the card that replaces it takes no tap until you can have read it.
  settling.value = true; clearTimeout(settleTimer); settleTimer = setTimeout(() => { settling.value = false }, 700)
  // The toast can be replaced by the server's own, so the chat you land in also says where your tap went.
  moved.value = `${nameOf(from)}: ${did}`
  clearTimeout(movedTimer); movedTimer = setTimeout(() => { moved.value = null }, 6000)
}
const settling = ref(false)
let settleTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(settleTimer))
const moved = ref<string | null>(null)
let movedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(movedTimer))

/** The next session waiting on you, so a pile of requests is one tap each, not back to the list every time. */
// The bar keeps the session it names until that one stops needing you: a new request arriving must not change where the
// tap goes between reading the label and tapping it.
const target = ref<string | null>(null)
const next = computed(() => {
  const held = target.value ? needsYou.value.find((x) => x.id === target.value && x.id !== s.value?.id && !skipped.has(cardKey(x))) : undefined
  return held ?? nextChat(needsYou.value, s.value?.id ?? null, skipped)
})
watch(next, (n) => { target.value = n?.id ?? null }, { immediate: true })
/** With a card still open this is "Skip": it is not offered again, until that session asks something new. */
function goNext() {
  if (!next.value) return
  if (card.value && s.value) skipped.add(cardKey(s.value))
  openChat(next.value.id, true)
}

let lastLoad = 0
let follow = true
let timer: ReturnType<typeof setTimeout> | undefined
async function load() {
  const cur = s.value
  if (!cur || !hasChat(cur)) return
  lastLoad = Date.now()
  const r = await sessionConversation(cur.id)
  if (s.value?.id !== cur.id) return // switched sessions while it loaded
  if (!r.ok) {
    noTranscript.value = /no transcript/.test(r.error)
    err.value = noTranscript.value ? '' : r.error
    return
  }
  err.value = ''; noTranscript.value = false
  const b = box.value
  // Keep following the bottom, unless you scrolled up to read.
  const atBottom = follow || !b || b.scrollHeight - b.scrollTop - b.clientHeight < 80
  turns.value = r.data.turns
  if (sent.value && r.data.turns.slice(-6).some((t) => t.who === 'you' && t.text.trim() === sent.value)) sent.value = null
  if (atBottom) { await nextTick(); if (box.value) box.value.scrollTop = box.value.scrollHeight }
  follow = false
}
/** At most one load every 1.5 s: a working session updates many times a second. */
function soon() {
  clearTimeout(timer)
  timer = setTimeout(load, Math.max(0, 1500 - (Date.now() - lastLoad)))
}
watch(() => s.value?.id, () => { clearTimeout(timer); turns.value = null; err.value = ''; noTranscript.value = false; sent.value = null; acted.value = []; target.value = null; follow = true; void load() }, { immediate: true })
watch(() => s.value?.updatedAt, soon)
onBeforeUnmount(() => clearTimeout(timer))

async function send() {
  const cur = s.value
  const t = text.value.trim()
  if (!cur || !t || sending.value) return
  sending.value = true
  try {
    const answering = cur.card?.kind === 'asking' && NEEDS_YOU.includes(cur.state)
    if (await sendInput(cur.id, t)) {
      text.value = ''
      if (answering) { moveOn(`You replied to ${nameOf(cur)}`); if (s.value?.id !== cur.id) return }
      sent.value = t; follow = true
      await nextTick(); if (box.value) box.value.scrollTop = box.value.scrollHeight
      soon()
    }
  } finally { sending.value = false }
}
// Enter sends, Shift+Enter is a new line (not while an IME is composing a word).
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void send() }
}
</script>

<template>
  <section class="term chat" aria-label="Session chat" :style="{ '--tint': world?.color ?? 'var(--idle)' }">
    <div class="term-head">
      <button v-if="back" class="hdr-btn chat-back" aria-label="Back to chats" @click="emit('back')">←</button>
      <template v-if="s">
        <span :class="['dot', s.state]" /><b>{{ nameOf(s) }}</b> <span class="chat-world">{{ world?.name }} ·</span> {{ stateLabel(s, state.now) }}
        <span v-if="s.branch" class="tag">{{ s.branch }}</span>
        <button v-if="!s.ghost" class="hdr-btn chat-term" @click="focusTerminal()">Terminal</button>
      </template>
      <span v-else>No session selected</span>
    </div>

    <p v-if="!s" class="term-view">Pick a session to see its chat.</p>
    <div v-else-if="!hasChat(s)" class="term-view">
      <p class="why">The chat view reads Claude's conversation. {{ agentName(s) }}'s shows in its terminal.</p>
      <button v-if="!s.ghost" class="btn primary" @click="focusTerminal()">Open its terminal</button>
    </div>
    <template v-else>
      <div ref="box" class="chat-body">
        <p v-if="err" class="err" role="alert">{{ err }} <button class="linkbtn" @click="load">Try again</button></p>
        <p v-else-if="noTranscript" class="why">No conversation to show yet. It appears once the session has said something; until then, its terminal has it.</p>
        <p v-else-if="!turns" class="why">Loading the conversation…</p>
        <p v-else-if="!items.length && !sent" class="why">Nothing said yet.</p>
        <p v-for="(a, j) in actedAt(0)" :key="'a' + j" class="chat-acted">{{ a.text }}</p>
        <template v-for="(it, i) in items" :key="i">
          <details v-if="it.who === 'steps'" class="chat-steps">
            <summary>{{ it.lines.length }} {{ it.lines.length === 1 ? 'step' : 'steps' }}</summary>
            <ul><li v-for="(l, j) in it.lines" :key="j">{{ l }}</li></ul>
          </details>
          <div v-else-if="it.who === 'you'" class="bubble you">{{ it.text }}</div>
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html off escapes raw HTML (tests/chat.test.ts) -->
          <div v-else class="bubble claude md" v-html="renderMarkdown(it.text)" />
          <p v-for="(a, j) in actedAt(i + 1)" :key="'a' + j" class="chat-acted">{{ a.text }}</p>
        </template>
        <div v-if="sent" class="bubble you sending">{{ sent }}</div>
      </div>
      <p v-if="moved" class="chat-moved" role="status">✓ {{ moved }}</p>
      <div v-if="card" :class="['card', 'chat-card', { settling, risky: card.kind === 'permission' && card.risky }]" :aria-busy="settling"><CardActions :key="s.id + card.kind + ('requestId' in card ? card.requestId : '')" :s="s" :c="card" :no-reply="true" :on-acted="onActed" fold-scopes /></div>
      <button v-if="next" class="chat-next" @click="goNext"><span class="lbl">{{ card ? 'Skip to' : 'Next' }}</span><b>{{ nameOf(next) }}</b><span class="chat-prev">{{ next.card ? chatPreview(next.card) : '' }}</span><span aria-hidden="true">→</span></button>
      <form class="chat-input" @submit.prevent="send">
        <textarea v-model="text" rows="1" enterkeyhint="send" :aria-label="`Message ${nameOf(s)}`" :placeholder="terminalOnly ? 'Its question is answered in the terminal, not here' : s.state === 'working' ? 'Message (it reads this when it can)' : 'Message'" @keydown="onKey" />
        <button class="btn primary" :disabled="!text.trim() || sending">Send</button>
      </form>
    </template>
  </section>
</template>
