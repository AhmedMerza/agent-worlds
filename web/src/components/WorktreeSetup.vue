<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { World } from '../types'
import { updateWorld } from '../store'
import { DUR, EASE, pop, reduced, staggerOf } from '../motion'
import { gsap } from 'gsap'

const props = defineProps<{ world: World; repo: string; reveal?: boolean }>()
const saved = computed(() => props.world.worktreeSetup?.[props.repo])
const mode = computed(() => saved.value?.enabled === false ? 'Off' : saved.value?.command?.trim() ? 'Custom' : 'Automatic')
const enabled = ref(saved.value?.enabled !== false)
const command = ref(saved.value?.command ?? '')
const timeout = ref(saved.value?.timeoutSeconds ?? 600)
const busy = ref(false), error = ref(''), message = ref('')
const badge = ref<HTMLElement | null>(null), fields = ref<HTMLElement | null>(null)
let entrance: gsap.Context | null = null
function opened(e: Event) {
  entrance?.revert()
  if (!(e.target as HTMLDetailsElement).open || !fields.value || reduced()) return
  entrance = gsap.context(() => {
    const rows = fields.value!.querySelectorAll('p, fieldset > label, fieldset > button')
    gsap.from(rows, { y: props.reveal ? 3 : 8, opacity: 0, duration: props.reveal ? DUR.content / 3 : DUR.content, ease: EASE.content, stagger: props.reveal ? 0 : staggerOf(rows.length), clearProps: 'transform,opacity' })
  }, fields.value)
}
async function save() {
  busy.value = true; error.value = ''; message.value = ''
  try {
    const r = await updateWorld(props.world.id, { worktreeSetup: { [props.repo]: { enabled: enabled.value, command: command.value, timeoutSeconds: timeout.value } } })
    if (!r.ok) { error.value = r.error; return }
    message.value = 'Saved for new worktrees.'
    await nextTick(); pop(badge.value)
  } finally { busy.value = false }
}
onBeforeUnmount(() => entrance?.revert())
</script>

<template>
  <details class="repo-setup" :open="reveal" @toggle="opened">
    <summary>Worktree setup <span ref="badge" :class="['pill', mode === 'Off' ? 'idle' : 'working']">{{ mode }}</span></summary>
    <form ref="fields" class="setup-form" @submit.prevent="save">
      <p class="why">Before the agent starts, copy <code>.env*</code> from the main checkout and install Composer / Flutter dependencies. A main checkout's <code>.worktreeinclude</code> replaces the copy list with matching ignored files.</p>
      <p class="why">Setup runs repository code, including install scripts. Its output stays in the terminal; failure or timeout blocks the agent.</p>
      <fieldset :disabled="busy">
        <label class="setup-toggle"><input v-model="enabled" type="checkbox"> Prepare new worktrees</label>
        <p v-if="!enabled" class="why">Off: skip both copying files and installing dependencies.</p>
        <label>Setup command <small class="why">Optional · replaces automatic dependency installs</small>
          <textarea v-model="command" class="reply-in" rows="2" maxlength="4000" :disabled="!enabled" placeholder="Automatic: composer install / flutter pub get" :aria-label="`Setup command for ${repo}`" spellcheck="false" dir="ltr" />
        </label>
        <label class="setup-timeout">Stop setup after <input v-model.number="timeout" class="reply-in" type="number" min="1" max="3600" required :disabled="!enabled" :aria-label="`Setup timeout in seconds for ${repo}`"> seconds</label>
        <button class="btn" type="submit">{{ busy ? 'Saving…' : 'Save worktree setup' }}</button>
      </fieldset>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p class="why" role="status" aria-live="polite">{{ busy ? 'Saving setup settings…' : message }}</p>
    </form>
  </details>
</template>

<style scoped>
.repo-setup{margin-block-start:8px;min-width:0;font-size:14px}
summary{cursor:pointer;min-height:44px;padding-block:8px;overflow-wrap:anywhere}
summary:hover{color:var(--work)}
summary:focus-visible{outline:2px solid var(--work);outline-offset:2px;border-radius:4px}
summary .pill{margin-inline-start:8px;display:inline-block}
.setup-form{display:grid;gap:12px;padding-block:8px;min-width:0}
.setup-form p{margin:0;overflow-wrap:anywhere}
fieldset{border:0;padding:0;margin:0;min-width:0;display:grid;gap:12px}
label:not(.setup-toggle):not(.setup-timeout){display:grid;gap:6px}
.setup-toggle{display:flex;align-items:center;gap:8px;min-height:44px}
.setup-timeout{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.setup-timeout input{width:90px}
textarea{width:100%;resize:vertical;font-family:var(--f-mono);min-height:64px}
input,button{min-height:44px}
.btn{justify-self:start}
.btn:active:not(:disabled){transform:scale(.97)}
@media(prefers-reduced-motion:reduce){.btn:active:not(:disabled){transform:none}}
</style>
