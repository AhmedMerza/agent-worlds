import { reactive } from 'vue'
import type { Session } from './types'

const KEY = 'aw.prefs'
function load(): { muted: boolean; notify: boolean } {
  try { const j = JSON.parse(localStorage.getItem(KEY) ?? '{}'); return { muted: !!j.muted, notify: !!j.notify } } catch { return { muted: false, notify: false } }
}
export const prefs = reactive(load())
function save() { try { localStorage.setItem(KEY, JSON.stringify({ muted: prefs.muted, notify: prefs.notify })) } catch { /* private mode */ } }

export const notifySupported = typeof Notification !== 'undefined'
export function toggleMute(): void { prefs.muted = !prefs.muted; save() }
export async function toggleNotifications(): Promise<'on' | 'off' | 'denied'> {
  if (prefs.notify) { prefs.notify = false; save(); return 'off' }
  if (!notifySupported) return 'denied'
  const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  prefs.notify = p === 'granted'; save()
  return prefs.notify ? 'on' : 'denied'
}

let audio: AudioContext | null = null
/** One short tone; the pitch depends on the world so rooms are told apart by ear. */
export function tone(worldIndex: number): void {
  if (prefs.muted) return
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    const o = audio.createOscillator(), g = audio.createGain()
    o.frequency.value = 392 * 2 ** (((Math.max(0, worldIndex)) % 6) / 6 * 1)
    g.gain.setValueAtTime(0.0001, audio.currentTime)
    g.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35)
    o.connect(g).connect(audio.destination); o.start(); o.stop(audio.currentTime + 0.4)
  } catch { /* audio blocked until a user gesture */ }
}

const WHAT = { permission: 'wants to run a command', question: 'has a question', done: 'finished', error: 'hit a problem' } as const
export function alertNeedsYou(s: Session, worldIndex: number, worldName: string): void {
  tone(worldIndex)
  if (prefs.notify && notifySupported && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(`${s.repoName} ${WHAT[s.card!.kind]}`, { body: worldName, tag: s.id }) } catch { /* ignore */ }
  }
}
