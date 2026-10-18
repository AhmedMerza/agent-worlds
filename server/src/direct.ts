import type { IPty } from 'node-pty';
import { ENTER_DELAY_MS } from './sys.ts';

/** What a browser terminal drives: a `tmux attach` process, or a view onto a direct session. */
export type PtyLike = { write(d: string): void; resize(cols: number, rows: number): void; onData(f: (d: string) => void): unknown; onExit(f: () => void): unknown; kill(): void };

const SCROLLBACK = 256 * 1024;
type Entry = { pty: IPty; out: string; data: Set<(d: string) => void>; exit: Set<() => void> };

/**
 * Sessions the server runs itself because tmux is missing: one pty per session, shared by every
 * browser watching it. They end with the server, which is what tmux would have spared them.
 */
export class Direct {
  private map = new Map<string, Entry>();
  private onExit: (name: string) => void;
  constructor(onExit: (name: string) => void) { this.onExit = onExit; }

  has(name: string) { return this.map.has(name); }
  get size() { return this.map.size; }

  async spawn(name: string, file: string, args: string[], cwd: string, env: Record<string, string>): Promise<void> {
    const { spawn } = await import('node-pty'); // lazily, like spawnTmuxPty
    const pty = spawn(file, args, { name: 'xterm-256color', cols: 120, rows: 32, cwd, env: { ...process.env, TERM: 'xterm-256color', ...env } as Record<string, string> });
    const e: Entry = { pty, out: '', data: new Set(), exit: new Set() };
    pty.onData((d) => { e.out = (e.out + d).slice(-SCROLLBACK); for (const f of e.data) f(d); });
    pty.onExit(() => { this.map.delete(name); for (const f of e.exit) f(); this.onExit(name); });
    this.map.set(name, e);
  }

  /** Types `text` and Enter, like tmux send-keys. False when the session is gone. */
  type(name: string, text: string): boolean {
    const e = this.map.get(name);
    if (!e) return false;
    e.pty.write(text);
    // a separate Enter, so a pasted block is not taken as one keystroke; the pty may have ended meanwhile
    setTimeout(() => { try { if (this.map.get(name) === e) e.pty.write('\r'); } catch { /* gone */ } }, ENTER_DELAY_MS);
    return true;
  }

  /** One browser's handle on a session: replays recent output first; kill() only detaches that browser. */
  async view(name: string): Promise<PtyLike> {
    const e = this.map.get(name);
    if (!e) throw new Error(`no direct session ${name}`);
    const subs: (() => void)[] = [];
    return {
      write: (d) => e.pty.write(d),
      resize: (cols, rows) => e.pty.resize(cols, rows),
      onData: (f) => { if (e.out) f(e.out); e.data.add(f); subs.push(() => e.data.delete(f)); },
      onExit: (f) => { e.exit.add(f); subs.push(() => e.exit.delete(f)); },
      kill: () => { for (const u of subs.splice(0)) u(); },
    };
  }

  /** Ends one session; its exit removes the card. */
  kill(name: string) { this.map.get(name)?.pty.kill(); }

  killAll() { for (const e of this.map.values()) e.pty.kill(); this.map.clear(); }
}
