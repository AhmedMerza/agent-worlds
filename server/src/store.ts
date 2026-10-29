import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { Config } from './config.ts';
import type { RepoInfo } from './sys.ts';
import type { Review } from './review.ts';
import { TEST_RE, testLine } from './review.ts';
import { riskOf, ruleFor, ruleText, addAllowRule, whyNotEverywhere, WRITE_TOOLS, type Rule } from './rules.ts';
import { computeConflicts, type Conflict } from './conflicts.ts';
import { readTail, type Entry } from './transcript.ts';
import { stat } from 'node:fs/promises';
import { AGENTS, type AgentId } from './agents.ts';

export { riskOf };

type State = 'starting' | 'working' | 'waiting' | 'done' | 'error' | 'idle';
type Helper = { id: string; task: string; state: 'working' | 'done'; startedAt: number };
type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };
type Card =
  | null
  | { kind: 'permission'; requestId: string; tool: string; command: string; target: { type: 'command'; value: string }; input: Record<string, never>; risky: null; seenCount: number; live: false }
  | { kind: 'done'; summary: string | null; review: Review | null }
  | { kind: 'asking'; summary: string | null }
  | { kind: 'error'; summary: string };

/** Busy, but not needing you: compacting, or the turn ended while background work runs on. State stays 'working'. */
type Busy = null | { kind: 'compact' } | { kind: 'background'; tasks: number; nextAt: number | null };

/** No word from background work for this long: the session is shown as done after all. */
const BUSY_TTL = 30 * 60_000;
const WAKE_GRACE = 5 * 60_000;
/** Codex rollout entries that start or end a turn, and how long its Stop hook gets to arrive first. */
const CODEX_TURN = new Set(['task_started', 'task_complete', 'turn_aborted']);
const CODEX_GRACE = 5_000;
const CODEX_PERMISSION_GRACE = 5_000;
const CODEX_TERMINAL_REQUEST = 'codex-terminal';

/** Codex's native command approval controls, matched near the bottom of the current screen. */
export function codexApprovalOnScreen(screen: string): boolean {
  const tail = screen.trimEnd().split('\n').slice(-12).join('\n');
  return /1\. Yes, proceed \(y\)/.test(tail) && /Press enter to confirm or esc to cancel/.test(tail);
}

type Pending = {
  requestId: string;
  actor: string | null;
  ambiguous: boolean;
  kind: 'permission' | 'question';
  tool: string;
  input: Record<string, unknown>;
  key: string;
  rule: Rule;
  risky: string | null;
  seenCount: number;
  createdAt: number;
  live: boolean;
  resolve: ((body: string) => void) | null;
  timer: NodeJS.Timeout | null;
};

export type Session = {
  id: string; agent: AgentId; worldId: string | null; repo: string; repoName: string; cwd: string;
  branch: string | null; worktree: boolean; tmux: { session: string | null; pane: string } | null;
  /** Set when the server runs this session itself (no tmux): the name of its pty. */
  direct: string | null;
  /** Your name for it, shown on its name tag. */
  label: string | null;
  /** The session that started this one with aw_spawn (its lead), if one did. */
  parent: string | null;
  /** The model provider and model a Qwen session was started on ("OpenRouter · openrouter/free"). */
  via: string | null;
  state: State; waitingSince: number | null; task: string | null; lastPrompt: string | null; now: string;
  log: { t: number; text: string }[];
  helpers: (Helper & { agentId?: string; agentType?: string; bg?: boolean })[];
  card: Card;
  busy: Busy;
  catchup: { asked: string; did: string; needs: string } | null;
  catchupAt: number | null;
  catchupRunning: boolean;
  /** State or card changed after the catch-up was made. */
  catchupStale: boolean;
  context: { used: number; limit: number; pct: number } | null;
  /** Tokens over the whole transcript (Claude only). */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  conflicts: Conflict[];
  startedAt: number; updatedAt: number;
  // internal, never sent to clients
  pending: Pending[];
  top: string;
  /** Git top-level of the last place this session wrote or committed, when that is not `top` (another worktree). */
  reviewTop: string | null;
  workDir: string | null;
  baseSha: string | null;
  taskSure: boolean;
  catchupSig: string | null;
  branchAt: number;
  branchTimer: NodeJS.Timeout | null;
  model: string | null;
  transcriptPath: string | null;
  /** Another agent's transcript; Codex's is also read for its conversation, outside claudeProjectsDir. */
  logPath: string | null;
  tests: Review['tests'];
  testing: Set<string>;
  /** When the last hook event arrived: a Codex turn end older than this is stale. */
  hookAt: number;
  /** When you last prompted it: a transcript interrupt marker older than this is from an earlier turn. */
  promptAt: number;
  /** A background wait gives up at `at` and shows `summary` as done. */
  busyEnd: { at: number; summary: string | null } | null;
  /** Since your last prompt Claude started background work (a background helper or command, a monitor) that can bring it back. */
  launched: boolean;
};
const INTERNAL = ['pending', 'top', 'reviewTop', 'workDir', 'baseSha', 'taskSure', 'catchupSig', 'branchAt', 'branchTimer', 'model', 'transcriptPath', 'logPath', 'tests', 'testing', 'hookAt', 'promptAt', 'busyEnd', 'launched'] as const;

export type Deps = {
  repoInfo: (cwd: string) => Promise<RepoInfo>;
  branchOf: (cwd: string) => Promise<string | null>;
  tmuxSessionOf: (pane: string) => Promise<string | null>;
  clientsConnected: () => boolean;
  holdMs: number;
  /** Minimum gap between branch refreshes of one session (default 2000). */
  branchDebounceMs?: number;
  stats: { get(repo: string, rule: string): number; inc(repo: string, rule: string): number };
  /** Sessions moved to a world by hand, by conversation id (see placements.ts). */
  placements?: { get(id: string): string | undefined; set(id: string, worldId: string | null): void };
  /** Names you gave sessions, by conversation id. */
  labels?: { get(id: string): string | undefined; set(id: string, label: string | null): void };
  /** Which session started which (aw_spawn), kept across restarts in <home>/parents.json. */
  parents?: { get(id: string): string | undefined; set(id: string, parent: string | null): void; replaceValue(from: string, to: string): void };
  /** A session got a new id in the same pane (its first hook after 'starting', /clear, /resume): its workers and runs follow. */
  onRenamed?: (from: string, to: string) => void;
  /** A CLI explicitly ended a conversation. Process disappearance alone does not call this. */
  onEnded?: (id: string, reason: unknown) => void;
  /** Called after every handled event, for derived data (catch-up, context, review). */
  onEvent?: (s: Session, ev: string, p: Record<string, unknown>) => void;
  /** A turn definitely completed successfully, either through its Stop hook or Codex rollout fallback. */
  onCompleted?: (s: Session, result: string | null, source: 'hook' | 'poll') => void;
  now?: () => number;
};

export type Emit = (ev: { type: 'session'; session: unknown } | { type: 'session-removed'; id: string }) => void;

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** Claude's "[Request interrupted by user…]" line, written on Esc. */
const interruptMark = (e: { type?: unknown; message?: { content?: unknown } }) => {
  const c = e.type === 'user' ? e.message?.content : undefined;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c[0]?.text : undefined;
  return typeof text === 'string' && text.startsWith('[Request interrupted');
};
const LOG_MAX = 20;
const LABEL_MAX = 40;
/** How long a conversation ended by /clear or /resume waits for the next one in its terminal to take over from it. */
const CLEAR_GRACE_MS = 10_000;

export const oneLine = (s: unknown, max = 160): string | null => {
  if (typeof s !== 'string') return null;
  const line = s.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

function describe(tool: string, input: Record<string, unknown>): string {
  let arg = input.command ?? input.description ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt;
  if (typeof arg !== 'string' && tool === 'AskUserQuestion') {
    const q = (Array.isArray(input.questions) ? input.questions[0] : null) as Record<string, unknown> | null;
    arg = q?.question;
  }
  return oneLine(typeof arg === 'string' ? `${tool}: ${arg}` : tool, 120) ?? tool;
}

const commandOf = (input: Record<string, unknown>): string | null => {
  for (const k of ['command', 'file_path', 'url', 'notebook_path', 'pattern']) if (typeof input[k] === 'string') return input[k] as string;
  return null;
};

/** What a permission is about, so the UI can say "Run this command?" vs "Edit this file?". */
function targetOf(tool: string, input: Record<string, unknown>): { type: 'command' | 'file' | 'url' | 'other'; value: string } {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  if (str('command') !== null) return { type: 'command', value: str('command')! };
  const file = str('file_path') ?? str('notebook_path');
  if (file !== null) return { type: 'file', value: file };
  if (str('url') !== null) return { type: 'url', value: str('url')! };
  const other = str('pattern') ?? str('path') ?? str('query') ?? str('description');
  return { type: 'other', value: other ?? tool };
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs.map((q: Record<string, unknown>) => ({
    question: String(q?.question ?? ''),
    header: String(q?.header ?? ''),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).map((o: Record<string, unknown>) => ({ label: String(o?.label ?? ''), description: String(o?.description ?? '') })),
  }));
}

const inputKey = (tool: string, input: Record<string, unknown>) =>
  tool + '\0' + JSON.stringify(tool === 'AskUserQuestion' ? input.questions : input);

const hookOut = (decision: Record<string, unknown>) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });

export class Store {
  sessions = new Map<string, Session>();
  private conflictSig = '';
  private tails = new Map<string, { sig: string; entry: Entry | undefined }>();
  cfg: Config;
  deps: Deps;
  emit: Emit;

  constructor(cfg: Config, deps: Deps, emit: Emit) {
    this.cfg = cfg; this.deps = deps; this.emit = emit;
  }

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }

  /** The world holding `repo`, else the one whose folder holds `cwd` most closely (so ~/ws/x beats ~/ws beats ~). */
  worldOf(repo: string, cwd: string): string | null {
    for (const w of this.cfg.worlds) if (w.repos.includes(repo)) return w.id;
    let best: string | null = null, len = -1;
    for (const w of this.cfg.worlds) {
      for (const r of w.repos) if (r.length > len && (cwd === r || cwd.startsWith(r === '/' ? '/' : r + '/'))) { best = w.id; len = r.length; }
    }
    return best;
  }

  /** A session's world: the one it was moved to by hand (while that world exists), else its folder's. */
  worldFor(id: string | null, repo: string, cwd: string): string | null {
    const p = id ? this.deps.placements?.get(id) : undefined;
    return p && this.cfg.worlds.some((w) => w.id === p) ? p : this.worldOf(repo, cwd);
  }

  /** Moves one session to a world by hand (null: back to its folder's world). Other sessions of its repo stay. */
  place(id: string, worldId: string | null): [number, string] | null {
    const s = this.sessions.get(id);
    if (!s) return [404, 'no such session'];
    if (worldId !== null && !this.cfg.worlds.some((w) => w.id === worldId)) return [400, 'no such world'];
    if (!this.deps.placements) return [500, 'cannot save placements'];
    this.deps.placements.set(id, worldId === this.worldOf(s.repo, s.cwd) ? null : worldId);
    s.worldId = this.worldFor(id, s.repo, s.cwd);
    this.push(s);
    return null;
  }

  view(s: Session) {
    const pub: Record<string, unknown> = { ...s };
    for (const k of INTERNAL) delete pub[k];
    const p = s.pending[0];
    let card: unknown = s.card;
    if (p && p.kind === 'permission') {
      card = { kind: 'permission', requestId: p.requestId, tool: p.tool, command: commandOf(p.input), target: targetOf(p.tool, p.input), input: p.input, rule: ruleText(p.rule), risky: p.risky, everywhere: whyNotEverywhere(p.rule, p.risky), seenCount: p.seenCount, live: p.live, ambiguous: p.ambiguous };
    } else if (p) {
      card = { kind: 'question', requestId: p.requestId, questions: questionsOf(p.input), live: p.live };
    }
    return { ...pub, helpers: s.helpers.map(({ id, task, state, startedAt }) => ({ id, task, state, startedAt })), card };
  }

  list() { return [...this.sessions.values()].map((s) => this.view(s)); }

  /** What a catch-up describes: the state and card, not the review or the helper chatter. */
  sigOf(s: Session): string {
    const c = s.card;
    return [s.state, c?.kind ?? '', c && 'summary' in c ? c.summary : '', s.pending[0]?.requestId ?? ''].join('\0');
  }

  /** Re-read the branch (a checkout may have happened); at most once per debounce window, with a trailing run. */
  private refreshBranch(s: Session) {
    const gap = this.deps.branchDebounceMs ?? 2000;
    const run = () => {
      s.branchAt = Date.now();
      this.deps.branchOf(s.cwd).then((b) => { if (b !== s.branch && this.sessions.has(s.id)) { s.branch = b; this.push(s); } });
    };
    if (s.branchTimer) return;
    const wait = s.branchAt + gap - Date.now();
    if (wait <= 0) { run(); return; }
    s.branchTimer = setTimeout(() => { s.branchTimer = null; if (this.sessions.has(s.id)) run(); }, wait);
    s.branchTimer.unref();
  }

  /** Broadcast a changed session, plus any other session whose conflicts changed with it. */
  push(s: Session) {
    s.updatedAt = this.now();
    if (s.catchupAt && !s.catchupStale && s.catchupSig !== this.sigOf(s)) s.catchupStale = true;
    const changed = new Set<Session>([s]);
    const all = [...this.sessions.values()];
    const input = all.map((x) => ({ id: x.id, repo: x.repo, cwd: x.cwd, branch: x.branch, worktree: x.worktree, testing: x.testing.size > 0 }));
    // Most pushes (a tool call, a state change) move no folder, branch or test run: the conflicts stay as they are.
    const sig = JSON.stringify(input);
    if (sig !== this.conflictSig) {
      this.conflictSig = sig;
      const next = computeConflicts(input);
      for (const x of all) {
        const c = next.get(x.id) ?? [];
        if (JSON.stringify(c) !== JSON.stringify(x.conflicts)) { x.conflicts = c; changed.add(x); }
      }
    }
    for (const x of changed) if (this.sessions.has(x.id)) this.emit({ type: 'session', session: this.view(x) });
  }

  log(s: Session, text: string) {
    s.log.push({ t: this.now(), text: oneLine(text, 200) ?? '' });
    if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  }

  /** Names a session on its name tag (null or blank: back to its repo's name). */
  relabel(id: string, label: unknown): [number, string] | null {
    const s = this.sessions.get(id);
    if (!s) return [404, 'no such session'];
    if (label !== null && typeof label !== 'string') return [400, 'label must be a string or null'];
    const v = label?.trim() || null;
    if (v && v.length > LABEL_MAX) return [400, `label must be at most ${LABEL_MAX} characters`];
    if (!this.deps.labels) return [500, 'cannot save labels'];
    this.deps.labels.set(id, v);
    s.label = v;
    this.push(s);
    return null;
  }

  /**
   * A session we just launched in tmux, shown at once as 'starting'. Claude may first ask to
   * trust the folder (in the terminal) and sends no hook event until then. Replaced by the real
   * session on the first event from that pane; swept with the tmux session if it dies.
   */
  async addStarting(o: { tmuxSession: string; pane: string | null; direct?: string | null; dir: string; task: string | null; agent?: AgentId; via?: string | null; parent?: string | null; resuming?: boolean }): Promise<string> {
    const liveInTerminal = () => [...this.sessions.values()].find((x) => (o.pane && x.tmux?.pane === o.pane) || (o.direct && x.direct === o.direct));
    const adopt = (live: Session) => {
      if (o.task && !live.task) live.task = oneLine(o.task, 200);
      live.via ??= o.via ?? null;
      if (o.parent && !live.parent) { live.parent = o.parent; this.deps.parents?.set(live.id, o.parent); }
      this.push(live); return live.id;
    };
    // Claude's first hook can beat us here (it is quick to start): then that session already is this one.
    const live = liveInTerminal();
    if (live) return adopt(live);
    const id = `starting:${o.tmuxSession}`;
    const s = await this.create(id, o.dir, null, null, o.agent);
    // Its first hook can also arrive while create() awaits repoInfo.
    const raced = liveInTerminal();
    if (raced && raced !== s) { this.sessions.delete(id); return adopt(raced); }
    s.state = 'starting';
    s.task = o.task ? oneLine(o.task, 200) : null;
    s.tmux = o.pane ? { session: o.tmuxSession, pane: o.pane } : null;
    s.direct = o.direct ?? null;
    s.via = o.via ?? null;
    s.parent = o.parent ?? null;
    s.now = o.resuming ? `Restoring saved ${AGENTS[s.agent].name} conversation…`
      : s.agent === 'codex' ? 'Starting… Codex may ask you to trust this folder and its hooks in the terminal'
      : s.agent === 'gemini' ? 'Starting… Gemini CLI may ask for your API key and to trust this folder in the terminal'
      : s.agent === 'agy' ? 'Starting… Antigravity CLI may ask you to sign in with Google or to trust this folder in the terminal'
      : s.agent === 'kimi' && !o.task ? 'Starting… Kimi Code may ask you to trust this folder, then waits for your first message in the terminal'
      : `Starting… ${AGENTS[s.agent].name} may ask you to trust this folder in the terminal`;
    this.push(s);
    return id;
  }

  private async create(id: string, cwd: string, pane: string | null = null, direct: string | null = null, agent: AgentId = 'claude'): Promise<Session> {
    const info = await this.deps.repoInfo(cwd);
    const existing = this.sessions.get(id); // another event may have created it while git ran
    if (existing) return existing;
    const t = this.now();
    // One pane runs one Claude: a new id there (a 'starting' card, or /clear or /resume made a new
    // conversation, maybe while the server was down) replaces the old session.
    const prior = pane || direct ? [...this.sessions.values()].find((x) => x.id !== id && ((pane && x.tmux?.pane === pane) || (direct && x.direct === direct))) : undefined;
    const starting = prior?.state === 'starting' ? prior : undefined;
    // /clear or /resume in a session moved by hand: the new conversation stays where it was moved
    const moved = prior && this.deps.placements?.get(prior.id);
    if (moved && !this.deps.placements!.get(id)) this.deps.placements!.set(id, moved);
    if (moved && starting) this.deps.placements!.set(starting.id, null); // a placeholder id is never seen again
    // ...and keeps the name you gave it
    const named = prior && this.deps.labels?.get(prior.id);
    if (named && !this.deps.labels!.get(id)) this.deps.labels!.set(id, named);
    if (named && starting) this.deps.labels!.set(starting.id, null);
    const s: Session = {
      id, agent, worldId: this.worldFor(id, info.repo, cwd), repo: info.repo, repoName: basename(info.repo), cwd,
      branch: info.branch, worktree: info.worktree, tmux: null, direct, label: this.deps.labels?.get(id) ?? null, via: null,
      // A started worker, or a new conversation in a worker's pane (/clear), stays on its lead's team
      parent: this.deps.parents?.get(id) ?? prior?.parent ?? null,
      state: 'idle', waitingSince: null, task: null, lastPrompt: null, now: 'Started',
      log: [], helpers: [], card: null, busy: null, busyEnd: null, catchup: null, catchupAt: null, catchupRunning: false, catchupStale: false, context: null, usage: null, conflicts: [],
      startedAt: t, updatedAt: t,
      pending: [], top: info.top ?? cwd, reviewTop: null, workDir: null, baseSha: info.head ?? null, taskSure: false, catchupSig: null, branchAt: 0, branchTimer: null, model: null, transcriptPath: null, logPath: null, tests: null, testing: new Set(), launched: false, hookAt: t, promptAt: t,
    };
    if (starting) {
      s.task = starting.task;
      s.startedAt = starting.startedAt;
      s.tmux = starting.tmux;
      s.via = starting.via;
    }
    if (s.parent && !id.startsWith('starting:') && !this.deps.parents?.get(id)) this.deps.parents?.set(id, s.parent);
    if (prior) {
      // A lead that /clears (or was still a 'starting' card) keeps its workers
      for (const x of this.sessions.values()) if (x.parent === prior.id) { x.parent = id; this.push(x); }
      this.deps.parents?.replaceValue(prior.id, id);
      this.deps.onRenamed?.(prior.id, id);
      this.remove(prior);
    }
    this.sessions.set(id, s); this.conflictSig = '';
    return s;
  }

  private settle(s: Session, p: Pending, body: string | null) {
    if (p.timer) clearTimeout(p.timer);
    if (body !== null && p.resolve) p.resolve(body);
    p.resolve = null;
    const i = s.pending.indexOf(p);
    if (i >= 0) s.pending.splice(i, 1);
  }

  /** Requests no longer on screen (answered in the terminal, turn ended) release their held hook with "{}". */
  private settleAll(s: Session) {
    for (const p of [...s.pending]) this.settle(s, p, '{}');
  }

  /** The state a session rests in once its own turn ended (its card says so), else null. */
  private ended(s: Session): State | null {
    if (s.busy) return 'working';
    const k = s.card?.kind;
    return k === 'asking' ? 'waiting' : k === 'done' || k === 'error' ? k : null;
  }

  private afterPending(s: Session, state: State) {
    if (s.pending.length) return;
    s.state = state;
    s.waitingSince = null;
  }

  /** Handle one hook event. Resolves to the body aw-hook prints ('' = print nothing). */
  async handle(p: Record<string, unknown>, pane: string | null, signal?: AbortSignal, direct: string | null = null, agent: AgentId = 'claude'): Promise<string> {
    const id = p.session_id;
    const ev = p.hook_event_name;
    if (typeof id !== 'string' || !id || typeof ev !== 'string') throw new Error('session_id and hook_event_name are required');
    if (ev === 'SessionEnd') {
      const s = this.sessions.get(id);
      // Claude ends the old conversation (reason clear/resume) before it starts the new one in the same terminal.
      // Kept a moment, the new one finds it as `prior` and takes over its world, name, lead and workers.
      if (s && (p.reason === 'clear' || p.reason === 'resume') && (s.tmux || s.direct)) {
        setTimeout(() => { if (this.sessions.get(id) === s) this.remove(s); }, CLEAR_GRACE_MS).unref();
        return '';
      }
      this.deps.onEnded?.(id, p.reason);
      // Quit for good: forget its lead. Not on other ends: a restart ends the process and resumes the same id.
      if (p.reason === 'prompt_input_exit' || p.reason === 'logout') this.deps.parents?.set(id, null);
      if (s) this.remove(s);
      return '';
    }
    const cwd = typeof p.cwd === 'string' && p.cwd.startsWith('/') ? p.cwd : '/';
    const known = this.sessions.get(id);
    const s = known ?? (await this.create(id, cwd, pane, direct, agent));
    // First heard of mid-turn (the server restarted while it worked, a helper reported first): it is working.
    // Events that set the state themselves (Stop, a question, idle_prompt…) still do so below.
    if (!known && ev !== 'SessionStart' && s.state === 'idle') s.state = 'working';
    s.hookAt = this.now();
    if (direct) s.direct = direct;
    if (pane && s.tmux?.pane !== pane) {
      s.tmux = { session: null, pane };
      this.deps.tmuxSessionOf(pane).then((name) => {
        if (s.tmux?.pane === pane && name) { s.tmux.session = name; if (this.sessions.has(s.id)) this.push(s); }
      });
    }
    // Only Claude's own transcripts feed its catch-up summariser. Other agents' paths stay separate and
    // unconstrained by claudeProjectsDir; Codex's rollout also feeds its conversation view.
    const tp = p.transcript_path;
    if (agent === 'claude' && typeof tp === 'string' && tp.endsWith('.jsonl') && resolve(tp).startsWith(this.cfg.claudeProjectsDir + '/')) s.transcriptPath = tp;
    else if (typeof tp === 'string' && tp.startsWith('/')) s.logPath = tp;
    const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = (p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}) as Record<string, unknown>;
    let reply: Promise<string> | string = '';
    // Tool events from a subagent carry its agent_id. A background one runs on after the turn ended,
    // and must not move the session back to the desks or drop its card.
    // Qwen's memory pass after a turn reports its tool calls with no agent_id and no Stop after them.
    const rest = typeof p.agent_id === 'string' || s.agent === 'qwen' ? this.ended(s) : null;

    switch (ev) {
      case 'SessionStart':
        if (p.source !== 'compact') s.now = 'Started';
        if (typeof p.model === 'string') s.model = p.model;
        break;
      case 'UserPromptSubmit': {
        this.settleAll(s);
        // Kimi sends the prompt as content blocks
        const prompt = typeof p.prompt === 'string' ? p.prompt
          : Array.isArray(p.prompt) ? p.prompt.map((b: { text?: unknown }) => typeof b?.text === 'string' ? b.text : '').join('') : '';
        if (!s.task && prompt && !prompt.startsWith('/')) s.task = oneLine(prompt, 200);
        s.lastPrompt = oneLine(prompt, 200) ?? s.lastPrompt;
        s.state = 'working'; s.waitingSince = null; s.card = null; s.now = 'Thinking';
        s.busy = null; s.busyEnd = null; s.launched = false; s.promptAt = this.now();
        // Qwen sends an empty prompt when its permission prompt is answered
        if (prompt) this.log(s, `You: ${prompt}`);
        this.refreshBranch(s);
        break;
      }
      case 'PreToolUse':
        // A terminal approval precedes this hook; only its matching actor and input are resolved.
        if (s.agent === 'codex') {
          const actor = typeof p.agent_id === 'string' ? p.agent_id : null;
          const pending = s.pending.find((p) => !p.live && p.actor === actor && p.key === inputKey(tool, input));
          if (pending) this.settle(s, pending, null);
        }
        this.log(s, describe(tool, input));
        if (input.run_in_background === true || tool === 'Monitor') s.launched = true;
        if (!rest) {
          s.now = describe(tool, input);
          s.card = null;
          s.busy = null; s.busyEnd = null;
          this.afterPending(s, 'working');
        }
        if (tool === 'Bash' && typeof input.command === 'string' && TEST_RE.test(input.command) && typeof p.tool_use_id === 'string') s.testing.add(p.tool_use_id);
        if (SUBAGENT_TOOLS.has(tool)) {
          s.helpers.push({
            id: typeof p.tool_use_id === 'string' ? p.tool_use_id : randomUUID(),
            task: oneLine(input.description ?? input.subagent_type ?? 'helper', 120) ?? 'helper',
            state: 'working', startedAt: this.now(),
            agentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined,
            bg: input.run_in_background === true,
          });
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const key = inputKey(tool, input);
        // A held call's input is the same before and after; matching its tool name alone could deny another held call of it.
        // Codex already resolved its request at PreToolUse; without request ids, PostToolUse could consume an identical concurrent prompt.
        const match = s.agent === 'codex' ? undefined
          : s.pending.find((x) => x.key === key) ?? (AGENTS[s.agent].holds ? undefined : s.pending.find((x) => x.tool === tool));
        if (match) this.settle(s, match, '{}');
        this.afterPending(s, rest ?? 'working');
        if (typeof p.tool_use_id === 'string') s.testing.delete(p.tool_use_id);
        if (ev === 'PostToolUse' && tool === 'Bash') this.refreshBranch(s);
        const wd = ev === 'PostToolUse' ? workDirOf(tool, input) : null;
        if (wd && wd !== s.workDir) {
          s.workDir = wd;
          // Only a git repo moves the review; a stray edit to a dotfile must not blank it.
          this.deps.repoInfo(wd).then((i) => { if (s.workDir === wd && 'head' in i) { const top = i.top ?? wd; s.reviewTop = top === s.top ? null : top; } }).catch(() => {});
        }
        if (tool === 'Bash' && typeof input.command === 'string' && TEST_RE.test(input.command)) {
          const r = (p.tool_response ?? {}) as Record<string, unknown>;
          const out = [r.stdout, r.stderr, p.error].filter((x) => typeof x === 'string').join('\n');
          s.tests = { command: input.command, ok: ev === 'PostToolUse' && r.interrupted !== true, line: testLine(out) };
        }
        if (SUBAGENT_TOOLS.has(tool)) {
          const h = s.helpers.find((x) => x.id === p.tool_use_id);
          // Backgrounded mid-run (Ctrl+B) returns at once with an async result, though the helper runs on.
          const r = (p.tool_response ?? {}) as Record<string, unknown>;
          if (h && (r.isAsync === true || r.status === 'async_launched')) { h.bg = true; s.launched = true; }
          if (h && !h.bg) h.state = 'done';
        }
        break;
      }
      case 'PermissionRequest': {
        const actor = typeof p.agent_id === 'string' ? p.agent_id : null;
        const overlapping = s.agent === 'codex' ? s.pending.filter((pending) => !pending.live && pending.actor === actor) : [];
        for (const pending of overlapping) pending.ambiguous = true;
        const rule = ruleFor(tool, input, p.permission_suggestions);
        const pend: Pending = {
          requestId: randomUUID(), actor, ambiguous: overlapping.length > 0,
          kind: tool === 'AskUserQuestion' ? 'question' : 'permission',
          tool, input, key: inputKey(tool, input), rule, risky: riskOf(tool, input, s.top),
          seenCount: this.deps.stats.get(s.repo, ruleText(rule)),
          createdAt: this.now(),
          // A held CLI has no prompt of its own to fall back on (gemini.ts, agy.ts): its requests wait for a page to open.
          live: AGENTS[s.agent].decides && (this.deps.clientsConnected() || AGENTS[s.agent].holds), resolve: null, timer: null,
        };
        // Codex has no stable request id: show its newest native prompt without discarding an
        // older request that may still be waiting concurrently.
        if (s.agent === 'codex') s.pending.unshift(pend);
        else s.pending.push(pend);
        s.state = 'waiting';
        s.waitingSince ??= this.now();
        if (!rest) s.card = null;
        this.log(s, pend.kind === 'question' ? 'Asked a question' : `Needs permission: ${describe(tool, input)}`);
        if (!pend.live) { reply = '{}'; break; }
        reply = new Promise<string>((resolve) => {
          pend.resolve = resolve;
          pend.timer = setTimeout(() => {
            pend.live = false; pend.timer = null;
            resolve('{}'); pend.resolve = null;
            // A held CLI has no prompt to answer it in instead: '{}' denied it, so it is gone.
            if (AGENTS[s.agent].holds) { s.pending = s.pending.filter((x) => x !== pend); this.afterPending(s, 'working'); }
            if (this.sessions.has(s.id)) this.push(s);
          }, this.deps.holdMs);
          // Esc in the terminal kills the hook: the request is gone, the session sits at its prompt.
          signal?.addEventListener('abort', () => {
            if (!s.pending.includes(pend) || !pend.resolve) return;
            this.settle(s, pend, null);
            this.afterPending(s, 'idle');
            if (this.sessions.has(s.id)) this.push(s);
          }, { once: true });
        });
        break;
      }
      case 'Notification': {
        const type = p.notification_type;
        if (typeof p.message === 'string') this.log(s, p.message);
        if ((type === 'permission_prompt' || type === 'elicitation_dialog' || type === 'agent_needs_input') && s.state !== 'waiting') {
          s.state = 'waiting'; s.waitingSince = this.now();
          if (typeof p.message === 'string') s.now = oneLine(p.message, 120) ?? s.now;
        }
        // Qwen sends only this when its permission prompt is denied or dismissed with Esc: it is back at its prompt.
        if (type === 'idle_prompt' && s.agent === 'qwen' && s.pending.length) {
          for (const x of [...s.pending]) this.settle(s, x, null);
          this.afterPending(s, this.ended(s) ?? 'idle');
        }
        // Claude sits at its prompt (~60s): a turn interrupted with Esc that checkInterrupts missed.
        if (type === 'idle_prompt' && s.state === 'working' && !this.awaited(s)) this.afterPending(s, 'idle');
        break;
      }
      case 'Stop': {
        this.settleAll(s);
        s.testing.clear();
        this.refreshBranch(s);
        s.busy = null; s.busyEnd = null;
        if (typeof p.last_assistant_message === 'string' && p.last_assistant_message.trim().endsWith('?')) {
          // The turn ended on a question: the session is waiting for an answer, not finished.
          s.state = 'waiting'; s.waitingSince ??= this.now(); s.now = 'Asked you a question';
          // the question is what matters, and it is the last line of the message
          const lines = p.last_assistant_message.split('\n').map((l) => l.trim()).filter(Boolean);
          s.card = { kind: 'asking', summary: oneLine(lines.at(-1)) };
          break;
        }
        // Background work runs on, or a wake-up is scheduled: Claude comes back by itself, so it is still at its desk.
        // Only work started since your prompt brings Claude back. Claude Code also lists long-runners from earlier
        // turns (a dev server, an artifact watcher) and finished helpers; counting those held sessions at their desks.
        const tasks = s.launched && Array.isArray(p.background_tasks) ? p.background_tasks.length : 0;
        const crons = Array.isArray(p.session_crons) ? p.session_crons : [];
        if (tasks || crons.length) {
          const t = this.now(), nextAt = nextWake(crons, t);
          s.state = 'working'; s.waitingSince = null; s.card = null;
          s.busy = { kind: 'background', tasks, nextAt };
          s.busyEnd = { at: Math.max(tasks || !nextAt ? t + BUSY_TTL : 0, nextAt ? nextAt + WAKE_GRACE : 0), summary: oneLine(p.last_assistant_message) };
          s.now = tasks ? `Waiting on ${tasks} background task${tasks > 1 ? 's' : ''}` : 'Scheduled to come back';
          break;
        }
        s.state = 'done'; s.waitingSince = null; s.now = 'Done';
        s.card = { kind: 'done', summary: oneLine(p.last_assistant_message), review: null };
        this.deps.onCompleted?.(s, typeof p.last_assistant_message === 'string' ? p.last_assistant_message : null, 'hook');
        break;
      }
      case 'Interrupt': // Kimi: the turn was cancelled (Esc) and it sits at its prompt
        this.settleAll(s);
        this.afterPending(s, 'idle');
        break;
      case 'PreCompact':
        s.state = 'working'; s.waitingSince = null; s.card = null; s.now = 'Compacting…';
        s.busy = { kind: 'compact' }; s.busyEnd = null;
        break;
      case 'PostCompact':
        if (s.busy?.kind !== 'compact') break;
        s.busy = null; s.now = 'Compacted';
        // /compact by hand returns to the prompt; an automatic one carries on with the turn
        if (p.trigger === 'manual') this.afterPending(s, 'idle');
        break;
      case 'StopFailure': {
        this.settleAll(s);
        s.busy = null; s.busyEnd = null;
        const msg = oneLine(p.error ?? p.error_message ?? p.message ?? p.last_assistant_message) ?? 'Stopped with an error';
        s.state = 'error'; s.waitingSince = null; s.now = msg;
        s.testing.clear();
        s.card = { kind: 'error', summary: msg };
        this.log(s, `Error: ${msg}`);
        break;
      }
      case 'SubagentStart': {
        const h = s.helpers.find((x) => x.state === 'working' && !x.agentId && (!x.agentType || x.agentType === p.agent_type));
        if (h && typeof p.agent_id === 'string') h.agentId = p.agent_id;
        break;
      }
      case 'SubagentStop': {
        const h = s.helpers.find((x) => x.agentId === p.agent_id && x.state === 'working')
          ?? s.helpers.find((x) => x.state === 'working' && (!x.agentType || x.agentType === p.agent_type));
        if (h) h.state = 'done';
        break;
      }
      default:
        return '';
    }
    this.push(s);
    try { this.deps.onEvent?.(s, ev, p); } catch (e) { console.error('[agent-worlds] onEvent failed', e); }
    return reply;
  }

  remove(s: Session) {
    for (const p of [...s.pending]) this.settle(s, p, '{}');
    this.sessions.delete(s.id); this.conflictSig = '';
    this.emit({ type: 'session-removed', id: s.id });
    // conflicts the removed session took part in go away
    const other = this.sessions.values().next().value;
    if (other) this.push(other);
  }

  private live(id: string, requestId: unknown): { s?: Session; p?: Pending; err?: [number, string] } {
    const s = this.sessions.get(id);
    if (!s) return { err: [404, 'no such session'] };
    const p = s.pending.find((x) => x.requestId === requestId);
    if (!p) return { err: [409, 'request is no longer pending'] };
    if (!p.live || !p.resolve) return { err: [409, 'request is only answerable in the terminal now'] };
    return { s, p };
  }

  /** Settings files an "always allow" at this scope writes to. */
  private settingsFiles(s: Session, scope: string): string[] | [number, string] {
    if (scope === 'repo') return [join(s.repo, '.claude', 'settings.local.json')];
    if (scope === 'world') {
      const w = this.cfg.worlds.find((x) => x.id === s.worldId);
      if (!w) return [400, 'this session is not in a world'];
      return w.repos.map((r) => join(r, '.claude', 'settings.local.json'));
    }
    return [this.cfg.userSettingsPath];
  }

  decide(id: string, body: Record<string, unknown>): [number, string] | null {
    if (body.decision !== 'allow' && body.decision !== 'deny') return [400, "decision must be 'allow' or 'deny'"];
    const scope = body.scope ?? 'once';
    if (!['once', 'repo', 'world', 'all'].includes(scope as string)) return [400, 'bad scope'];
    const { s, p, err } = this.live(id, body.requestId);
    if (err) return err;
    if (scope !== 'once' && !AGENTS[s!.agent].alwaysAllow) return [400, `${AGENTS[s!.agent].name} can only be allowed once from here`];
    if (p!.kind !== 'permission') return [409, 'request is a question; use /answer'];
    if (body.decision === 'deny') {
      this.settle(s!, p!, hookOut({ behavior: 'deny', message: 'Denied by the user from Agent Worlds.' }));
      this.log(s!, 'Denied');
    } else {
      const rule = ruleText(p!.rule);
      const decision: Record<string, unknown> = { behavior: 'allow' };
      if (scope !== 'once') {
        const why = scope === 'all' ? whyNotEverywhere(p!.rule, p!.risky) : null;
        if (why) return [400, why];
        const files = this.settingsFiles(s!, scope as string);
        if (typeof files[0] === 'number') return files as [number, string];
        try { for (const f of files as string[]) addAllowRule(f, rule); } catch (e) { return [500, (e as Error).message]; }
        decision.updatedPermissions = [{ type: 'addRules', rules: [p!.rule], behavior: 'allow', destination: 'session' }];
      }
      this.deps.stats.inc(s!.repo, rule);
      this.settle(s!, p!, hookOut(decision));
      this.log(s!, scope === 'once' ? 'Allowed' : `Always allowed (${scope}): ${rule}`);
    }
    this.afterPending(s!, 'working');
    this.push(s!);
    return null;
  }

  answer(id: string, body: Record<string, unknown>): [number, string] | null {
    const answers = body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [400, 'answers must be an object'];
    const { s, p, err } = this.live(id, body.requestId);
    if (err) return err;
    if (p!.kind !== 'question') return [409, 'request is a permission; use /permission'];
    const qs = questionsOf(p!.input);
    const clean: Record<string, string> = {};
    for (const q of qs) {
      const a = (answers as Record<string, unknown>)[q.question];
      if (typeof a !== 'string' || !a.trim() || a.length > 4000) return [400, `missing answer for: ${q.question}`];
      clean[q.question] = a;
    }
    this.settle(s!, p!, hookOut({ behavior: 'allow', updatedInput: { ...p!.input, answers: clean } }));
    this.log(s!, 'Answered a question');
    this.afterPending(s!, 'working');
    this.push(s!);
    return null;
  }

  ack(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (s.pending.some((p) => p.live)) return true; // never drop a live request by acking
    s.state = 'idle'; s.card = null; s.waitingSince = null;
    for (const p of [...s.pending]) this.settle(s, p, null);
    this.push(s);
    return true;
  }

  /** After worlds change: re-derive every session's world and broadcast the ones that moved. */
  recomputeWorlds() {
    for (const s of this.sessions.values()) {
      const w = this.worldFor(s.id, s.repo, s.cwd);
      if (w !== s.worldId) { s.worldId = w; this.push(s); }
    }
  }

  /** Background work that never reported back: show the turn as done after all. */
  checkBusy() {
    const t = this.now();
    for (const s of this.sessions.values()) {
      if (!s.busyEnd || t < s.busyEnd.at) continue;
      s.state = 'done'; s.now = 'Done'; s.waitingSince = null;
      s.card = { kind: 'done', summary: s.busyEnd.summary, review: null };
      s.busy = null; s.busyEnd = null;
      this.push(s);
    }
  }

  /** Claude sits at its prompt but comes back by itself: background tasks, a wake-up, or a background helper still running. */
  private awaited(s: Session) {
    return !!s.busy || s.helpers.some((h) => h.bg && h.state === 'working');
  }

  /** Surface Codex's native approval when its PermissionRequest hook did not arrive. */
  async checkCodexPrompts(capture: (pane: string) => Promise<string | null>) {
    const sessions = [...this.sessions.values()].filter((s) => s.agent === 'codex' && s.tmux &&
      (s.state === 'working' || s.pending.some((p) => !p.live) || s.card?.kind === 'permission' && s.card.requestId === CODEX_TERMINAL_REQUEST));
    await Promise.all(sessions.map(async (s) => {
      const screen = await capture(s.tmux!.pane);
      if (screen === null || this.sessions.get(s.id) !== s) return;
      const terminalPending = s.pending.filter((p) => !p.live);
      if (terminalPending.length) {
        if (codexApprovalOnScreen(screen) || !/› Ask Codex to do anything/.test(screen) || terminalPending.some((p) => this.now() - p.createdAt < CODEX_PERMISSION_GRACE)) return;
        const rest = this.ended(s) ?? 'working';
        for (const pending of terminalPending) this.settle(s, pending, null);
        this.afterPending(s, rest);
        if (rest === 'working') s.now = 'Thinking';
        this.push(s);
        return;
      }
      const synthetic = s.card?.kind === 'permission' && s.card.requestId === CODEX_TERMINAL_REQUEST;
      if (codexApprovalOnScreen(screen)) {
        if (s.state !== 'working' || s.card) return;
        const command = 'Review the command in Codex’s terminal';
        s.card = { kind: 'permission', requestId: CODEX_TERMINAL_REQUEST, tool: 'Bash', command,
          target: { type: 'command', value: command }, input: {}, risky: null, seenCount: 0, live: false };
        s.state = 'waiting'; s.waitingSince = this.now(); s.now = 'Approval in terminal';
      } else {
        if (!synthetic) return;
        s.card = null; s.state = 'working'; s.waitingSince = null; s.now = 'Thinking';
      }
      this.push(s);
    }));
  }

  /**
   * Esc mid-turn fires no hook (Stop "does not run if the stoppage occurred due to a user interrupt"):
   * Claude only appends "[Request interrupted by user…]" to its transcript. Polled for working sessions.
   */
  async checkInterrupts() {
    for (const s of [...this.sessions.values()]) {
      if (s.state !== 'working' || s.pending.length || this.awaited(s)) continue;
      if (s.agent === 'codex') { if (s.logPath) await this.checkCodexTurn(s, s.logPath); continue; }
      if (!s.transcriptPath) continue;
      // The marker is rarely the last line: system, last-prompt, file-history-snapshot or a task notification follow it.
      // Interrupted when it comes after Claude's last reply, and after your prompt (else it is an earlier turn's).
      const last = await this.tailFind(s.transcriptPath, 32 * 1024, (e) => e.type === 'assistant' || interruptMark(e));
      if (!last || last.type !== 'user') continue;
      if (!(Date.parse(last.timestamp) >= s.promptAt) || s.state !== 'working' || !this.sessions.has(s.id)) continue;
      this.afterPending(s, 'idle');
      s.now = 'Interrupted';
      this.push(s);
    }
  }

  /**
   * Codex fires no hook when a turn fails (a usage limit), and none is promised on Esc. Its rollout log still
   * ends every turn: task_complete (with `error` when it failed) or turn_aborted.
   */
  /** The last entry in a log's tail that `match` picks, re-read only when the file has changed since the last poll. */
  private async tailFind(path: string, bytes: number, match: (e: Entry) => boolean): Promise<Entry | undefined> {
    let sig: string;
    try { const st = await stat(path); sig = `${st.size}:${st.mtimeMs}`; } catch { return undefined; }
    const hit = this.tails.get(path);
    if (hit?.sig === sig) return hit.entry;
    let entries: Entry[];
    try { entries = await readTail(path, bytes); } catch { return undefined; } // a failed read is tried again next poll
    const entry = entries.findLast(match);
    this.tails.delete(path); this.tails.set(path, { sig, entry });
    if (this.tails.size > 1000) this.tails.delete(this.tails.keys().next().value!);
    return entry;
  }

  private async checkCodexTurn(s: Session, path: string) {
    const end = await this.tailFind(path, 65536, (e) => e.type === 'event_msg' && CODEX_TURN.has(e.payload?.type));
    const at = Date.parse(end?.timestamp);
    // Still running, an ending from before the last hook (an earlier turn), or one so fresh its Stop may be on the way.
    if (!end || end.payload.type === 'task_started' || !(at >= s.hookAt) || this.now() - at < CODEX_GRACE) return;
    if (s.state !== 'working' || !this.sessions.has(s.id)) return;
    const p = end.payload;
    s.waitingSince = null;
    s.testing.clear();
    if (p.type === 'turn_aborted') {
      this.afterPending(s, 'idle');
      s.now = 'Interrupted';
    } else if (p.error) {
      const msg = oneLine(p.error.message) ?? 'Stopped with an error';
      s.state = 'error'; s.now = msg;
      s.card = { kind: 'error', summary: msg };
      this.log(s, `Error: ${msg}`);
    } else {
      s.state = 'done'; s.now = 'Done';
      s.card = { kind: 'done', summary: oneLine(p.last_agent_message), review: null };
      this.deps.onCompleted?.(s, typeof p.last_agent_message === 'string' ? p.last_agent_message : null, 'poll');
    }
    this.push(s);
  }

  /** Drop sessions whose tmux pane has gone away, including panes whose session name was never resolved. */
  sweep(alive: Map<string, Set<string>>) {
    for (const s of [...this.sessions.values()]) if (s.tmux && (!alive.has(s.tmux.pane) || (s.tmux.session && !alive.get(s.tmux.pane)!.has(s.tmux.session)))) this.remove(s);
  }
}

/** Where a session wrote: the folder of a file it edited, or the folder of a `cd /x && … git commit` / `git -C /x commit`. */
export function workDirOf(tool: string, input: Record<string, unknown>): string | null {
  const file = input.file_path ?? input.notebook_path;
  if (WRITE_TOOLS.has(tool) && typeof file === 'string' && file.startsWith('/')) return dirname(file);
  const cmd = input.command;
  if (tool !== 'Bash' || typeof cmd !== 'string' || !/\bgit\b[^;&|]*\bcommit\b/.test(cmd)) return null;
  const m = cmd.match(/^\s*cd\s+(["']?)(\/[^"'\s;&|]+)\1\s*(?:&&|;)/) ?? cmd.match(/\bgit\s+-C\s+(["']?)(\/[^"'\s;&|]+)\1/);
  return m ? m[2] : null;
}

/**
 * When the next one-shot wake-up (ScheduleWakeup) fires, from its cron expression "M H D Mo *" in local time.
 * Recurring crons are not worked out; null when there is none.
 */
export function nextWake(crons: unknown[], now: number): number | null {
  let best: number | null = null;
  for (const c of crons as { schedule?: unknown; recurring?: unknown }[]) {
    if (c?.recurring !== false || typeof c.schedule !== 'string') continue;
    const m = /^(\d+) (\d+) (\d+) (\d+) \*$/.exec(c.schedule.trim());
    if (!m) continue;
    const [min, hour, day, month] = m.slice(1).map(Number);
    const year = new Date(now).getFullYear();
    let at = new Date(year, month - 1, day, hour, min).getTime();
    if (at < now - 60_000) at = new Date(year + 1, month - 1, day, hour, min).getTime();
    if (best === null || at < best) best = at;
  }
  return best;
}
