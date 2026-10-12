import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Config } from './config.ts';
import type { RepoInfo } from './sys.ts';

type State = 'working' | 'waiting' | 'done' | 'error' | 'idle';
type Helper = { id: string; task: string; state: 'working' | 'done'; startedAt: number };
type Question = { question: string; header: string; multiSelect: boolean; options: { label: string; description: string }[] };
type Card =
  | null
  | { kind: 'done'; summary: string | null; review: null }
  | { kind: 'error'; summary: string };

type Pending = {
  requestId: string;
  kind: 'permission' | 'question';
  tool: string;
  input: Record<string, unknown>;
  key: string;
  seenCount: number;
  live: boolean;
  resolve: ((body: string) => void) | null;
  timer: NodeJS.Timeout | null;
};

type Session = {
  id: string; worldId: string | null; repo: string; repoName: string; cwd: string;
  branch: string | null; worktree: boolean; tmux: { session: string | null; pane: string } | null;
  state: State; waitingSince: number | null; task: string | null; now: string;
  log: { t: number; text: string }[];
  helpers: (Helper & { agentId?: string; agentType?: string; bg?: boolean })[];
  card: Card;
  startedAt: number; updatedAt: number;
  pending: Pending[];
  seen: Map<string, number>;
};

export type Deps = {
  repoInfo: (cwd: string) => Promise<RepoInfo>;
  branchOf: (cwd: string) => Promise<string | null>;
  tmuxSessionOf: (pane: string) => Promise<string | null>;
  clientsConnected: () => boolean;
  holdMs: number;
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

const RISKS: [RegExp, string][] = [
  [/\brm\s+(-{1,2}[\w-]+\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\s|$)/, 'deletes files recursively'],
  [/\bgit\s+push\b[^;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, 'force-pushes git history'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|restore\b)/, 'discards local changes'],
  [/\bsudo\b/, 'runs as root'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'drops data'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'pipes a download into a shell'],
  [/\b(mkfs|dd\s+if=)|>\s*\/dev\/sd/, 'writes to a disk device'],
  [/\bchmod\s+(-R\s+)?777\b/, 'makes files world-writable'],
];

export function riskOf(tool: string, input: Record<string, unknown>): string | null {
  if (tool !== 'Bash' || typeof input.command !== 'string') return null;
  for (const [re, why] of RISKS) if (re.test(input.command)) return why;
  return null;
}

function describe(tool: string, input: Record<string, unknown>): string {
  const arg = input.command ?? input.description ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.prompt;
  return oneLine(typeof arg === 'string' ? `${tool}: ${arg}` : tool, 120) ?? tool;
}

const commandOf = (input: Record<string, unknown>): string | null => {
  for (const k of ['command', 'file_path', 'url', 'notebook_path', 'pattern']) if (typeof input[k] === 'string') return input[k] as string;
  return null;
};

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

  worldOf(repo: string, cwd: string): string | null {
    for (const w of this.cfg.worlds) if (w.repos.includes(repo)) return w.id;
    for (const w of this.cfg.worlds) if (w.repos.some((r) => cwd === r || cwd.startsWith(r + '/'))) return w.id;
    return null;
  }

  view(s: Session) {
    const { pending, seen, ...pub } = s;
    const p = pending[0];
    let card: unknown = s.card;
    if (p && p.kind === 'permission') {
      card = { kind: 'permission', requestId: p.requestId, tool: p.tool, command: commandOf(p.input), input: p.input, risky: riskOf(p.tool, p.input), seenCount: p.seenCount, live: p.live };
    } else if (p) {
      card = { kind: 'question', requestId: p.requestId, questions: questionsOf(p.input), live: p.live };
    }
    return {
      ...pub,
      helpers: s.helpers.map(({ id, task, state, startedAt }) => ({ id, task, state, startedAt })),
      card,
      catchup: null, context: null, conflicts: [],
    };
  }

  list() { return [...this.sessions.values()].map((s) => this.view(s)); }

  private push(s: Session) {
    s.updatedAt = this.now();
    this.emit({ type: 'session', session: this.view(s) });
  }

  private log(s: Session, text: string) {
    s.log.push({ t: this.now(), text: oneLine(text, 200) ?? '' });
    if (s.log.length > LOG_MAX) s.log.splice(0, s.log.length - LOG_MAX);
  }

  private async create(id: string, cwd: string): Promise<Session> {
    const info = await this.deps.repoInfo(cwd);
    const existing = this.sessions.get(id); // another event may have created it while git ran
    if (existing) return existing;
    const t = this.now();
    const s: Session = {
      id, worldId: this.worldOf(info.repo, cwd), repo: info.repo, repoName: basename(info.repo), cwd,
      branch: info.branch, worktree: info.worktree, tmux: null,
      state: 'idle', waitingSince: null, task: null, now: 'Started',
      log: [], helpers: [], card: null, startedAt: t, updatedAt: t, pending: [], seen: new Map(),
    };
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
  async handle(p: Record<string, unknown>, pane: string | null, signal?: AbortSignal): Promise<string> {
    const id = p.session_id;
    const ev = p.hook_event_name;
    if (typeof id !== 'string' || !id || typeof ev !== 'string') throw new Error('session_id and hook_event_name are required');
    if (ev === 'SessionEnd') {
      const s = this.sessions.get(id);
      if (s) this.remove(s);
      return '';
    }
    const cwd = typeof p.cwd === 'string' && p.cwd.startsWith('/') ? p.cwd : '/';
    const s = this.sessions.get(id) ?? (await this.create(id, cwd));
    if (pane && s.tmux?.pane !== pane) {
      s.tmux = { session: null, pane };
      this.deps.tmuxSessionOf(pane).then((name) => {
        if (s.tmux?.pane === pane && name) { s.tmux.session = name; if (this.sessions.has(s.id)) this.push(s); }
      });
    }
    const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
    const input = (p.tool_input && typeof p.tool_input === 'object' ? p.tool_input : {}) as Record<string, unknown>;
    let reply: Promise<string> | string = '';

    switch (ev) {
      case 'SessionStart':
        s.now = 'Started';
        break;
      case 'UserPromptSubmit': {
        this.settleAll(s);
        const prompt = typeof p.prompt === 'string' ? p.prompt : '';
        if (!s.task && prompt && !prompt.startsWith('/')) s.task = oneLine(prompt, 200);
        s.state = 'working'; s.waitingSince = null; s.card = null; s.now = 'Thinking';
        this.log(s, `You: ${prompt}`);
        this.deps.branchOf(s.cwd).then((b) => { if (b !== s.branch && this.sessions.has(s.id)) { s.branch = b; this.push(s); } });
        break;
      }
      case 'PreToolUse':
        s.now = describe(tool, input);
        this.log(s, s.now);
        s.card = null;
        this.afterPending(s, 'working');
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
        if (SUBAGENT_TOOLS.has(tool)) {
          const h = s.helpers.find((x) => x.id === p.tool_use_id);
          if (h && !h.bg) h.state = 'done';
        }
        break;
      }
      case 'PermissionRequest': {
        const key = inputKey(tool, input);
        const seenCount = (s.seen.get(key) ?? 0) + 1;
        s.seen.set(key, seenCount);
        const pend: Pending = {
          requestId: randomUUID(), kind: tool === 'AskUserQuestion' ? 'question' : 'permission',
          tool, input, key, seenCount, live: this.deps.clientsConnected(), resolve: null, timer: null,
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
        s.state = 'done'; s.waitingSince = null; s.now = 'Done';
        s.card = { kind: 'done', summary: oneLine(p.last_assistant_message), review: null };
        break;
      case 'StopFailure': {
        this.settleAll(s);
        const msg = oneLine(p.error ?? p.error_message ?? p.message ?? p.last_assistant_message) ?? 'Stopped with an error';
        s.state = 'error'; s.waitingSince = null; s.now = msg;
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
    return reply;
  }

  remove(s: Session) {
    for (const p of [...s.pending]) this.settle(s, p, '{}');
    this.sessions.delete(s.id);
    this.emit({ type: 'session-removed', id: s.id });
  }

  private live(id: string, requestId: unknown): { s?: Session; p?: Pending; err?: [number, string] } {
    const s = this.sessions.get(id);
    if (!s) return { err: [404, 'no such session'] };
    const p = s.pending.find((x) => x.requestId === requestId);
    if (!p) return { err: [409, 'request is no longer pending'] };
    if (!p.live || !p.resolve) return { err: [409, 'request is only answerable in the terminal now'] };
    return { s, p };
  }

  decide(id: string, body: Record<string, unknown>): [number, string] | null {
    if (body.decision !== 'allow' && body.decision !== 'deny') return [400, "decision must be 'allow' or 'deny'"];
    if (body.scope !== undefined && !['once', 'repo', 'world', 'all'].includes(body.scope as string)) return [400, 'bad scope'];
    const { s, p, err } = this.live(id, body.requestId);
    if (err) return err;
    if (p!.kind !== 'permission') return [409, 'request is a question; use /answer'];
    this.settle(s!, p!, hookOut(body.decision === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Denied by the user from Agent Worlds.' }));
    this.log(s!, body.decision === 'allow' ? 'Allowed' : 'Denied');
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

  /** Drop sessions whose tmux session has gone away. */
  sweep(alive: string[]) {
    for (const s of [...this.sessions.values()]) if (s.tmux?.session && !alive.includes(s.tmux.session)) this.remove(s);
  }
}
