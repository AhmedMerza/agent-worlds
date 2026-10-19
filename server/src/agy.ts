import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Antigravity CLI (agy) reads hooks from a `.agents/hooks.json` in any workspace folder, so its sessions get
 * <home>/agy-hooks as an extra one (--add-dir). Its payloads are camelCase and do not say which event they are
 * (aw-hook passes that on from the hook command), so they are turned into the Claude-shaped ones the store reads.
 *
 * Report only, like Kimi: a PreToolUse answering allow does not skip agy's own prompt, so its prompts are
 * answered in its terminal. agy takes any other non-empty reply to PreToolUse as a deny, even `{}`, so
 * nothing is ever answered to a tool event.
 *
 * agy sorts its workspace folders and treats the first as the project, which can be ours: SessionStart
 * answers with a system message naming the real one. That is the folder the session was started in (aw-hook
 * passes it on), since agy leaves a folder it has not been told to trust out of its workspace until it asks.
 */
export const AGY_EVENTS = ['SessionStart', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'Stop'];
export const agyHooksDir = (home: string) => join(home, 'agy-hooks');

/** Built-in tools under the names the store knows them by, with the argument it describes them by. */
const TOOLS: Record<string, [string, (a: Record<string, unknown>) => Record<string, unknown>]> = {
  run_command: ['Bash', (a) => ({ command: a.CommandLine, cwd: a.Cwd })],
  view_file: ['Read', (a) => ({ file_path: a.AbsolutePath })],
  write_to_file: ['Write', (a) => ({ file_path: a.TargetFile })],
  replace_file_content: ['Edit', (a) => ({ file_path: a.TargetFile })],
  multi_replace_file_content: ['Edit', (a) => ({ file_path: a.TargetFile })],
  list_dir: ['LS', (a) => ({ path: a.DirectoryPath })],
  grep_search: ['Grep', (a) => ({ pattern: a.Query, path: a.SearchPath })],
  find_by_name: ['Glob', (a) => ({ pattern: a.Pattern, path: a.SearchDirectory })],
  search_web: ['WebSearch', (a) => ({ query: a.query })],
  read_url_content: ['WebFetch', (a) => ({ url: a.Url })],
  // A helper, as Claude's Task tool is: the call returns at once and the subagents run on (see asHelper)
  invoke_subagent: ['Task', (a) => {
    const all = Array.isArray(a.Subagents) ? a.Subagents as { Role?: unknown; Prompt?: unknown }[] : [];
    return { description: all[0]?.Role ?? all[0]?.Prompt, subagents: Math.max(all.length, 1) };
  }],
};

/** agy's transcript at `path`, '' when unreadable. Only agy's own transcripts are read: the path comes in a hook payload. */
function readTranscript(path: unknown, root = join(homedir(), '.gemini', 'antigravity-cli')): string {
  if (typeof path !== 'string' || !resolve(path).startsWith(resolve(root) + '/')) return '';
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

/** Whether the transcript at `path` names conversation `id`: agy records each subagent it creates there (in its TUI, a while later). */
export const mentions = (path: unknown, id: string): boolean => readTranscript(path).includes(id);

/** The content of the last `type` step in agy's transcript ('' when there is none). */
export function lastStep(path: unknown, type: string): string {
  const lines = readTranscript(path).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const st = JSON.parse(lines[i]);
      if (st?.type === type && typeof st.content === 'string') return st.content;
    } catch { /* blank or partly written line */ }
  }
  return '';
}

/** The Claude-shaped payload for an agy hook payload; null for one the store has no use for. */
export function fromAgy(p: Record<string, unknown>, event: unknown, hooksDir: string, dir?: unknown): Record<string, unknown> | null {
  const ws = Array.isArray(p.workspacePaths) ? p.workspacePaths.filter((w): w is string => typeof w === 'string') : [];
  const base = {
    session_id: p.conversationId, transcript_path: p.transcriptPath,
    // Node reads header bytes as latin1; aw-hook sent the path as UTF-8
    cwd: typeof dir === 'string' && dir.startsWith('/') ? Buffer.from(dir, 'latin1').toString('utf8') : ws.find((w) => resolve(w) !== resolve(hooksDir)),
    ...(typeof p.modelName === 'string' && p.modelName !== 'auto' ? { model: p.modelName } : {}),
  };
  const call = (p.toolCall ?? {}) as { name?: unknown; args?: unknown };
  const name = typeof call.name === 'string' ? call.name : '';
  const args = (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>;
  const [tool, input] = TOOLS[name] ? [TOOLS[name][0], TOOLS[name][1](args)] : [name, args];
  switch (event) {
    case 'SessionStart': return { ...base, hook_event_name: 'SessionStart' };
    // Before every model call; the first of a turn is where a prompt was sent
    case 'PreInvocation': {
      if (p.invocationNum !== 0) return null;
      const prompt = lastStep(p.transcriptPath, 'USER_INPUT');
      return { ...base, hook_event_name: 'UserPromptSubmit', prompt: prompt.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/)?.[1] ?? prompt };
    }
    // The store finds a helper by its call's id: given on the call and, as it ends the helper, on a failed call only
    // (a call that worked returns while its subagents run on, and their Stop ends it)
    case 'PreToolUse': return { ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, ...(tool === 'Task' ? { tool_use_id: `${p.conversationId}:${p.stepIdx}` } : {}) };
    case 'PostToolUse': return {
      ...base, hook_event_name: p.error ? 'PostToolUseFailure' : 'PostToolUse', tool_name: tool, tool_input: input, error: p.error || undefined,
      ...(tool === 'Task' && p.error ? { tool_use_id: `${p.conversationId}:${p.stepIdx}` } : {}),
    };
    case 'Stop':
      if (p.terminationReason === 'USER_CANCELED') return { ...base, hook_event_name: 'Interrupt' };
      if (p.terminationReason === 'ERROR') return { ...base, hook_event_name: 'StopFailure', error: p.error || undefined };
      return { ...base, hook_event_name: 'Stop', last_assistant_message: lastStep(p.transcriptPath, 'PLANNER_RESPONSE') };
    default: return null;
  }
}

/**
 * A subagent's events, as its parent session's helper: agy runs each subagent as a conversation of its own, in the
 * same pane, which the store would otherwise take for a new conversation replacing the parent. Its prompt is the
 * parent's call, not yours, so it is dropped, and its transcript is not the parent's.
 */
export function asHelper(body: Record<string, unknown>, parent: string): Record<string, unknown> | null {
  const ev = body.hook_event_name;
  if (ev === 'UserPromptSubmit') return null;
  const helperEv = ev === 'SessionStart' ? 'SubagentStart' : ev === 'Stop' || ev === 'StopFailure' || ev === 'Interrupt' ? 'SubagentStop' : ev;
  const { transcript_path: _, ...rest } = body;
  return { ...rest, session_id: parent, agent_id: body.session_id, hook_event_name: helperEv };
}

/** agy's answer: the project note for SessionStart (a subagent's too), nothing for anything else (see above). */
export function toAgy(event: unknown, cwd: unknown, hooksDir: string): string {
  if (event !== 'SessionStart' || typeof cwd !== 'string') return '';
  const systemMessage = `The project you are working on is ${cwd}: run commands and edit files there. The workspace folder ${hooksDir} belongs to Agent Worlds, which watches this session: never read, edit or run commands in it.`;
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage } }] });
}
