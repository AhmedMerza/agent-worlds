<script lang="ts">
import { reactive } from 'vue'
/** Unsent replies by session, so a draft survives the card changing (or the inbox and chat showing the same one). */
const drafts = reactive<Record<string, string>>({})
</script>

<script setup lang="ts">
import { computed } from 'vue'
import type { Session, Question, Card } from '../types'
import { actedLine, cardAsk, permissionDetail, buildAnswers, scopeAvailability, showLearnNudge, cardLive, agentName } from '../logic'
import { groups, select, decidePermission, answerQuestions, acknowledge, sendInput, focusTerminal as focusTerm, type Scope } from '../store'
import ReviewBlock from './ReviewBlock.vue'
import ContinueIn from './ContinueIn.vue'

/** What a session's card asks of you and the buttons that answer it: shared by the inbox and the chat. */
/** `onActed`: told what you did once the server took it (the chat writes it into the conversation). A callback, not an
 *  event: the server's update can remove this card before the request returns, and an unmounted component's events go nowhere. */
const props = defineProps<{ s: Session; c: Card; noReply?: boolean; onActed?: (line: string) => void }>()
const busy = reactive<Record<string, boolean>>({})
const picked = reactive<Record<string, string[]>>({})

const world = computed(() => groups.value.find((g) => g.sessions.includes(props.s))?.world)
const ask = computed(() => cardAsk(props.c))
/** The pending request a permission or question card answers (narrowing on `c` does not reach into click handlers). */
const rid = computed(() => ('requestId' in props.c ? props.c.requestId : ''))
const options = (c: Extract<Card, { kind: 'question' }>) => c.questions.filter((q) => q.options.length)
async function run(key: string, fn: () => Promise<boolean>) {
  if (busy[key]) return
  busy[key] = true
  try { await fn() } finally { busy[key] = false }
}
function act(key: string, did: Parameters<typeof actedLine>[1], fn: () => Promise<boolean>) {
  const c = props.c, tell = props.onActed
  return run(key, async () => { const ok = await fn(); if (ok) tell?.(actedLine(c, did)); return ok })
}
const isOn = (q: Question, label: string) => !!picked[q.question]?.includes(label)
function choose(requestId: string, q: Question, label: string) {
  const c = props.c
  if (c.kind !== 'question') return
  if (c.questions.length === 1 && !q.multiSelect) { act(requestId, { answers: { [q.question]: label } }, () => answerQuestions(props.s.id, requestId, { [q.question]: label })); return }
  const list = picked[q.question] ?? []
  picked[q.question] = q.multiSelect ? (list.includes(label) ? list.filter((l) => l !== label) : [...list, label]) : [label]
}
const answers = computed(() => (props.c.kind === 'question' ? buildAnswers(props.c.questions, picked) : null))
async function sendReply() {
  const t = (drafts[props.s.id] ?? '').trim()
  if (!t) return
  await run('reply', async () => { const ok = await sendInput(props.s.id, t); if (ok) drafts[props.s.id] = ''; return ok })
}
const scopes: { scope: Scope; label: (r: string, w: string) => string }[] = [
  { scope: 'repo', label: (r) => `In ${r}` },
  { scope: 'world', label: (_r, w) => `In ${w ? 'the ' + w + ' world' : 'this world'}` },
  { scope: 'all', label: () => 'Everywhere' },
]
</script>

<template>
  <p class="ask">{{ ask }}</p>

  <template v-if="c.kind === 'permission'">
    <code class="cmd">{{ permissionDetail(c) }}</code>
    <p v-if="c.risky" class="why">Careful: this {{ c.risky }}.</p>
    <div v-if="!cardLive(c)" class="actions">
      <p class="why" style="width:100%">Answer this in the terminal.</p>
      <button class="btn primary" @click="select(s.id); focusTerm()">Open its terminal</button>
    </div>
    <template v-else>
    <div class="actions">
      <button class="btn primary" :disabled="busy[c.requestId]" @click="act(rid, 'allow', () => decidePermission(s.id, rid, 'allow'))">Allow once</button>
      <button class="btn danger" :disabled="busy[c.requestId]" @click="act(rid, 'deny', () => decidePermission(s.id, rid, 'deny'))">Deny</button>
    </div>
    <div v-if="(s.agent ?? 'claude') === 'claude'" class="scope">
      <p v-if="showLearnNudge(c)" class="learn">You've allowed this {{ c.seenCount }} times in {{ s.repoName }}. Stop asking?</p>
      <span class="lbl">Always allow</span>
      <div class="actions">
        <button v-for="o in scopes" :key="o.scope" class="btn" :disabled="busy[c.requestId] || (o.scope === 'all' && !scopeAvailability(c).all)" @click="act(rid, { scope: o.label(s.repoName, world?.name ?? '') }, () => decidePermission(s.id, rid, 'allow', o.scope))">{{ o.label(s.repoName, world?.name ?? '') }}</button>
      </div>
      <p v-if="scopeAvailability(c).allReason" class="soon">"Everywhere" {{ scopeAvailability(c).allReason?.toLowerCase() }}</p>
    </div>
    </template>
  </template>

  <template v-else-if="c.kind === 'question' && !cardLive(c)">
    <div v-for="q in options(c)" :key="q.question" class="ro">
      <p v-if="c.questions.length > 1" class="why">{{ q.header ? q.header + ': ' : '' }}{{ q.question }}</p>
      <ol class="ro-opts"><li v-for="o in q.options" :key="o.label"><b>{{ o.label }}</b><small v-if="o.description" class="why">{{ o.description }}</small></li></ol>
    </div>
    <div class="actions">
      <p class="why" style="width:100%">Type the number in its terminal.</p>
      <button class="btn primary" @click="select(s.id); focusTerm()">Open its terminal</button>
    </div>
  </template>

  <template v-else-if="c.kind === 'question'">
    <div v-for="q in c.questions" :key="q.question" class="actions">
      <p v-if="c.questions.length > 1" class="why" style="width:100%">{{ q.header ? q.header + ': ' : '' }}{{ q.question }}{{ q.multiSelect ? ' (pick any)' : '' }}</p>
      <button v-for="(o, i) in q.options" :key="o.label" :class="['btn', 'opt', { on: isOn(q, o.label) }]" :disabled="busy[c.requestId]" @click="choose(c.requestId, q, o.label)">
        <b>{{ i + 1 }}</b>{{ o.label }}<small v-if="o.description" class="why" style="display:block;margin-left:22px">{{ o.description }}</small>
      </button>
    </div>
    <div v-if="c.questions.length > 1 || c.questions[0]?.multiSelect" class="actions">
      <button class="btn primary" :disabled="!answers || busy[c.requestId]" @click="act(rid, { answers: answers! }, () => answerQuestions(s.id, rid, answers!))">Send answer</button>
    </div>
  </template>

  <template v-else-if="c.kind === 'done'">
    <ReviewBlock v-if="c.review" :id="s.id" :review="c.review" :name="s.repoName" :branch="s.branch" :agent="agentName(s)" />
    <div v-else class="actions"><button class="btn go" :disabled="busy.ack" @click="act('ack', 'ack', () => acknowledge(s.id))">Got it</button></div>
  </template>

  <template v-else>
    <form v-if="!noReply" class="reply" @submit.prevent="sendReply">
      <input v-model="drafts[s.id]" class="reply-in" autocomplete="off" :aria-label="`Reply to ${s.repoName}`" :placeholder="c.kind === 'asking' ? 'Type your answer' : 'Tell it what to do next'" />
      <button class="btn primary" :disabled="!(drafts[s.id] ?? '').trim() || busy.reply">Send</button>
    </form>
    <div v-if="c.kind === 'error'" class="actions"><ContinueIn :session-id="s.id" :current="s.agent ?? 'claude'" :repo-name="s.repoName" primary /><button class="linkbtn" :disabled="busy.ack" @click="act('ack', 'ack', () => acknowledge(s.id))">Dismiss</button></div>
  </template>
</template>
