<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { state, browseFs, createSession, updateWorld, moveRepo, fetchAgents, saveDefaultAgent, startRun, showToast, fetchProviders, saveProviderKey, saveDefaultProvider, addServer, removeServer, type AgentInfo, type ProviderInfo } from '../store'
import { baseName, modeField, withRepo, openHttp, STEP_LABEL, type ModeChoice } from '../logic'
import type { StepKind } from '../types'
import FolderBrowser from './FolderBrowser.vue'
import PermissionSelect from './PermissionSelect.vue'

/** worldId: the world to start in ('' when there is no good guess). fixedWorld: opened from that world's own room, so it is
 *  not asked; from anywhere else (New chat, New run) the guess stays changeable. run opens it with steps already on. */
const props = defineProps<{ worldId: string; run?: boolean; fixedWorld?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const wid = ref(props.worldId)
const world = computed(() => state.worlds.find((w) => w.id === wid.value))
const repo = ref(world.value?.repos[0] ?? '')
watch(wid, () => { repo.value = world.value?.repos[0] ?? '' })
const task = ref('')
const mode = ref<ModeChoice>('claude')
/** The CLI to start; empty until the server says which ones exist (then the server's default applies). */
const agents = ref<AgentInfo[]>([])
const agent = ref('')
const defaultAgent = ref('claude')
const chosen = computed(() => agents.value.find((a) => a.id === agent.value))
onMounted(async () => {
  const r = await fetchAgents()
  if (!r.ok) return
  agents.value = r.data.agents; defaultAgent.value = r.data.default
  agent.value ||= r.data.default
  // A different agent reviews than the one that wrote, when one is installed.
  const other = r.data.agents.find((a) => a.installed && a.id !== r.data.default)?.id ?? r.data.default
  steps.value = steps.value.map((st, i) => ({ ...st, agent: i % 2 ? other : r.data.default }))
})
/** Qwen only: a model provider for this session ('' = whatever the user set up in ~/.qwen). */
const providers = ref<ProviderInfo[]>([])
const provider = ref('')
/** The provider New session starts on for Qwen ('' = your Qwen settings). */
const defaultProvider = ref('')
const prov = computed(() => providers.value.find((p) => p.id === provider.value))
const key = ref('')
const replacingKey = ref(false)
const model = ref('')
watch(provider, () => { key.value = ''; replacingKey.value = false; model.value = '' })
/** provider === ADD: the form for a server of the user's own. */
const ADD = '+add'
const server = ref({ name: '', baseUrl: '', model: '', key: '' })
const adding = ref(false)
/** Adds the server in the form and picks it; false if it couldn't (the error says why). */
async function saveServer(): Promise<boolean> {
  const s = server.value
  if (!s.name.trim() || !s.baseUrl.trim()) { error.value = 'A server needs a name and an address.'; return false }
  adding.value = true; error.value = ''
  const r = await addServer({ name: s.name.trim(), baseUrl: s.baseUrl.trim(), ...(s.model.trim() ? { model: s.model.trim() } : {}), ...(s.key.trim() ? { key: s.key.trim() } : {}) })
  adding.value = false
  if (!r.ok) { error.value = r.error; return false }
  providers.value = [...providers.value.filter((p) => p.id !== r.data.provider.id), r.data.provider]
  provider.value = r.data.provider.id
  server.value = { name: '', baseUrl: '', model: '', key: '' }
  return true
}
async function dropServer(p: ProviderInfo) {
  const r = await removeServer(p.id)
  if (!r.ok) { error.value = r.error; return }
  providers.value = providers.value.filter((x) => x !== p)
  if (defaultProvider.value === p.id) defaultProvider.value = ''
  provider.value = defaultProvider.value
  showToast(`Removed ${p.name}`)
}
watch(agent, async (a) => {
  if (a !== 'qwen' || providers.value.length) return
  const r = await fetchProviders()
  if (!r.ok) { error.value = `Couldn't load the model providers: ${r.error}`; return }
  providers.value = r.data.providers
  defaultProvider.value = provider.value = r.data.default ?? ''
})
/** Run mode: the task goes through these steps, each on its own agent, in one folder. */
const asRun = ref(props.run ?? false)
const steps = ref<{ kind: StepKind; agent: string; checkpoint: boolean }[]>([
  { kind: 'plan', agent: 'claude', checkpoint: false }, { kind: 'review-plan', agent: 'claude', checkpoint: true },
  { kind: 'build', agent: 'claude', checkpoint: false }, { kind: 'review-code', agent: 'claude', checkpoint: true },
])
const kinds = Object.keys(STEP_LABEL) as StepKind[]
const addStep = () => { steps.value.push({ kind: 'review-code', agent: defaultAgent.value, checkpoint: false }) }
async function forgetKey(p: ProviderInfo) {
  const r = await saveProviderKey(p.id, null)
  if (r.ok) { p.hasKey = false; replacingKey.value = false } else error.value = r.error
}
async function makeProviderDefault() {
  const r = await saveDefaultProvider(provider.value)
  if (r.ok) defaultProvider.value = r.data.default ?? ''; else error.value = r.error
}
async function makeDefault() {
  const r = await saveDefaultAgent(agent.value)
  if (r.ok) defaultAgent.value = r.data.default; else error.value = r.error
}
const browsing = ref(false)
const worktree = ref(true)
/** Whether the chosen folder is a git repo (null while unknown): worktrees and branches only make sense there. */
const isGit = ref<boolean | null>(null)
watch(repo, async (path) => {
  isGit.value = null
  const parent = path.replace(/\/[^/]+$/, '') || '/'
  const r = path ? await browseFs(parent) : null
  if (repo.value === path) isGit.value = r?.ok ? (r.data.entries.find((e) => e.path === path)?.isRepo ?? false) : null
}, { immediate: true })
const branch = ref('')
const error = ref('')
const sending = ref(false)
const box = ref<HTMLElement | null>(null)
onMounted(() => box.value?.querySelector<HTMLElement>(props.worldId ? 'textarea' : 'select')?.focus())

/** A folder picked in the browser joins this world and becomes the repo to start in. */
async function addFolder(path: string) {
  const w = world.value
  if (!w) return
  const r = await updateWorld(w.id, { repos: withRepo(w.repos, path) })
  if (r.ok) { repo.value = path; browsing.value = false } else error.value = r.error
}
async function moveFolder(path: string, fromId: string) {
  const w = world.value
  if (!w) return
  const err = await moveRepo(path, fromId, w.id)
  if (err) error.value = err; else { repo.value = path; browsing.value = false }
}
async function submit() {
  if (sending.value) return
  if (!wid.value) { error.value = 'Pick a world.'; return }
  if (!repo.value) { error.value = 'Pick a folder.'; return }
  if (asRun.value) {
    if (!task.value.trim()) { error.value = 'A run needs a task.'; return }
    if (!steps.value.length) { error.value = 'Add at least one step.'; return }
    sending.value = true; error.value = ''
    const r = await startRun({ worldId: wid.value, repo: repo.value, task: task.value.trim(), worktree: worktree.value && isGit.value !== false, steps: steps.value })
    sending.value = false
    if (!r.ok) { error.value = r.error; return }
    showToast(`Run started: ${STEP_LABEL[steps.value[0].kind]} first`)
    return emit('close')
  }
  if (agent.value === 'qwen' && provider.value === ADD && !(await saveServer())) return
  const p = agent.value === 'qwen' ? prov.value : undefined
  if (p && !p.hasKey && !p.custom && !key.value.trim()) { error.value = `Paste your ${p.name} key, or pick “Your Qwen settings”.`; return }
  sending.value = true; error.value = ''
  if (p && key.value.trim()) {
    const r = await saveProviderKey(p.id, key.value.trim())
    if (!r.ok) { sending.value = false; error.value = r.error; return }
    p.hasKey = true; key.value = ''; replacingKey.value = false
  }
  const err = await createSession({ worldId: wid.value, repo: repo.value, task: task.value.trim(), worktree: worktree.value && isGit.value !== false, ...(agent.value ? { agent: agent.value } : {}), ...(p ? { provider: p.id, ...(model.value.trim() ? { model: model.value.trim() } : {}) } : {}), ...(chosen.value?.modes === false ? {} : modeField(mode.value)), ...(isGit.value !== false && branch.value.trim() ? { branch: branch.value.trim() } : {}) })
  sending.value = false
  if (err) error.value = err
  else emit('close')
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div v-if="browsing && world" class="dialog form" role="dialog" aria-modal="true" aria-label="Add a folder">
      <h2>Add a folder to {{ world.name }}</h2>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <FolderBrowser :world-id="world.id" :start="repo" @pick="addFolder" @move="moveFolder" @back="browsing = false" />
    </div>
    <form v-else ref="box" class="dialog form" role="dialog" aria-modal="true" aria-label="New session" @submit.prevent="submit">
      <h2>{{ asRun ? 'New run' : 'New session' }}{{ world ? ` in ${world.name}` : '' }}</h2>
      <label v-if="!fixedWorld && (!worldId || state.worlds.length > 1)">World
        <select v-model="wid" aria-label="World"><option value="" disabled>Choose a world</option><option v-for="w in state.worlds" :key="w.id" :value="w.id">{{ w.name }}</option></select>
      </label>
      <div v-if="wid && !world?.repos.length" class="empty-folders">
        <p class="why">This world has no folders yet.</p>
        <button type="button" class="btn" @click="browsing = true">Add a folder</button>
      </div>
      <div v-else-if="wid" class="folder-row">
        <label>Folder
          <select v-model="repo"><option v-for="r in world?.repos ?? []" :key="r" :value="r">{{ baseName(r) }} ({{ r }})</option></select>
        </label>
        <button type="button" class="btn" @click="browsing = true">Another folder…</button>
      </div>
      <label>{{ asRun ? 'Task' : 'Task (optional)' }}
        <textarea v-model="task" :placeholder="asRun ? 'What the run should get done' : chosen?.task === false ? 'Names the session and its branch' : 'Leave empty to start a blank session'" />
      </label>
      <label class="row"><input v-model="asRun" type="checkbox"> Run it through steps, each on its own agent</label>
      <fieldset v-if="asRun" class="run-steps">
        <legend class="why">One session per step, all in the same folder. Each step starts on its own when the one before finishes, except after a step marked “Pause after”: then it waits for you.</legend>
        <div v-for="(st, i) in steps" :key="i" class="run-step">
          <span>{{ i + 1 }}.</span>
          <select v-model="st.kind" :aria-label="`Step ${i + 1}`"><option v-for="k in kinds" :key="k" :value="k">{{ STEP_LABEL[k] }}</option></select>
          <select v-model="st.agent" :aria-label="`Step ${i + 1} agent`"><option v-for="a in agents" :key="a.id" :value="a.id" :disabled="!a.installed">{{ a.name }}</option></select>
          <label class="row" title="When this step finishes, wait for you before the next one starts"><input v-model="st.checkpoint" type="checkbox"> Pause after</label>
          <button type="button" class="btn" :aria-label="`Remove step ${i + 1}`" @click="steps.splice(i, 1)">×</button>
        </div>
        <button v-if="steps.length < 8" type="button" class="btn" @click="addStep">Add a step</button>
      </fieldset>
      <div v-if="agents.length > 1 && !asRun" class="folder-row">
        <label>Agent
          <select v-model="agent" aria-label="Agent"><option v-for="a in agents" :key="a.id" :value="a.id" :disabled="!a.installed">{{ a.name }}{{ a.id === defaultAgent ? ' (default)' : a.installed ? '' : ' (not installed)' }}</option></select>
        </label>
        <button v-if="agent && agent !== defaultAgent" type="button" class="btn" @click="makeDefault">Make default</button>
      </div>
      <template v-if="!asRun && agent === 'qwen' && providers.length">
        <div class="folder-row">
          <label>Model provider
            <select v-model="provider" aria-label="Model provider"><option value="">Your Qwen settings{{ defaultProvider ? '' : ' (default)' }}</option><option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}{{ p.id === defaultProvider ? ' (default)' : p.hasKey || p.custom ? '' : ' (needs a key)' }}</option><option :value="ADD">Add a server of your own…</option></select>
          </label>
          <button v-if="provider !== ADD && provider !== defaultProvider" type="button" class="btn" @click="makeProviderDefault">Make default</button>
        </div>
        <template v-if="provider === ADD">
          <p class="why">Any server that speaks the OpenAI API: a friend's llama.cpp, vLLM, LM Studio or Ollama. Sessions on it send it your prompts and the code the agent reads. It is saved on this computer for later sessions; pressing Start saves it too.</p>
          <label>Name
            <input @keydown.enter.prevent="saveServer" v-model="server.name" type="text" autocomplete="off" placeholder="Sam's Qwen">
          </label>
          <label>Address (usually ends in /v1)
            <input @keydown.enter.prevent="saveServer" v-model="server.baseUrl" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://192.168.1.20:8080/v1" :aria-describedby="openHttp(server.baseUrl) ? 'server-note' : undefined">
          </label>
          <p v-if="openHttp(server.baseUrl)" id="server-note" class="why warn" role="status">This is plain http to a server outside your network: your prompts and code travel unencrypted, and anyone on the way can read them. Use https if the server offers it.</p>
          <label>Model (optional; empty asks the server)
            <input @keydown.enter.prevent="saveServer" v-model="server.model" type="text" autocomplete="off" spellcheck="false">
          </label>
          <label>API key (optional; most servers of your own have none)
            <input @keydown.enter.prevent="saveServer" v-model="server.key" type="password" autocomplete="off" spellcheck="false" placeholder="Leave empty if it has none">
          </label>
          <button type="button" class="btn" :disabled="adding" @click="saveServer">{{ adding ? 'Checking the server…' : 'Add server' }}</button>
        </template>
        <template v-if="prov">
          <p class="why">{{ prov.custom ? 'Saved for later sessions.' : 'Only this session uses it.' }} Your own Qwen settings stay as they are.</p>
          <p v-if="prov.custom" class="why">Your server at <code>{{ prov.baseUrl }}</code>.
            <button type="button" class="btn" @click="dropServer(prov)">Remove server</button>
          </p>
          <p v-if="prov.custom && !prov.hasKey && !replacingKey" class="why">No key: sessions connect without one.
            <button type="button" class="btn" @click="replacingKey = true">Add a key</button>
          </p>
          <template v-else-if="!prov.hasKey || replacingKey">
            <p id="key-note" class="why">The key is kept on this computer only (in <code>keys.json</code> in the Agent Worlds folder) until you replace or forget it, and is never shown again. <a v-if="prov.keyUrl" :href="prov.keyUrl" target="_blank" rel="noopener">Get a {{ prov.name }} key</a></p>
            <label>{{ prov.name }} API key{{ prov.custom ? ' (optional)' : '' }}
              <input v-model="key" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your key" aria-describedby="key-note">
            </label>
            <button v-if="replacingKey" type="button" class="btn" @click="replacingKey = false; key = ''">{{ prov.hasKey ? 'Keep the saved key' : 'No key' }}</button>
          </template>
          <p v-else class="why">Your {{ prov.name }} key is saved on this computer.
            <button type="button" class="btn" @click="replacingKey = true">Replace key</button>
            <button type="button" class="btn" @click="forgetKey(prov)">Forget key</button>
          </p>
          <label>Model (optional; empty means {{ prov.model }})
            <input v-model="model" type="text" autocomplete="off" spellcheck="false" :placeholder="prov.model">
          </label>
        </template>
      </template>
      <template v-if="!asRun">
      <PermissionSelect v-if="chosen?.modes !== false" v-model="mode" />
      <p v-else-if="chosen.decides === false" class="why">{{ chosen.name }} asks for permission in its own terminal. Needs you shows the request; answer it in the terminal.</p>
      <p v-else-if="chosen.id === 'gemini'" class="why">Free with an AI Studio API key: the first time, Gemini CLI asks for it and to trust the folder, in its terminal. After that it won't ask there: every edit, command or web fetch waits under Needs you until you allow or deny it.</p>
      <p v-else class="why">{{ chosen.name }} asks for permission its own way; allow or deny each request under Needs you.</p>
      <p v-if="chosen?.id === 'agy'" class="why">Free with a Google account: the first time, Antigravity CLI asks you to sign in, in its terminal. Your repo and your own Antigravity settings stay as they are. It can't message your other sessions.</p>
      <p v-if="chosen?.task === false" class="why">{{ chosen.name }} can't be handed a task when it starts: once it opens, type your first message in its terminal.</p>
      </template>
      <template v-if="isGit !== false">
        <label class="row"><input v-model="worktree" type="checkbox"> Use a new worktree</label>
        <label v-if="!asRun">Branch name (optional)
          <input v-model="branch" type="text" placeholder="feat/something" autocomplete="off">
        </label>
      </template>
      <p v-else class="why">Not a git repo, so the session starts right in this folder.</p>
      <details v-if="!state.tmux" class="why no-tmux">
        <summary>Works without tmux · install it to keep sessions across restarts</summary>
        Nothing to do: this session runs inside Agent Worlds, and you never have to touch tmux. With tmux installed you would also get:
        <ul>
          <li>Sessions that keep running when Agent Worlds restarts or updates. Without it they end (you can resume them from Recent sessions).</li>
          <li>The same live session in your own terminal (<code>agent-worlds attach</code>), not only in the browser.</li>
        </ul>
        Install it with <code>sudo dnf install tmux</code>, <code>sudo apt install tmux</code> or <code>brew install tmux</code>, then restart Agent Worlds.
      </details>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="btn primary" :disabled="sending || !repo">{{ sending ? 'Starting…' : asRun ? 'Start run' : 'Start' }}</button>
        <button type="button" class="btn" @click="emit('close')">Cancel</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.run-steps { border: 1px solid var(--line, #3a4150); border-radius: 8px; padding: 8px 10px; display: grid; gap: 6px; }
.run-step { display: grid; grid-template-columns: auto 1fr 1fr auto auto; align-items: center; gap: 6px; }
.run-step .row { white-space: nowrap; }
@media (max-width: 520px) { .run-step { grid-template-columns: auto 1fr 1fr; } }
</style>
