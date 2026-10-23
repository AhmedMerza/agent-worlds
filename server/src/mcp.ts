/**
 * The MCP server sessions reach through bin/aw-mcp: just enough of the protocol (JSON-RPC over plain
 * POST, JSON replies) for the agent CLIs to list and call its tools. Tool names carry an `aw_` prefix:
 * Codex has a built-in send_message that would win over a plain name.
 */

export type Peer = { id: string; agent: string; repo: string; branch: string | null; task: string | null; state: string; parent: string | null };
export type SpawnArgs = { folder: string; agent?: string; worktree?: boolean; task: string; steps?: unknown };
export type McpContext = {
  /** The calling session, or null when the server does not know it (yet). */
  self: string | null;
  peers(): Peer[];
  /** Send; the result text for the caller, or an Error to report. */
  send(to: string, text: string): string | Error;
  inbox(): string;
  /** End the caller's step of a run; the result text, or an Error. */
  handoff(summary: string): Promise<string | Error>;
  /** Start a worker session (or a run) on the caller's team; the result text, or an Error. */
  spawn(a: SpawnArgs): Promise<string | Error>;
  /** End a session the caller started; the result text, or an Error. */
  stop(session: string): Promise<string | Error>;
};

const TOOLS = [
  {
    name: 'aw_agents',
    description: 'List the other coding-agent sessions (Claude Code, Codex, Qwen Code, Kimi Code, Gemini CLI) running under Agent Worlds that you can message: id, agent, repo, branch, task, state, and parent (the session that started it with aw_spawn). Use the `id` field with aw_send, not the branch, repo@branch label, or tmux session name.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aw_send',
    description: 'Send a message to another Agent Worlds session (the `id` field from aw_agents). Do not use its branch, repo@branch label, or tmux session name. It is told it has mail as soon as it is free; while it is working, the message stays queued. A reply reaches you the same way: you will be prompted to call aw_inbox, so do not wait or poll for it — finish your turn.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: 'Session id (or a unique start of one) from aw_agents' }, text: { type: 'string', description: 'The message' } },
      required: ['to', 'text'], additionalProperties: false,
    },
  },
  {
    name: 'aw_inbox',
    description: 'Read the messages other Agent Worlds sessions sent you (each is shown once). Reply with aw_send.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'aw_handoff',
    description: 'Only when you are a step of an Agent Worlds run (your first message said so): your part is done, hand over to the next step. The summary goes to the next agent.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'What you did, where your output is, and anything the next step must know' } },
      required: ['summary'], additionalProperties: false,
    },
  },
  {
    name: 'aw_spawn',
    description: 'Start a worker session for a task, in one of your world\'s folders, as part of your team (only when the user enabled it for the world). It gets the task as its first message; message it with aw_send, end it with aw_stop. With `steps`, start an Agent Worlds run instead: the task goes through those steps, each a session on its own agent.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'One of your world\'s folders: its full path, or its name' },
        task: { type: 'string', description: 'The first message: what the worker should do' },
        agent: { type: 'string', description: 'The agent CLI: claude, codex, qwen, kimi, gemini or agy. Default: the user\'s default' },
        worktree: { type: 'boolean', description: 'Work in a new git worktree on its own branch (default true)' },
        steps: {
          type: 'array', description: 'Optional: start a run with these steps (1 to 8) instead of one session',
          items: { type: 'object', properties: { kind: { type: 'string', enum: ['plan', 'review-plan', 'build', 'review-code'] }, agent: { type: 'string' }, checkpoint: { type: 'boolean' } }, required: ['kind', 'agent'] },
        },
      },
      required: ['folder', 'task'], additionalProperties: false,
    },
  },
  {
    name: 'aw_stop',
    description: 'End a session you started with aw_spawn: quits its agent and closes its terminal, as the user\'s End does. Only your own workers.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Its id (or a unique start of one) from aw_agents, or the tmux session aw_spawn named' } },
      required: ['session'], additionalProperties: false,
    },
  },
];

/** Every tool's name: sessions we start may call them without asking (hooks.ts). */
export const TOOL_NAMES = TOOLS.map((t) => t.name);

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const text = (t: string, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

/** Answer one JSON-RPC message; null for notifications, which get no reply. */
export async function handleMcp(msg: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const m = msg as { id?: unknown; method?: unknown; params?: Record<string, any> };
  if (typeof m.method !== 'string') return rpcError(m.id, -32600, 'invalid request');
  if (m.id === undefined) return null; // notifications/initialized, notifications/cancelled, …
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-worlds', version: '1' },
        instructions: 'Message the other coding agents working under Agent Worlds: aw_agents lists them, aw_send sends, aw_inbox reads what they sent you. Where the user allows it, aw_spawn starts a worker session and aw_stop ends one.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call':
      return ok(await call(String(m.params?.name), m.params?.arguments ?? {}, ctx));
    default:
      return rpcError(m.id, -32601, `method not found: ${m.method}`);
  }
}

async function call(name: string, args: Record<string, unknown>, ctx: McpContext) {
  if (!TOOLS.some((t) => t.name === name)) return text(`unknown tool ${name}`, true);
  if (!ctx.self) return text('Agent Worlds does not know this session yet; try again in a moment.', true);
  if (name === 'aw_agents') {
    const peers = ctx.peers();
    return text(peers.length ? JSON.stringify(peers, null, 1) : 'No other sessions are running.');
  }
  if (name === 'aw_inbox') return text(ctx.inbox());
  if (name === 'aw_handoff') {
    if (typeof args.summary !== 'string' || args.summary.length > 10000) return text('aw_handoff needs a `summary` (up to 10000 characters)', true);
    const r = await ctx.handoff(args.summary);
    return r instanceof Error ? text(r.message, true) : text(r);
  }
  if (name === 'aw_spawn') {
    if (typeof args.folder !== 'string' || !args.folder || typeof args.task !== 'string' || !args.task.trim()) return text('aw_spawn needs a `folder` and a `task`', true);
    if (args.task.length > 10000) return text('task is limited to 10000 characters', true);
    if (args.agent !== undefined && typeof args.agent !== 'string') return text('agent must be an agent id', true);
    if (args.worktree !== undefined && typeof args.worktree !== 'boolean') return text('worktree must be true or false', true);
    const r = await ctx.spawn(args as SpawnArgs);
    return r instanceof Error ? text(r.message, true) : text(r);
  }
  if (name === 'aw_stop') {
    if (typeof args.session !== 'string' || !args.session) return text('aw_stop needs a `session`', true);
    const r = await ctx.stop(args.session);
    return r instanceof Error ? text(r.message, true) : text(r);
  }
  if (typeof args.to !== 'string' || !args.to || typeof args.text !== 'string' || !args.text.trim()) return text('aw_send needs `to` and `text`', true);
  if (args.text.length > 10000) return text('text is limited to 10000 characters', true);
  const r = ctx.send(args.to, args.text);
  return r instanceof Error ? text(r.message, true) : text(r);
}
