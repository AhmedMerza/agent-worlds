<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { encode } from 'uqr'
import type { AccessInfo, PhoneInfo } from '../types'
import { accessLog, allowPhones, clearPassword, installCloudflared, pairPhone, phoneInfo, setPassword, setTunnel, state } from '../store'
import { ageText, deviceText } from '../logic'

const emit = defineEmits<{ close: [] }>()
const info = ref<PhoneInfo | null>(null)
const access = ref<AccessInfo | null>(null)
const error = ref('')
const busy = ref(false)
const pw = ref('')
const changingPw = ref(false)
/** The one-time login link currently shown as a QR code ('tunnel' for the public link). */
const code = ref<{ address: string; url: string; expiresAt: number } | null>(null)
const now = ref(Date.now())
const tick = setInterval(() => { now.value = Date.now() }, 1000)
onUnmounted(() => clearInterval(tick))

/** Opened from the phone itself (not this computer): a QR to scan is useless here, keeping the page is what matters. */
const elsewhere = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
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
/** The command that opens the server's port in the running firewall (needs the user's admin password). */
const openPort = computed(() => !info.value?.firewall ? null : info.value.firewall === 'ufw'
  ? `sudo ufw allow ${info.value.port}/tcp`
  : `sudo firewall-cmd --add-port=${info.value.port}/tcp --permanent && sudo firewall-cmd --reload`)
function copy(text: string) { navigator.clipboard?.writeText(text).catch(() => {}) }
const CLOUDFLARED = 'mkdir -p ~/.local/bin && curl -fL -o ~/.local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x ~/.local/bin/cloudflared'

async function load() {
  const [r, a] = await Promise.all([phoneInfo(), accessLog()])
  if (r.ok) { info.value = r.data; error.value = '' } else error.value = r.error
  if (a.ok) access.value = a.data
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
async function savePassword() {
  if ((await run(setPassword(pw.value))) === null) return
  pw.value = ''; changingPw.value = false
  await load()
}
async function removePassword() {
  if ((await run(clearPassword())) === null) return
  if (code.value?.address === 'tunnel') code.value = null
  await load()
}
const installing = ref(false)
async function install() {
  installing.value = true
  const ok = (await run(installCloudflared())) !== null
  installing.value = false
  if (ok) await load()
}
async function publicLink(on: boolean) {
  if ((await run(setTunnel(on))) === null) return
  if (!on && code.value?.address === 'tunnel') code.value = null
  await load()
}
onMounted(load)
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog phone" role="dialog" aria-modal="true" aria-label="Connect a phone">
      <h2>Connect a phone</h2>
      <div v-if="elsewhere" class="here">
        <p><b>You're already connected on this device.</b></p>
        <p class="why">To come back later, add this page to your home screen: in the browser menu, choose <b>Add to Home Screen</b>. It stays logged in for a year.</p>
      </div>
      <p class="why">Answer requests from your phone. Scan a code with the phone's camera and it is logged in, no token to type.</p>
      <p v-if="error" class="err" role="alert">{{ error }}</p>
      <p v-if="!info && !error" class="why">Loading…</p>

      <template v-if="info">
        <section class="route">
          <h3>At the office, on the same Wi-Fi</h3>
          <p class="warn">Only while your phone is on this network. The connection isn't encrypted, so someone else on it could watch and take over your sessions. Use it only on a network you trust.</p>
          <p v-if="!lan.length" class="why">This computer isn't on a local network.</p>
          <div v-for="a in lan" :key="a.address" class="addr">
            <template v-if="a.allowed">
              <button v-if="code?.address !== a.address" class="btn primary" :disabled="busy" @click="showCode(a.address)">Show the code</button>
              <button class="linkbtn" :disabled="busy" @click="setAllowed(a.address, false)">Stop allowing phones on {{ a.address }}</button>
            </template>
            <button v-else class="btn primary" :disabled="busy" @click="setAllowed(a.address, true)">Allow phones on {{ a.address }} ({{ a.iface }})</button>
          </div>
        <div v-if="code && qr && lan.some((a) => a.address === code!.address)" class="qr" role="group" aria-label="Login code for your phone">
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
          <template v-if="lan.some((a) => a.allowed)">
            <p v-if="info.lanReached" class="ok-note">✓ A phone has connected over Wi-Fi.</p>
            <div v-else class="hint">
              <p><b>Phone says "can't be reached"?</b></p>
              <template v-if="openPort">
                <p class="why">This computer's firewall ({{ info.firewall }}) is on and probably blocks it. Open the port once, in a terminal on this computer (it asks for your password):</p>
                <div class="cmd-row"><code class="cmd">{{ openPort }}</code><button class="btn" @click="copy(openPort)">Copy</button></div>
              </template>
              <p class="why">Still nothing? Some Wi-Fi networks keep devices apart (guest networks often do). Use the public link below instead: it works on any network.</p>
            </div>
          </template>
        </section>

        <section class="route">
          <h3>From anywhere, with a public link <small v-if="info.tunnel" class="on">on</small><small v-else>off</small></h3>
          <p class="why">A secure https link that works on any network, with nothing to install on the phone. Anyone who has the link reaches a login page, so it needs a password. The link changes, and switches off, whenever the server restarts.</p>

          <div class="step">
            <span class="lbl">1. Password</span>
            <template v-if="info.passwordSet && !changingPw">
              <p class="why">Password is set. <button class="linkbtn" @click="changingPw = true">Change</button> · <button class="linkbtn" :disabled="busy" @click="removePassword">Remove (also turns the link off)</button></p>
            </template>
            <form v-else class="reply" @submit.prevent="savePassword">
              <input v-model="pw" class="reply-in" type="password" autocomplete="new-password" minlength="10" placeholder="At least 10 characters" aria-label="New password">
              <button class="btn" :disabled="busy || pw.length < 10">Save password</button>
            </form>
          </div>

          <div class="step">
            <span class="lbl">2. Link</span>
            <template v-if="!info.cloudflared">
              <p class="why">The link uses Cloudflare's free <b>cloudflared</b> program on this computer. No account and no admin rights: it goes into your own <code>~/.local/bin</code>.</p>
              <button v-if="info.canInstall" class="btn primary" :disabled="busy" @click="install">{{ installing ? 'Installing… (about 40 MB)' : 'Install cloudflared' }}</button>
              <details class="manual">
                <summary>Or install it yourself</summary>
                <p class="why">On Linux, run in a terminal:</p>
                <code class="cmd">{{ CLOUDFLARED }}</code>
                <p class="why">Other systems: <a href="https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" target="_blank" rel="noopener">download cloudflared</a>, then <button class="linkbtn" :disabled="busy" @click="load">check again</button>.</p>
              </details>
            </template>
            <template v-else-if="info.tunnel">
              <p class="why">On: <code>{{ info.tunnel }}</code>. Open it on the phone and log in with your password, or scan a code.</p>
              <div class="addr">
                <button v-if="code?.address !== 'tunnel'" class="btn primary" :disabled="busy" @click="showCode('tunnel')">Show the code</button>
                <button class="btn danger" :disabled="busy" @click="publicLink(false)">Turn off the public link</button>
              </div>
            </template>
            <template v-else>
              <button class="btn primary" :disabled="busy || !info.passwordSet" @click="publicLink(true)">{{ busy ? 'Starting…' : 'Turn on the public link' }}</button>
              <p v-if="!info.passwordSet" class="soon">Set a password first.</p>
            </template>
          </div>
        <div v-if="code && qr && code.address === 'tunnel'" class="qr" role="group" aria-label="Login code for your phone">
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
        </section>


        <details class="route">
          <summary>Prefer a private network? Use Tailscale</summary>
          <template v-if="tailscale.length">
            <p class="why">Private and encrypted; only your own devices can reach this computer.</p>
            <div v-for="a in tailscale" :key="a.address" class="addr">
              <template v-if="a.allowed">
                <button v-if="code?.address !== a.address" class="btn" :disabled="busy" @click="showCode(a.address)">Show the code</button>
                <button class="linkbtn" :disabled="busy" @click="setAllowed(a.address, false)">Stop allowing phones over Tailscale</button>
              </template>
              <button v-else class="btn" :disabled="busy" @click="setAllowed(a.address, true)">Allow phones over Tailscale</button>
            </div>
          </template>
          <template v-else>
            <p class="why">Private and encrypted, but it needs the free Tailscale app on <b>both</b> this computer and your phone, signed in with the same account: <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a>. Then press <b>Check again</b>.</p>
            <button class="btn" :disabled="busy" @click="load">Check again</button>
          </template>
        <div v-if="code && qr && tailscale.some((a) => a.address === code!.address)" class="qr" role="group" aria-label="Login code for your phone">
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
        </details>

        <section v-if="access" class="route">
          <h3>Who signed in</h3>
          <p v-if="!access.devices.length" class="why">No device has signed in yet.</p>
          <p v-else class="why">{{ access.devices.length }} {{ access.devices.length === 1 ? 'device' : 'devices' }} so far.</p>
          <ul class="access">
            <li v-for="d in access.devices" :key="d.device">
              <b>{{ deviceText(d.agent) }}</b><span v-if="d.device === access.you" class="badge mgd">this device</span>
              <span class="soon">{{ d.ip }} · {{ d.route }} · by {{ d.via }} · first {{ ageText(d.first, state.now) }} · last {{ ageText(d.last, state.now) }}</span>
            </li>
          </ul>
          <details v-if="access.entries.length">
            <summary>Every sign-in and failed try ({{ access.entries.length }})</summary>
            <ul class="access">
              <li v-for="(e, i) in access.entries" :key="i" :class="{ bad: !e.ok }">
                <b>{{ e.ok ? 'Signed in' : 'Failed' }}</b> by {{ e.via }} · {{ e.ip }} · {{ e.route }} · {{ ageText(e.at, state.now) }}
                <span class="soon" :title="e.agent">{{ deviceText(e.agent) }}</span>
              </li>
            </ul>
          </details>
        </section>
      </template>
      <div class="actions" style="margin-top:12px"><button class="btn" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
