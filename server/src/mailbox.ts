/**
 * Messages between sessions. Knows nothing of Agent Worlds beyond session ids, so it can be lifted out whole.
 * A message is `notified` once its recipient was told it has mail, and `read` once it fetched it.
 */
export type Message = { id: number; from: string; to: string; text: string; at: number; notified: boolean; read: boolean };

/** Messages two sessions may trade with no human prompt to either of them before sending is refused. */
export const PING_PONG = 12;
const KEEP = 500;

export class Mailbox {
  private messages: Message[] = [];
  private seq = 0;
  /** Messages exchanged by a pair (key "a|b", sorted) since a human last prompted either one. */
  private streak = new Map<string, number>();

  private now: () => number;

  constructor(now: () => number = Date.now) { this.now = now; }

  /** Queue a message; an error string when the pair has talked too long on its own. */
  send(from: string, to: string, text: string): Message | string {
    const key = [from, to].sort().join('|');
    const n = this.streak.get(key) ?? 0;
    if (n >= PING_PONG) return `you and this session have traded ${n} messages with no word from the user: stop and ask the user how to go on`;
    this.streak.set(key, n + 1);
    const m: Message = { id: ++this.seq, from, to, text, at: this.now(), notified: false, read: false };
    this.messages.push(m);
    if (this.messages.length > KEEP) this.messages.splice(0, this.messages.length - KEEP);
    return m;
  }

  /** Unread messages for `to`, oldest first, now marked read. */
  take(to: string): Message[] {
    const out = this.messages.filter((m) => m.to === to && !m.read);
    for (const m of out) { m.read = true; m.notified = true; }
    return out;
  }

  /** Unread messages `to` has not been told about yet. */
  unnotified(to: string): Message[] {
    return this.messages.filter((m) => m.to === to && !m.read && !m.notified);
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
    this.messages = this.messages.filter((m) => m.to !== id);
    this.prompted(id);
  }
}
