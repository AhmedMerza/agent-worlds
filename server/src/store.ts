import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import type { Config } from './config.ts';
import type { RepoInfo } from './sys.ts';
import type { Review } from './review.ts';
import { TEST_RE, testLine } from './review.ts';
import { riskOf, ruleFor, ruleText, addAllowRule, whyNotEverywhere, WRITE_TOOLS, type Rule } from './rules.ts';
import { computeConflicts, type Conflict } from './conflicts.ts';

export { riskOf };

type State = 'starting' | 'working' | 'waiting' | 'done' | 'error' | 'idle';
type Helper = { id: string; task: string; state: 'working' | 'done'; startedAt: number };
type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };
type Card =
  | null
  | { kind: 'done'; summary: string | null; review: Review | null }
  | { kind: 'asking'; summary: string | null }
  | { kind: 'error'; summary: string };

type Pending = {
  requestId: string;
  kind: 'permission' | 'question';
  tool: string;
  input: Record<string, unknown>;
  key: string;
  rule: Rule;
  risky: string | null;
  seenCount: number;
  live: boolean;
  resolve: ((body: string) => void) | null;
  timer: NodeJS.Timeout | null;
};

export type Session = {
  id: string; worldId: string | null; repo: string; repoName: string; cwd: string;
  branch: string | null; worktree: boolean; tmux: { session: string | null; pane: string } | null;
  /** Set when the server runs this session itself (no tmux): the name of its pty. */
  direct: string | null;
  state: State; waitingSince: number | null; task: string | null; lastPrompt: string | null; now: string;
  log: { t: number; text: string }[];
  helpers: (Helper & { agentId?: string; agentType?: string; bg?: boolean })[];
  card: Card;
  catchup: { asked: string; did: string; needs: string } | null;
  catchupAt: number | null;
  catchupRunning: boolean;
  /** State or card changed after the catch-up was made. */
  catchupStale: boolean;
  context: { used: number; limit: number; pct: number } | null;
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
  tests: Review['tests'];
  testing: Set<string>;
};
const INTERNAL = ['pending', 'top', 'reviewTop', 'workDir', 'baseSha', 'taskSure', 'catchupSig', 'branchAt', 'branchTimer', 'model', 'transcriptPath', 'tests', 'testing'] as const;

export type Deps = {
  repoInfo: (cwd: string) => Promise<RepoInfo>;
  branchOf: (cwd: string) => Promise<string | null>;
  tmuxSessionOf: (pane: string) => Promise<string | null>;
  clientsConnected: () => boolean;
  holdMs: number;
  /** Minimum gap between branch refreshes of one session (default 2000). */
  branchDebounceMs?: number;
  stats: { get(repo: string, rule: string): number; inc(repo: string, rule: string): number };
  /** Called after every handled event, for derived data (catch-up, context, review). */
  onEvent?: (s: Session, ev: string, p: Record<string, unknown>) => void;
  now?: () => number;
};

export type Emit = (ev: { type: 'session'; session: unknown } | { type: 'session-removed'; id: string }) => void;

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
const LOG_MAX = 20;

export const oneLine = (s: unknown, max = 160): string | null => {
  if (typeof s !== 'string') return null;
  const line = s.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

function describe(tool: string, input: Record<string, unknown>): string {
  const arg = input.command ?? input.description ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt;
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

  view(s: Session) {
    const pub: Record<string, unknown> = { ...s };
    for (const k of INTERNAL) delete pub[k];
    const p = s.pending[0];
    let card: unknown = s.card;
    if (p && p.kind === 'permission') {
      card = { kind: 'permission', requestId: p.requestId, tool: p.tool, command: commandOf(p.input), target: targetOf(p.tool, p.input), input: p.input, rule: ruleText(p.rule), risky: p.risky, everywhere: whyNotEverywhere(p.rule, p.risky), seenCount: p.seenCount, live: p.live };
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
    const next = computeConflicts(all.map((x) => ({ id: x.id, repo: x.repo, cwd: x.cwd, branch: x.branch, worktree: x.worktree, testing: x.testing.size > 0 })));
    for (const x of all) {
      const c = next.get(x.id) ?? [];
      if (JSON.stringify(c) !== JSON.stringify(x.conflicts)) { x.conflicts = c; changed.add(x); }
    }
    for (const x of changed) if (this.sessions.has(x.id)) this.emit({ type: 'session', session: this.view(x) });
  }

  private log(s: Session, text: string) {
    s.log.push({ t: this.now(), text: oneLine(text, 200) ?? '' });
    if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  }

  /**
   * A session we just launched in tmux, shown at once as 'starting'. Claude may first ask to
   * trust the folder (in the terminal) and sends no hook event until then. Replaced by the real
   * session on the first event from that pane; swept with the tmux session if it dies.
   */
  async addStarting(o: { tmuxSession: string; pane: string | null; direct?: string | null; dir: string; task: string | null }): Promise<string> {
    // Claude's first hook can beat us here (it is quick to start): then that session already is this one.
    const live = [...this.sessions.values()].find((x) => (o.pane && x.tmux?.pane === o.pane) || (o.direct && x.direct === o.direct));
    if (live) { if (o.task && !live.task) { live.task = oneLine(o.task, 200); this.push(live); } return live.id; }
    const id = `starting:${o.tmuxSession}`;
    const s = await this.create(id, o.dir);
    s.state = 'starting';
    s.task = o.task ? oneLine(o.task, 200) : null;
    s.tmux = o.pane ? { session: o.tmuxSession, pane: o.pane } : null;
    s.direct = o.direct ?? null;
    s.now = 'Starting… Claude may ask you to trust this folder in the terminal';
    this.push(s);
    return id;
  }

  private async create(id: string, cwd: string, pane: string | null = null, direct: string | null = null): Promise<Session> {
    const info = await this.deps.repoInfo(cwd);
    const existing = this.sessions.get(id); // another event may have created it while git ran
    if (existing) return existing;
    const t = this.now();
    const starting = pane || direct ? [...this.sessions.values()].find((x) => x.state === 'starting' && ((pane && x.tmux?.pane === pane) || (direct && x.direct === direct))) : undefined;
    const s: Session = {
      id, worldId: this.worldOf(info.repo, cwd), repo: info.repo, repoName: basename(info.repo), cwd,
      branch: info.branch, worktree: info.worktree, tmux: null, direct,
      state: 'idle', waitingSince: null, task: null, lastPrompt: null, now: 'Started',
      log: [], helpers: [], card: null, catchup: null, catchupAt: null, catchupRunning: false, catchupStale: false, context: null, conflicts: [],
      startedAt: t, updatedAt: t,
      pending: [], top: info.top ?? cwd, reviewTop: null, workDir: null, baseSha: info.head ?? null, taskSure: false, catchupSig: null, branchAt: 0, branchTimer: null, model: null, transcriptPath: null, tests: null, testing: new Set(),
    };
    if (starting) {
      s.task = starting.task;
      s.startedAt = starting.startedAt;
      s.tmux = starting.tmux;
      this.sessions.delete(starting.id);
      this.emit({ type: 'session-removed', id: starting.id });
    }
    this.sessions.set(id, s);
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

  private afterPending(s: Session, state: State) {
    if (s.pending.length) return;
    s.state = state;
    s.waitingSince = null;
  }

  /** Handle one hook event. Resolves to the body aw-hook prints ('' = print nothing). */
  async handle(p: Record<string, unknown>, pane: string | null, signal?: AbortSignal, direct: string | null = null): Promise<string> {
    const id = p.session_id;
    const ev = p.hook_event_name;
    if (typeof id !== 'string' || !id || typeof ev !== 'string') throw new Error('session_id and hook_event_name are required');
    if (ev === 'SessionEnd') {
      const s = this.sessions.get(id);
      if (s) this.remove(s);
      return '';
    }
    const cwd = typeof p.cwd === 'string' && p.cwd.startsWith('/') ? p.cwd : '/';
    const s = this.sessions.get(id) ?? (await this.create(id, cwd, pane, direct));
    if (direct) s.direct = direct;
    if (pane && s.tmux?.pane !== pane) {
      s.tmux = { session: null, pane };
      this.deps.tmuxSessionOf(pane).then((name) => {
        if (s.tmux?.pane === pane && name) { s.tmux.session = name; if (this.sessions.has(s.id)) this.push(s); }
      });
    }
    // Only Claude's own transcripts: the catch-up summariser reads this file.
    const tp = p.transcript_path;
    if (typeof tp === 'string' && tp.endsWith('.jsonl') && resolve(tp).startsWith(this.cfg.claudeProjectsDir + '/')) s.transcriptPath = tp;
    const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = (p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}) as Record<string, unknown>;
    let reply: Promise<string> | string = '';

    switch (ev) {
      case 'SessionStart':
        s.now = 'Started';
        if (typeof p.model === 'string') s.model = p.model;
        break;
      case 'UserPromptSubmit': {
        this.settleAll(s);
        const prompt = typeof p.prompt === 'string' ? p.prompt : '';
        if (!s.task && prompt && !prompt.startsWith('/')) s.task = oneLine(prompt, 200);
        s.lastPrompt = oneLine(prompt, 200) ?? s.lastPrompt;
        s.state = 'working'; s.waitingSince = null; s.card = null; s.now = 'Thinking';
        this.log(s, `You: ${prompt}`);
        this.refreshBranch(s);
        break;
      }
      case 'PreToolUse':
        s.now = describe(tool, input);
        this.log(s, s.now);
        s.card = null;
        this.afterPending(s, 'working');
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
        const match = s.pending.find((x) => x.key === key) ?? s.pending.find((x) => x.tool === tool);
        if (match) this.settle(s, match, '{}');
        this.afterPending(s, 'working');
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
          if (h && !h.bg) h.state = 'done';
        }
        break;
      }
      case 'PermissionRequest': {
        const rule = ruleFor(tool, input, p.permission_suggestions);
        const pend: Pending = {
          requestId: randomUUID(), kind: tool === 'AskUserQuestion' ? 'question' : 'permission',
          tool, input, key: inputKey(tool, input), rule, risky: riskOf(tool, input, s.top),
          seenCount: this.deps.stats.get(s.repo, ruleText(rule)),
          live: this.deps.clientsConnected(), resolve: null, timer: null,
        };
        s.pending.push(pend);
        s.state = 'waiting';
        s.waitingSince ??= this.now();
        s.card = null;
        this.log(s, pend.kind === 'question' ? 'Asked a question' : `Needs permission: ${describe(tool, input)}`);
        if (!pend.live) { reply = '{}'; break; }
        reply = new Promise<string>((resolve) => {
          pend.resolve = resolve;
          pend.timer = setTimeout(() => {
            pend.live = false; pend.timer = null;
            resolve('{}'); pend.resolve = null;
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
        break;
      }
      case 'Stop':
        this.settleAll(s);
        s.testing.clear();
        this.refreshBranch(s);
        if (typeof p.last_assistant_message === 'string' && p.last_assistant_message.trim().endsWith('?')) {
          // The turn ended on a question: the session is waiting for an answer, not finished.
          s.state = 'waiting'; s.waitingSince ??= this.now(); s.now = 'Asked you a question';
          // the question is what matters, and it is the last line of the message
          const lines = p.last_assistant_message.split('\n').map((l) => l.trim()).filter(Boolean);
          s.card = { kind: 'asking', summary: oneLine(lines.at(-1)) };
          break;
        }
        s.state = 'done'; s.waitingSince = null; s.now = 'Done';
        s.card = { kind: 'done', summary: oneLine(p.last_assistant_message), review: null };
        break;
      case 'StopFailure': {
        this.settleAll(s);
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
    this.sessions.delete(s.id);
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
      const w = this.worldOf(s.repo, s.cwd);
      if (w !== s.worldId) { s.worldId = w; this.push(s); }
    }
  }

  /** Drop sessions whose tmux session has gone away. */
  sweep(alive: string[]) {
    for (const s of [...this.sessions.values()]) if (s.tmux?.session && !alive.includes(s.tmux.session)) this.remove(s);
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
