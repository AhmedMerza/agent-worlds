<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { Session, Question, Card } from '../types'
import { fmtWait, waitMinutes, buildAnswers } from '../logic'
import { state, needsYou, groups, select, decidePermission, answerQuestions, acknowledge } from '../store'

const items = computed(() => needsYou.value.map((s) => ({ s, c: s.card! })))
const cardKey = (c: Card) => (c.kind === 'permission' || c.kind === 'question' ? c.requestId : c.kind)
const busy = reactive<Record<string, boolean>>({})
// picked[sessionId][question] = chosen labels
const picked = reactive<Record<string, Record<string, string[]>>>({})

const tint = (s: Session) => groups.value.find((g) => g.sessions.includes(s))?.world.color ?? '#8a92a0'
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
async function run(s: Session, key: string, fn: () => Promise<boolean>) {
  if (busy[key]) return
  busy[key] = true
  try { await fn() } finally { busy[key] = false }
}
function isOn(id: string, q: Question, label: string) { return !!picked[id]?.[q.question]?.includes(label) }
function choose(s: Session, requestId: string, q: Question, label: string) {
  const c = s.card
  if (c?.kind !== 'question') return
  if (c.questions.length === 1 && !q.multiSelect) {
    run(s, requestId, () => answerQuestions(s.id, requestId, { [q.question]: label }))
    return
  }
  const cur = (picked[s.id] ??= {})
  const list = cur[q.question] ?? []
  cur[q.question] = q.multiSelect ? (list.includes(label) ? list.filter((l) => l !== label) : [...list, label]) : [label]
}
function answers(s: Session) {
  const c = s.card
  return c?.kind === 'question' ? buildAnswers(c.questions, picked[s.id] ?? {}) : null
}
</script>

<template>
  <section class="panel" aria-label="Needs you">
    <h3>Needs you <span class="count">{{ needsYou.length }}</span><span class="hint">oldest first</span></h3>
    <p v-if="!needsYou.length" class="empty">Nothing needs you. Every session is working or idle.</p>
    <article v-for="{ s, c } in items" :key="s.id + ':' + cardKey(c)" :class="['card', { current: state.selectedId === s.id }]" :style="{ '--tint': tint(s) }">
      <div class="who">
        <span :class="['dot', s.state]" /><b>{{ s.repoName }}</b> {{ WHO[c.kind] }} ·
        <span :class="['wait', { late: waitMinutes(s, state.now) >= 20 }]">{{ fmtWait(waitMinutes(s, state.now)) }}</span>
      </div>
      <p class="ask">{{ ask(c) }}</p>

      <template v-if="c.kind === 'permission'">
        <code class="cmd">{{ c.command ?? inputText(c.input) }}</code>
        <p v-if="c.risky" class="why">Careful: this {{ c.risky }}.</p>
        <div class="actions">
          <button class="btn primary" :disabled="busy[c.requestId]" @click="run(s, c.requestId, () => decidePermission(s.id, c.requestId, 'allow'))">Allow once</button>
          <button class="btn danger" :disabled="busy[c.requestId]" @click="run(s, c.requestId, () => decidePermission(s.id, c.requestId, 'deny'))">Deny</button>
        </div>
        <div class="scope">
          <span class="lbl">Always allow</span>
          <div class="actions">
            <button class="btn" disabled>In {{ s.repoName }}</button>
            <button class="btn" disabled>In this world</button>
            <button class="btn" disabled>Everywhere</button>
          </div>
          <p class="soon">Coming soon. For now each request is allowed once.</p>
        </div>
      </template>

      <template v-else-if="c.kind === 'question'">
        <div v-for="q in c.questions" :key="q.question" class="actions">
          <p v-if="c.questions.length > 1" class="why" style="width:100%">{{ q.header ? q.header + ": " : "" }}{{ q.question }}{{ q.multiSelect ? ' (pick any)' : '' }}</p>
          <button v-for="(o, i) in q.options" :key="o.label" :class="['btn', 'opt', { on: isOn(s.id, q, o.label) }]" :disabled="busy[c.requestId]" @click="choose(s, c.requestId, q, o.label)">
            <b>{{ i + 1 }}</b>{{ o.label }}<small v-if="o.description" class="why" style="display:block;margin-left:22px">{{ o.description }}</small>
          </button>
        </div>
        <div v-if="c.questions.length > 1 || c.questions[0].multiSelect" class="actions">
          <button class="btn primary" :disabled="!answers(s) || busy[c.requestId]" @click="run(s, c.requestId, () => answerQuestions(s.id, c.requestId, answers(s)!))">Send answer</button>
        </div>
      </template>

      <template v-else-if="c.kind === 'done'">
        <template v-if="c.review">
          <ul class="files"><li v-for="f in c.review.files" :key="f.path"><span>{{ f.path }}</span><b class="add">+{{ f.added }}</b><b class="del">−{{ f.deleted }}</b></li></ul>
          <p v-if="c.review.tests" :class="['why', 'review-tests', { bad: !c.review.tests.ok }]">Tests: {{ c.review.tests.line }}</p>
          <details><summary>View the diff</summary>
            <pre class="diff"><span v-for="(l, i) in c.review.diff.split('\n')" :key="i" :class="l.startsWith('@@') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : ''">{{ l }}{{ '\n' }}</span></pre>
          </details>
        </template>
        <div class="actions"><button class="btn go" :disabled="busy[s.id]" @click="run(s, s.id, () => acknowledge(s.id))">Got it</button></div>
      </template>

      <template v-else>
        <div class="actions"><button class="btn" :disabled="busy[s.id]" @click="run(s, s.id, () => acknowledge(s.id))">Dismiss</button></div>
      </template>

      <button class="linkbtn" @click="select(s.id)">Open its terminal</button>
    </article>
  </section>
</template>
