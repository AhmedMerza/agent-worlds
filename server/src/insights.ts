import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, Store } from './store.ts';
import { oneLine } from './store.ts';
import { readHead, readTail, firstPrompt, contextOf, excerpt } from './transcript.ts';
import { reviewOf } from './review.ts';

const CATCHUP_TIMEOUT_MS = 90_000;
const MAX_CONCURRENT = 2;
const CONTEXT_THROTTLE_MS = 5_000;

const SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    did: { type: 'string', description: 'What the assistant did in the session, 1-2 plain sentences starting with a verb (e.g. "Added ..."). Never describe the act of summarising.' },
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
  let inputError: Error | null = null;
  const timer = setTimeout(() => child.kill('SIGKILL'), CATCHUP_TIMEOUT_MS);
  child.stdout.on('data', (d) => { if (out.length < 1_000_000) out += d; });
  child.stderr.on('data', (d) => { if (err.length < 4000) err += d; });
  // A fast failure can close stdin before the transcript is written; close below prefers its exit error.
  child.stdin.on('error', (e) => { inputError = e; });
  child.on('error', (e) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); fail(e); });
  child.on('close', (code, sig) => {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
    if (code !== 0) return fail(new Error(`${bin} exited ${code ?? sig}: ${err.trim().slice(0, 300)}`));
    if (inputError) return fail(new Error(`${bin} input failed: ${inputError.message}`));
    try {
      const j = JSON.parse(out);
      const r = j.structured_output ?? (typeof j.result === 'string' ? JSON.parse(j.result) : null);
      if (j.is_error || typeof r?.did !== 'string' || typeof r?.needs !== 'string') throw new Error('no structured output');
      ok({ did: r.did.trim(), needs: r.needs.trim() });
    } catch (e) { fail(new Error(`unreadable reply: ${(e as Error).message}`)); }
  });
  child.stdin.end(`Summarise this session transcript.\n\n${transcript}`);
});


/** "none", "n/a", "-" and friends mean nothing is needed. */
export const normaliseNeeds = (n: string): string => {
  const t = n.trim();
  return /^(none|nothing|n\/?a|no|nil|-+|—)$/i.test(t.replace(/^[\s.,;:!"'()]+|[\s.,;:!"'()]+$/g, '')) ? '' : t;
};

/** Catch-up summaries, context use and the done-review, derived from transcripts and git. */
export class Insights {
  store: Store;
  bin: string;
  summarise: Summarise;
  contextAt = new Map<string, number>();
  running = 0;
  queue: (() => void)[] = [];

  contextLimit: number | undefined;

  constructor(store: Store, bin: string, opts: { summarise?: Summarise; contextLimit?: number } = {}) {
    this.store = store; this.bin = bin;
    this.summarise = opts.summarise ?? runClaude;
    this.contextLimit = opts.contextLimit;
  }

  onEvent = (s: Session, ev: string) => {
    if (ev === 'Stop' || (ev === 'PostToolUse' && Date.now() - (this.contextAt.get(s.id) ?? 0) > CONTEXT_THROTTLE_MS)) void this.updateContext(s);
    if (ev === 'Stop') void this.updateReview(s);
    if (!s.taskSure && s.transcriptPath && (ev === 'UserPromptSubmit' || ev === 'PreToolUse' || ev === 'Stop')) void this.updateTask(s);
  };

  forget(id: string) { this.contextAt.delete(id); }

  private alive(s: Session) { return this.store.sessions.get(s.id) === s; }

  async updateContext(s: Session) {
    this.contextAt.set(s.id, Date.now());
    if (!s.transcriptPath) return;
    try {
      const ctx = contextOf(await readTail(s.transcriptPath, 256 * 1024), s.model, this.contextLimit);
      if (ctx && this.alive(s) && JSON.stringify(ctx) !== JSON.stringify(s.context)) { s.context = ctx; this.store.push(s); }
    } catch (e) { console.error(`[agent-worlds] context for ${s.id}: ${(e as Error).message}`); }
  }

  /** session.task is the first prompt of the whole conversation, which a resumed session only knows from its transcript. */
  async updateTask(s: Session) {
    try {
      const first = firstPrompt(await readHead(s.transcriptPath!, 256 * 1024));
      if (!first || !this.alive(s)) return;
      s.taskSure = true;
      const t = oneLine(first, 200);
      if (t !== s.task) { s.task = t; this.store.push(s); }
    } catch { /* transcript not written yet; the next event retries */ }
  }

  async updateReview(s: Session) {
    const card = s.card;
    try {
      const dir = s.reviewTop ?? s.top;
      const review = await reviewOf(dir, s.tests, s.baseSha);
      if (review) review.elsewhere = dir !== s.top;
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
    const sig = this.store.sigOf(s);
    try {
      const [head, tail] = await Promise.all([readHead(s.transcriptPath, 256 * 1024), readTail(s.transcriptPath, 512 * 1024)]);
      const asked = s.task ?? firstPrompt(head) ?? '';
      const text = excerpt(tail);
      if (!text) throw new Error('transcript has nothing to summarise yet');
      const r = await this.summarise(this.bin, text);
      if (!this.alive(s)) return;
      s.catchup = { asked: asked.length > 300 ? asked.slice(0, 299) + '…' : asked, did: r.did, needs: normaliseNeeds(r.needs) };
      s.catchupAt = Date.now();
      s.catchupSig = sig;
      s.catchupStale = this.store.sigOf(s) !== sig;
    } catch (e) {
      console.error(`[agent-worlds] catch-up for ${s.id} failed: ${(e as Error).message}`);
    }
  }
}
