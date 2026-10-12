<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { Session, Question, Card } from '../types'
import { fmtWait, waitMinutes, buildAnswers, scopeAvailability, showLearnNudge, cardLive } from '../logic'
import { state, needsYou, groups, select, decidePermission, answerQuestions, acknowledge, sendInput, focusTerminal as focusTerm, type Scope } from '../store'
import ReviewBlock from './ReviewBlock.vue'

const items = computed(() => needsYou.value.map((s) => ({ s, c: s.card! })))
const cardKey = (c: Card) => (c.kind === 'permission' || c.kind === 'question' ? c.requestId : c.kind)
const busy = reactive<Record<string, boolean>>({})
const picked = reactive<Record<string, Record<string, string[]>>>({})
const reply = reactive<Record<string, string>>({})

const world = (s: Session) => groups.value.find((g) => g.sessions.includes(s))?.world
const WHO = { permission: 'wants to run a command', question: 'is asking you', done: 'finished', error: 'hit a problem' } as const

function ask(c: Card): string {
  if (c.kind === 'permission') return c.command ? 'Run this command?' : `Allow ${c.tool}?`
  if (c.kind === 'question') return c.questions.length === 1 ? c.questions[0].question : `${c.questions.length} questions`
  if (c.kind === 'done') return c.summary ?? 'Finished'
  return c.summary
}
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
  <section class="panel" aria-label="Needs you">
    <h3>Needs you <span class="count">{{ needsYou.length }}</span><span class="hint">oldest first</span></h3>
    <p v-if="!needsYou.length" class="empty">Nothing needs you. Every session is working or idle.</p>
    <article v-for="{ s, c } in items" :key="s.id + ':' + cardKey(c)" :class="['card', { current: state.selectedId === s.id }]" :style="{ '--tint': world(s)?.color ?? '#8a92a0' }">
      <div class="who">
        <span :class="['dot', s.state]" /><b>{{ s.repoName }}</b> {{ WHO[c.kind] }} ·
        <span :class="['wait', { late: waitMinutes(s, state.now) >= 20 }]">{{ fmtWait(waitMinutes(s, state.now)) }}</span>
      </div>
      <p class="ask">{{ ask(c) }}</p>

      <template v-if="c.kind === 'permission'">
        <code class="cmd">{{ c.command ?? inputText(c.input) }}</code>
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
        <div class="scope">
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
        <p class="why">{{ c.questions.map((q) => q.question).join(' ') }}</p>
        <div class="actions">
          <p class="why" style="width:100%">Answer this in the terminal.</p>
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
        <ReviewBlock v-if="c.review" :id="s.id" :review="c.review" />
        <div v-else class="actions"><button class="btn go" :disabled="busy[s.id]" @click="run(s.id, () => acknowledge(s.id))">Got it</button></div>
      </template>

      <template v-else>
        <form class="reply" @submit.prevent="sendReply(s)">
          <input v-model="reply[s.id]" class="reply-in" autocomplete="off" :aria-label="`Reply to ${s.repoName}`" placeholder="Tell it what to do next" />
          <button class="btn primary" :disabled="!(reply[s.id] ?? '').trim() || busy[s.id + ':reply']">Send</button>
        </form>
        <div class="actions"><button class="btn" :disabled="busy[s.id]" @click="run(s.id, () => acknowledge(s.id))">Dismiss</button></div>
      </template>

      <button class="linkbtn" @click="select(s.id); focusTerm()">Open its terminal</button>
    </article>
  </section>
</template>
