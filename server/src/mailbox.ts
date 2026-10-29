import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/**
 * Messages between sessions. Knows nothing of Agent Worlds beyond session ids, so it can be lifted out whole.
 * A message is `notified` once its recipient was told it has mail, and `read` once it fetched it.
 */
export type Message = { id: number; from: string; to: string; text: string; at: number; notified: boolean; read: boolean; system?: boolean };

/** Messages two sessions may trade with no human prompt to either of them before sending is refused.
 *  A manager session driving several workers needs more headroom than a peer pair; override with AW_PING_PONG. */
export const PING_PONG = Number(process.env.AW_PING_PONG) || 40;
const KEEP = 500;

export class Mailbox {
  private messages: Message[] = [];
  private seq = 0;
  /** Messages exchanged by a pair (key "a|b", sorted) since a human last prompted either one. */
  private streak = new Map<string, number>();

  private now: () => number;
  private file: string | null;

  /** With a file, unread messages are kept there, so a server restart does not lose them (session ids survive it). */
  constructor(now: () => number = Date.now, file: string | null = null) {
    this.now = now; this.file = file;
    if (!file) return;
    let v: unknown;
    try { v = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
    const ok = (m: any): m is Message => !!m && Number.isInteger(m.id) && typeof m.from === 'string' && typeof m.to === 'string' && typeof m.text === 'string' && typeof m.at === 'number';
    this.messages = (Array.isArray(v) ? v : []).filter(ok).map((m) => ({ ...m, notified: m.notified === true, read: false }));
    this.seq = Math.max(0, ...this.messages.map((m) => m.id));
  }

  private save() {
    if (!this.file) return;
    try {
      writeFileSync(this.file + '.tmp', JSON.stringify(this.messages.filter((m) => !m.read)), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('[agent-worlds] cannot save the mailbox', (e as Error).message); }
  }

  /** Queue a message; an error string when the pair has talked too long on its own. */
  send(from: string, to: string, text: string): Message | string {
    const key = [from, to].sort().join('|');
    const n = this.streak.get(key) ?? 0;
    if (n >= PING_PONG) return `you and this session have traded ${n} messages with no word from the user: stop and ask the user how to go on`;
    this.streak.set(key, n + 1);
    return this.queue(from, to, text);
  }

  /** Queue a lifecycle notice that must not be refused by the agent-to-agent conversation limit. */
  sendSystem(from: string, to: string, text: string): Message {
    return this.queue(from, to, text, true);
  }

  private queue(from: string, to: string, text: string, system = false): Message {
    const m: Message = { id: ++this.seq, from, to, text, at: this.now(), notified: false, read: false, ...(system ? { system: true } : {}) };
    this.messages.push(m);
    // Full: drop what was read before anything unread
    if (this.messages.length > KEEP) this.messages = this.messages.filter((x) => !x.read);
    if (this.messages.length > KEEP) this.messages.splice(0, this.messages.length - KEEP);
    this.save();
    return m;
  }

  /** A conversation got a new id after /clear or /resume: its queued mail follows it. */
  rename(from: string, to: string) {
    let changed = false;
    for (const m of this.messages) {
      if (m.from === from) { m.from = to; changed = true; }
      if (m.to === from) { m.to = to; changed = true; }
    }
    if (changed) this.save();
    const next = new Map<string, number>();
    for (const [pair, n] of this.streak) {
      const ids = pair.split('|').map((id) => id === from ? to : id).sort();
      const key = ids.join('|');
      next.set(key, (next.get(key) ?? 0) + n);
    }
    this.streak = next;
  }

  /** Unread messages for `to`, oldest first, now marked read. */
  take(to: string): Message[] {
    const out = this.messages.filter((m) => m.to === to && !m.read);
    for (const m of out) { m.read = true; m.notified = true; }
    if (out.length) this.save();
    return out;
  }

  hasUnread(to: string): boolean {
    return this.messages.some((m) => m.to === to && !m.read);
  }

  hasUnreadSystem(to: string): boolean {
    return this.messages.some((m) => m.to === to && !m.read && m.system === true);
  }

  /** Unread messages `to` has not been told about yet. */
  unnotified(to: string): Message[] {
    return this.messages.filter((m) => m.to === to && !m.read && !m.notified);
  }

  /** Its recipient was told about these. */
  markNotified(ms: Message[]) {
    for (const m of ms) m.notified = true;
    if (ms.length) this.save();
  }

  /** Recipients with mail they have not been told about. */
  waiting(): Set<string> {
    return new Set(this.messages.filter((m) => !m.read && !m.notified).map((m) => m.to));
  }

  /** A human prompted `id`: its conversations start a fresh streak. */
  prompted(id: string) {
    for (const k of this.streak.keys()) if (k.split('|').includes(id)) this.streak.delete(k);
  }

  /** A session ended: drop what it never read. */
  forget(id: string) {
    const n = this.messages.length;
    this.messages = this.messages.filter((m) => m.to !== id);
    if (this.messages.length !== n) this.save();
    this.prompted(id);
  }
}
