<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { enterRow, leaveRow, pop } from '../motion'
import { showToast } from '../store'

type Row = { dir: string; branch: string | null; owned: boolean; bytes: number | null; ageMs: number; live: boolean | null; reason: string | null }
const props = defineProps<{ repo: string }>()
const refusal = ref<{ dir: string; message: string } | null>(null)
const rows = ref<Row[]>([]), loading = ref(false), loaded = ref(false), error = ref(''), busy = ref<string | null>(null), confirm = ref<string | null>(null)
const limit = ref(20), summary = ref<HTMLElement | null>(null)
const shown = computed(() => rows.value.slice(0, limit.value))
const size = (n: number | null) => n === null ? 'Size unknown' : n < 1024 ** 2 ? `${Math.ceil(n / 1024).toLocaleString()} KB` : `${(n / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
const age = (ms: number) => { const days = Math.floor(ms / 86400_000); return days === 0 ? 'Created today' : `Created ${days.toLocaleString()} day${days === 1 ? '' : 's'} ago` }
let controller: AbortController | null = null
onBeforeUnmount(() => controller?.abort())
async function load() {
  loading.value = true; error.value = ''; controller?.abort(); controller = new AbortController()
  try {
    const res = await fetch(`/api/worktrees?repo=${encodeURIComponent(props.repo)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) })
    if (!res.ok) throw new Error('Could not inspect worktrees. Retry when the server is available.')
    rows.value = (await res.json()).worktrees; loaded.value = true
  } catch (e) { error.value = (e as Error).name === 'TimeoutError' ? 'Inspection timed out. Refresh to try again.' : (e as Error).message }
  finally { loading.value = false }
}
async function remove(row: Row) {
  busy.value = row.dir; error.value = ''; refusal.value = null; controller = new AbortController()
  try {
    const res = await fetch('/api/worktrees/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dir: row.dir, confirm: true }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]) })
    const r = await res.json()
    if (!res.ok || !r.removed) { refusal.value = { dir: row.dir, message: `Kept ${row.branch ?? row.dir}: ${r.reason ?? r.error ?? 'safety checks did not pass'}.` }; return }
    rows.value = rows.value.filter((r) => r.dir !== row.dir); confirm.value = null
    showToast(r.reason ?? `Removed the worktree ${row.branch ?? row.dir} and its local branch. The remote branch stays.`)
    await nextTick(); summary.value?.focus({ preventScroll: true }); pop(summary.value, .98)
  } catch { refusal.value = { dir: row.dir, message: 'Removal could not be confirmed. Refresh to check the current folder state.' } }
  finally { busy.value = null }
}
</script>

<template>
  <details class="worktree-list" @toggle="($event.target as HTMLDetailsElement).open && !loaded && !loading && load()">
    <summary ref="summary" :aria-label="`Worktrees for ${repo}`">Worktrees</summary>
    <p class="why wt-policy">Agent Worlds checks its own worktrees hourly. Removal requires a matching merged request, three days since merge, a clean checkout, all commits pushed and no running process. Ignored files and run notes stay protected.</p>
    <div class="actions"><button class="btn" :disabled="loading || !!busy" :aria-label="`Refresh worktrees for ${repo}`" @click="load">{{ loading ? 'Inspecting folders…' : 'Refresh worktrees' }}</button></div>
    <p v-if="loading" class="why" role="status">Reading checkout state, disk usage and running processes…</p>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="loaded && !rows.length" class="why" role="status">No linked worktrees for this repo.</p>
    <TransitionGroup v-if="loaded" tag="ul" appear class="worktree-rows" name="worktree" @enter="enterRow" @leave="leaveRow">
      <li v-for="(row, i) in shown" :key="row.dir" :data-index="i">
        <div class="wt-title"><bdi class="wt-branch">{{ row.branch ?? 'Detached HEAD' }}</bdi><span class="wt-size">{{ size(row.bytes) }}</span></div>
        <p class="wt-path"><bdi>{{ row.dir }}</bdi></p>
        <div class="wt-meta"><span class="wt-pill" :class="{ protected: !!row.reason }">● {{ row.reason ? 'Kept' : 'Clean · merge check required' }}</span><span class="why">{{ age(row.ageMs) }}</span><span class="wt-pill">{{ row.owned ? 'Agent Worlds' : 'Manual removal only' }}</span><span v-if="row.live !== false" class="wt-pill">{{ row.live ? 'In use' : 'Live use unknown' }}</span></div>
        <p v-if="row.reason" class="why">{{ row.reason }}</p>
        <template v-else>
          <button v-if="confirm !== row.dir" class="btn danger" :disabled="!!busy || loading" :aria-label="`Check and remove ${row.branch ?? row.dir}`" @click="confirm = row.dir">Check and remove…</button>
          <div v-else class="confirm wt-confirm" role="group" aria-label="Confirm worktree removal">
            <p>Remove <bdi>{{ row.branch }}</bdi> and its local branch if every safety check passes? This folder is deleted. Its remote branch stays.</p>
            <div class="actions"><button class="btn danger" :disabled="!!busy || loading" :aria-label="`Remove worktree ${row.branch ?? row.dir}`" @click="remove(row)">{{ busy === row.dir ? 'Checking merge and safety…' : 'Remove worktree' }}</button><button class="btn" :disabled="!!busy" @click="confirm = null">Cancel</button></div>
            <p v-if="busy === row.dir" role="status">Verifying the merged request, remote branch and current files before removal…</p>
          </div>
        </template>
        <p v-if="refusal?.dir === row.dir" class="err wt-result" role="alert">{{ refusal.message }}</p>
      </li>
    </TransitionGroup>
    <button v-if="rows.length > limit" class="btn" @click="limit += 20">Show more worktrees</button>
  </details>
</template>

<style scoped>
.worktree-list{margin-block-start:12px;border-block-start:1px solid var(--line);padding-block-start:8px;min-width:0}
summary{cursor:pointer;min-height:44px;display:list-item;align-content:center;font-weight:600}
.worktree-rows{list-style:none;padding:0;margin:12px 0;position:relative;overflow:hidden}
.worktree-rows>li{display:block;padding-block:14px;border-block-start:1px solid var(--line);min-width:0}
.wt-policy{margin-block:8px 12px}
.wt-result{margin-block:12px}
.worktree-move{transition:transform .35s cubic-bezier(.645,.045,.355,1)}
.wt-title{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 16px}
.wt-confirm p{margin-block:8px 12px}
.wt-branch,.wt-path,.wt-confirm{overflow-wrap:anywhere;min-width:0}
.wt-path{font:12px/1.5 var(--f-mono);color:var(--muted);margin-block:6px}
.wt-size{font-variant-numeric:tabular-nums;white-space:nowrap}
.wt-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-block:8px}
.wt-pill{font-size:12px;border-radius:20px;padding:4px 8px;background:var(--panel-2);color:var(--ink)}
.wt-pill.protected{color:var(--wait)}
.worktree-list .btn{min-height:44px;min-width:44px;transition:transform .16s cubic-bezier(.22,.61,.36,1)}
.worktree-list .btn:active:not(:disabled){transform:scale(.97)}
@media(hover:hover) and (pointer:fine){.worktree-list .btn:hover:not(:disabled):not(:active){transform:translateY(-2px)}}
@media(prefers-reduced-motion:reduce){.worktree-move{transition:none}.worktree-list .btn{transition:none}.worktree-list .btn:active:not(:disabled),.worktree-list .btn:hover:not(:disabled):not(:active){transform:none}}
</style>
