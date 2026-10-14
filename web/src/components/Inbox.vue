<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { Session, Question, Card } from '../types'
import { fmtWait, permissionAsk, permissionWho, permissionDetail, waitMinutes, buildAnswers, scopeAvailability, showLearnNudge, cardLive, inboxOrder } from '../logic'
import { state, needsYou, groups, select, decidePermission, answerQuestions, acknowledge, sendInput, focusTerminal as focusTerm, type Scope } from '../store'
import ReviewBlock from './ReviewBlock.vue'

const cardKey = (c: Card) => (c.kind === 'permission' || c.kind === 'question' ? c.requestId : c.kind)
const keyOf = (s: Session) => s.id + ':' + cardKey(s.card!)
// While the pointer is over the inbox the cards hold their places (so a click never lands on a different card); new ones go last, highlighted.
const hover = ref(false)
const order = ref<string[]>([])
const fresh = ref<string[]>([])
let freshTimer: ReturnType<typeof setTimeout> | undefined
watch([() => needsYou.value.map(keyOf).join('|'), hover], () => {
  const next = needsYou.value.map(keyOf)
  if (hover.value) fresh.value = [...new Set([...fresh.value, ...next.filter((k) => !order.value.includes(k))])]
  else { clearTimeout(freshTimer); freshTimer = setTimeout(() => { fresh.value = [] }, 2500) }
  order.value = inboxOrder(order.value, next, hover.value)
}, { immediate: true })
const items = computed(() => {
  const by = new Map(needsYou.value.map((s) => [keyOf(s), s]))
  return order.value.flatMap((k) => { const s = by.get(k); return s ? [{ s, c: s.card!, k }] : [] })
})
const busy = reactive<Record<string, boolean>>({})
const picked = reactive<Record<string, Record<string, string[]>>>({})
const reply = reactive<Record<string, string>>({})

const world = (s: Session) => groups.value.find((g) => g.sessions.includes(s))?.world
const WHO = { question: 'is asking you', asking: 'is asking you', done: 'finished', error: 'hit a problem' } as const
const who = (c: Card): string => (c.kind === 'permission' ? permissionWho(c) : WHO[c.kind])

function ask(c: Card): string {
  if (c.kind === 'permission') return permissionAsk(c)
  if (c.kind === 'question') return c.questions.length === 1 ? c.questions[0].question : `${c.questions.length} questions`
  if (c.kind === 'done') return c.summary ?? 'Finished'
  return c.summary
}
const options = (c: Extract<Card, { kind: 'question' }>) => c.questions.filter((q) => q.options.length)
function inputText(input: unknown): string {
  try { return JSON.stringify(input, null, 2) ?? '' } catch { return String(input) }
}
async function run(key: string, fn: () => Promise<boolean>) {
  if (busy[key]) return
  busy[key] = true
  try { await fn() } finally { busy[key] = false }
}
const isOn = (id: string, q: Question, label: string) => !!picked[id]?.[q.question]?.includes(label)
function choose(s: Session, requestId: string, q: Question, label: string) {
  const c = s.card
  if (c?.kind !== 'question') return
  if (c.questions.length === 1 && !q.multiSelect) { run(requestId, () => answerQuestions(s.id, requestId, { [q.question]: label })); return }
  const cur = (picked[s.id] ??= {})
  const list = cur[q.question] ?? []
  cur[q.question] = q.multiSelect ? (list.includes(label) ? list.filter((l) => l !== label) : [...list, label]) : [label]
}
const answers = (s: Session) => (s.card?.kind === 'question' ? buildAnswers(s.card.questions, picked[s.id] ?? {}) : null)
async function sendReply(s: Session) {
  const t = (reply[s.id] ?? '').trim()
  if (!t) return
  await run(s.id + ':reply', async () => { const ok = await sendInput(s.id, t); if (ok) reply[s.id] = ''; return ok })
}
const scopes: { scope: Scope; label: (r: string, w: string) => string }[] = [
  { scope: 'repo', label: (r) => `In ${r}` },
  { scope: 'world', label: (_r, w) => `In ${w ? 'the ' + w + ' world' : 'this world'}` },
  { scope: 'all', label: () => 'Everywhere' },
]
</script>

<template>
  <section class="panel" aria-label="Needs you" @mouseenter="hover = true" @mouseleave="hover = false">
    <h3>Needs you <span class="count">{{ needsYou.length }}</span><span class="hint">permissions first, then oldest</span></h3>
    <p v-if="!needsYou.length" class="empty">Nothing needs you. Every session is working or idle.</p>
    <TransitionGroup name="card" tag="div" class="cards">
    <article v-for="{ s, c, k } in items" :key="k" :class="['card', { current: state.selectedId === s.id, fresh: fresh.includes(k) }]" :style="{ '--tint': world(s)?.color ?? '#8a92a0' }">
      <div class="who">
        <span :class="['dot', s.state]" /><b>{{ s.repoName }}</b>
        <span v-if="s.branch" class="tag" :title="s.cwd">{{ s.branch }}</span><span v-if="s.worktree" class="tag">worktree</span>
        {{ who(c) }} ·
        <span :class="['wait', { late: waitMinutes(s, state.now) >= 20 }]">{{ fmtWait(waitMinutes(s, state.now), s.state) }}</span>
      </div>
      <p class="ask">{{ ask(c) }}</p>

      <template v-if="c.kind === 'permission'">
        <code class="cmd">{{ permissionDetail(c) }}</code>
        <p v-if="c.risky" class="why">Careful: this {{ c.risky }}.</p>
        <div v-if="!cardLive(c)" class="actions">
          <p class="why" style="width:100%">Answer this in the terminal.</p>
          <button class="btn primary" @click="select(s.id); focusTerm()">Open its terminal</button>
        </div>
        <template v-else>
        <div class="actions">
          <button class="btn primary" :disabled="busy[c.requestId]" @click="run(c.requestId, () => decidePermission(s.id, c.requestId, 'allow'))">Allow once</button>
          <button class="btn danger" :disabled="busy[c.requestId]" @click="run(c.requestId, () => decidePermission(s.id, c.requestId, 'deny'))">Deny</button>
        </div>
        <div v-if="(s.agent ?? 'claude') === 'claude'" class="scope">
          <p v-if="showLearnNudge(c)" class="learn">You've allowed this {{ c.seenCount }} times in {{ s.repoName }}. Stop asking?</p>
          <span class="lbl">Always allow</span>
          <div class="actions">
            <button v-for="o in scopes" :key="o.scope" class="btn" :disabled="busy[c.requestId] || (o.scope === 'all' && !scopeAvailability(c).all)" @click="run(c.requestId, () => decidePermission(s.id, c.requestId, 'allow', o.scope))">{{ o.label(s.repoName, world(s)?.name ?? '') }}</button>
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
          <button v-for="(o, i) in q.options" :key="o.label" :class="['btn', 'opt', { on: isOn(s.id, q, o.label) }]" :disabled="busy[c.requestId]" @click="choose(s, c.requestId, q, o.label)">
            <b>{{ i + 1 }}</b>{{ o.label }}<small v-if="o.description" class="why" style="display:block;margin-left:22px">{{ o.description }}</small>
          </button>
        </div>
        <div v-if="c.questions.length > 1 || c.questions[0]?.multiSelect" class="actions">
          <button class="btn primary" :disabled="!answers(s) || busy[c.requestId]" @click="run(c.requestId, () => answerQuestions(s.id, c.requestId, answers(s)!))">Send answer</button>
        </div>
      </template>

      <template v-else-if="c.kind === 'done'">
        <ReviewBlock v-if="c.review" :id="s.id" :review="c.review" :name="s.repoName" :branch="s.branch" />
        <div v-else class="actions"><button class="btn go" :disabled="busy[s.id]" @click="run(s.id, () => acknowledge(s.id))">Got it</button></div>
      </template>

      <template v-else>
        <form class="reply" @submit.prevent="sendReply(s)">
          <input v-model="reply[s.id]" class="reply-in" autocomplete="off" :aria-label="`Reply to ${s.repoName}`" :placeholder="c.kind === 'asking' ? 'Type your answer' : 'Tell it what to do next'" />
          <button class="btn primary" :disabled="!(reply[s.id] ?? '').trim() || busy[s.id + ':reply']">Send</button>
        </form>
        <div v-if="c.kind === 'error'" class="actions"><button class="btn" :disabled="busy[s.id]" @click="run(s.id, () => acknowledge(s.id))">Dismiss</button></div>
      </template>

      <button v-if="cardLive(c)" class="linkbtn" @click="select(s.id); focusTerm()">Open its terminal</button>
    </article>
    </TransitionGroup>
  </section>
</template>
