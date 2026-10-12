<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { RoomGroup } from '../types'
import { drawRoom, hitTest, layout, W, K, type Hit } from '../canvas'
import { LABEL, NEEDS_YOU } from '../logic'
import { state, select } from '../store'

const props = defineProps<{ group: RoomGroup; numbers: Record<string, number> }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const size = computed(() => layout(props.group.sessions.length))
const working = computed(() => props.group.sessions.filter((s) => s.state === 'working').length)
const needN = computed(() => props.group.sessions.filter((s) => s.card && NEEDS_YOU.includes(s.state)).length)

let hits: Hit[] = []
let raf = 0
let lastStatic = ''
function frame(t: number) {
  raf = requestAnimationFrame(frame)
  const c = canvas.value
  if (!c || document.hidden || c.offsetParent === null) return
  const ctx = c.getContext('2d')
  if (!ctx) return
  // With reduced motion the picture only changes when data does, so skip identical redraws.
  const key = reduced ? JSON.stringify([props.group.sessions, state.selectedId, Math.floor(state.now / 60000)]) : ''
  if (reduced && key === lastStatic) return
  lastStatic = key
  hits = drawRoom(ctx, { group: props.group, selectedId: state.selectedId, t, now: state.now, reduced })
}
onMounted(() => { raf = requestAnimationFrame(frame) })
onBeforeUnmount(() => cancelAnimationFrame(raf))

function at(e: MouseEvent): Hit | undefined {
  const b = canvas.value!.getBoundingClientRect()
  return hitTest(hits, (e.clientX - b.left) / b.width * W, (e.clientY - b.top) / b.height * size.value.H)
}
const onClick = (e: MouseEvent) => { const h = at(e); if (h) select(h.id) }
const onMove = (e: MouseEvent) => { canvas.value!.style.cursor = at(e) ? 'pointer' : 'default' }
</script>

<template>
  <article class="room" :style="{ '--tint': group.world.color }">
    <header>
      <h2>{{ group.world.name }}</h2>
      <span class="meta">{{ group.sessions.length }} {{ group.sessions.length === 1 ? 'session' : 'sessions' }} · {{ working }} working<template v-if="needN"> · {{ needN }} need you</template></span>
    </header>
    <canvas ref="canvas" :width="W * K" :height="size.H * K" :aria-label="`${group.world.name} room`" @click="onClick" @mousemove="onMove" />
    <div class="chips">
      <p v-if="!group.sessions.length" class="meta">No sessions yet.</p>
      <button v-for="s in group.sessions" :key="s.id" class="chip" :aria-pressed="state.selectedId === s.id" @click="select(s.id)">
        <span class="k">{{ numbers[s.id] ?? '' }}</span><span :class="['dot', s.state]" />{{ s.repoName }} <span class="st">{{ LABEL[s.state] }}</span>
      </button>
    </div>
  </article>
</template>
