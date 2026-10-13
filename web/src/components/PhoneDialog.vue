<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { encode } from 'uqr'
import type { PhoneInfo } from '../types'
import { allowPhones, pairPhone, phoneInfo } from '../store'

const emit = defineEmits<{ close: [] }>()
const info = ref<PhoneInfo | null>(null)
const error = ref('')
const busy = ref(false)
/** The one-time login link currently shown as a QR code. */
const code = ref<{ address: string; url: string; expiresAt: number } | null>(null)
const now = ref(Date.now())
const tick = setInterval(() => { now.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(tick))

const tailscale = computed(() => info.value?.addresses.filter((a) => a.kind === 'tailscale') ?? [])
const lan = computed(() => info.value?.addresses.filter((a) => a.kind === 'lan') ?? [])
const left = computed(() => Math.max(0, Math.round(((code.value?.expiresAt ?? 0) - now.value) / 1000)))
const leftText = computed(() => `${Math.floor(left.value / 60)}:${String(left.value % 60).padStart(2, '0')}`)
/** Dark modules of the QR code as one SVG path (drawn on white so phone cameras read it in both themes). */
const qr = computed(() => {
  if (!code.value) return null
  const { data } = encode(code.value.url, { border: 2 })
  let d = ''
  data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z` }))
  return { size: data.length, d }
})

async function load() {
  const r = await phoneInfo()
  if (r.ok) { info.value = r.data; error.value = '' } else error.value = r.error
}
async function run<T>(p: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T | null> {
  busy.value = true
  const r = await p
  busy.value = false
  if (!r.ok) { error.value = r.error; return null }
  error.value = ''
  return r.data
}
async function setAllowed(address: string, allow: boolean) {
  if ((await run(allowPhones(address, allow))) === null) return
  if (!allow && code.value?.address === address) code.value = null
  await load()
  if (allow) await showCode(address)
}
async function showCode(address: string) {
  const r = await run(pairPhone(address))
  if (r) code.value = { address, ...r }
}
onMounted(load)
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog phone" role="dialog" aria-modal="true" aria-label="Connect a phone">
      <h2>Connect a phone</h2>
      <p class="why">Answer requests from your phone. Scan a code with the phone's camera and it is logged in, no token to type.</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="!info && !error" class="why">Loading…</p>

      <template v-if="info">
        <section class="route">
          <h3>From anywhere, with Tailscale <small>recommended</small></h3>
          <template v-if="tailscale.length">
            <p class="why">Private and encrypted. Works on any network, as long as Tailscale is on in your phone.</p>
            <div v-for="a in tailscale" :key="a.address" class="addr">
              <template v-if="a.allowed">
                <button v-if="code?.address !== a.address" class="btn primary" :disabled="busy" @click="showCode(a.address)">Show the code</button>
                <button class="linkbtn" :disabled="busy" @click="setAllowed(a.address, false)">Stop allowing phones over Tailscale</button>
              </template>
              <button v-else class="btn primary" :disabled="busy" @click="setAllowed(a.address, true)">Allow phones over Tailscale</button>
            </div>
          </template>
          <template v-else>
            <p class="why">Tailscale isn't running on this computer. It's a free private network that lets your phone reach this computer from anywhere.</p>
            <ol class="steps">
              <li>Install Tailscale on this computer and on your phone: <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a></li>
              <li>Sign in with the same account on both.</li>
              <li>Come back here and press <b>Check again</b>.</li>
            </ol>
            <button class="btn" :disabled="busy" @click="load">Check again</button>
          </template>
        </section>

        <section class="route">
          <h3>On this network only</h3>
          <p class="warn">Works only while your phone is on the same Wi-Fi. The connection isn't encrypted, so someone else on this network could watch it and take over your sessions. Only use it on a network you trust.</p>
          <p v-if="!lan.length" class="why">This computer isn't on a local network.</p>
          <div v-for="a in lan" :key="a.address" class="addr">
            <template v-if="a.allowed">
              <button v-if="code?.address !== a.address" class="btn" :disabled="busy" @click="showCode(a.address)">Show the code for {{ a.address }}</button>
              <button class="linkbtn" :disabled="busy" @click="setAllowed(a.address, false)">Stop allowing phones on {{ a.address }}</button>
            </template>
            <button v-else class="btn" :disabled="busy" @click="setAllowed(a.address, true)">Allow phones on {{ a.address }} ({{ a.iface }})</button>
          </div>
        </section>

        <div v-if="code && qr" class="qr" role="group" aria-label="Login code for your phone">
          <svg :viewBox="`0 0 ${qr.size} ${qr.size}`" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect :width="qr.size" :height="qr.size" fill="#fff" /><path :d="qr.d" fill="#000" /></svg>
          <div>
            <template v-if="left > 0">
              <p><b>Scan this with your phone's camera.</b></p>
              <p class="why">Works once, for the next {{ leftText }}. Then add it to your home screen to open it like an app.</p>
              <p class="soon">Or open on the phone: <code>{{ code.url }}</code></p>
            </template>
            <template v-else>
              <p><b>This code has expired.</b></p>
              <button class="btn primary" :disabled="busy" @click="showCode(code.address)">New code</button>
            </template>
          </div>
        </div>
      </template>
      <div class="actions" style="margin-top:12px"><button class="btn" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
