import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, Store } from './store.ts';
import { readHead, readTail, firstPrompt, contextOf, excerpt } from './transcript.ts';
import { reviewOf } from './review.ts';

const CATCHUP_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;
const CONTEXT_THROTTLE_MS = 5_000;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    did: { type: 'string', description: 'What the assistant actually did, 1-2 plain sentences.' },
    needs: { type: 'string', description: 'What it needs from the user now, one sentence; empty string if nothing.' },
  },
  required: ['did', 'needs'],
  additionalProperties: false,
});
const SYSTEM = 'You summarise a coding-assistant session for its busy owner. Answer only from the transcript text you are given. Do not use any tools. Be concrete and brief.';

type Summary = { did: string; needs: string };
export type Summarise = (bin: string, transcript: string) => Promise<Summary>;

/** Run `claude -p` once with structured output. Its own hooks are disabled so it never reports to us. */
export const runClaude: Summarise = (bin, transcript) => new Promise((ok, fail) => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-catchup-'));
  const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--no-session-persistence', '--restricted', '--strict-mcp-config',
    '--append-system-prompt', SYSTEM, '--json-schema', SCHEMA];
  const child = spawn(bin, args, { cwd: dir, env: { ...process.env, AGENT_WORLDS_DISABLE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), CATCHUP_TIMEOUT_MS);
  child.stdout.on('data', (d) => { if (out.length < 1_000_000) out += d; });
  child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  child.on('error', (e) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); fail(e); });
  child.on('close', (code, sig) => {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
    if (code !== 0) return fail(new Error(`${bin} exited ${code ?? sig}: ${err.trim().slice(0, 300)}`));
    try {
      const j = JSON.parse(out);
      const r = j.structured_output ?? (typeof j.result === 'string' ? JSON.parse(j.result) : null);
      if (j.is_error || typeof r?.did !== 'string' || typeof r?.needs !== 'string') throw new Error('no structured output');
      ok({ did: r.did.trim(), needs: r.needs.trim() });
    } catch (e) { fail(new Error(`unreadable reply: ${(e as Error).message}`)); }
  });
  child.stdin.end(`Summarise this session transcript.\n\n${transcript}`);
});


/** Catch-up summaries, context use and the done-review, derived from transcripts and git. */
export class Insights {
  store: Store;
  bin: string;
  summarise: Summarise;
  contextAt = new Map<string, number>();
  running = 0;
  queue: (() => void)[] = [];

  constructor(store: Store, bin: string, opts: { summarise?: Summarise } = {}) {
    this.store = store; this.bin = bin;
    this.summarise = opts.summarise ?? runClaude;
  }

  onEvent = (s: Session, ev: string) => {
    if (ev === 'Stop' || (ev === 'PostToolUse' && Date.now() - (this.contextAt.get(s.id) ?? 0) > CONTEXT_THROTTLE_MS)) void this.updateContext(s);
    if (ev === 'Stop') void this.updateReview(s);
  };

  forget(id: string) { this.contextAt.delete(id); }

  private alive(s: Session) { return this.store.sessions.get(s.id) === s; }

  async updateContext(s: Session) {
    this.contextAt.set(s.id, Date.now());
    if (!s.transcriptPath) return;
    try {
      const ctx = contextOf(await readTail(s.transcriptPath, 256 * 1024), s.model);
      if (ctx && this.alive(s) && JSON.stringify(ctx) !== JSON.stringify(s.context)) { s.context = ctx; this.store.push(s); }
    } catch (e) { console.error(`[agent-worlds] context for ${s.id}: ${(e as Error).message}`); }
  }

  async updateReview(s: Session) {
    const card = s.card;
    try {
      const review = await reviewOf(s.top, s.tests);
      if (review && this.alive(s) && s.card === card && card?.kind === 'done') { card.review = review; this.store.push(s); }
    } catch (e) { console.error(`[agent-worlds] review for ${s.id}: ${(e as Error).message}`); }
  }

  /** Start a catch-up summary (user asked for it). 'busy' when one is already running for this session. */
  requestCatchup(s: Session): 'started' | 'busy' | 'no-transcript' {
    if (s.catchupRunning) return 'busy';
    if (!s.transcriptPath) return 'no-transcript';
    s.catchupRunning = true;
    this.store.push(s);
    this.enqueue(() => this.catchup(s).finally(() => {
      s.catchupRunning = false;
      if (this.alive(s)) this.store.push(s);
    }));
    return 'started';
  }

  private enqueue(job: () => Promise<void>) {
    const run = () => {
      this.running++;
      job().finally(() => { this.running--; this.queue.shift()?.(); });
    };
    if (this.running < MAX_CONCURRENT) run(); else this.queue.push(run);
  }

  /** Never throws: a failure leaves the previous catch-up in place and is logged. */
  async catchup(s: Session) {
    if (!this.alive(s) || !s.transcriptPath) return;
    try {
      const [head, tail] = await Promise.all([readHead(s.transcriptPath, 256 * 1024), readTail(s.transcriptPath, 512 * 1024)]);
      const asked = firstPrompt(head) ?? s.task ?? '';
      const text = excerpt(tail);
      if (!text) throw new Error('transcript has nothing to summarise yet');
      const r = await this.summarise(this.bin, text);
      if (!this.alive(s)) return;
      s.catchup = { asked: asked.length > 300 ? asked.slice(0, 299) + '…' : asked, did: r.did, needs: r.needs };
      s.catchupAt = Date.now();
    } catch (e) {
      console.error(`[agent-worlds] catch-up for ${s.id} failed: ${(e as Error).message}`);
    }
  }
}
