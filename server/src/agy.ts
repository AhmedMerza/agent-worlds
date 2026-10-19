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
};

/**
 * The content of the last `type` step in agy's transcript ('' when there is none). Only agy's own transcripts
 * are read: the path comes in a hook payload.
 */
export function lastStep(path: unknown, type: string, root = join(homedir(), '.gemini', 'antigravity-cli')): string {
  if (typeof path !== 'string' || !resolve(path).startsWith(resolve(root) + '/')) return '';
  let lines: string[];
  try { lines = readFileSync(path, 'utf8').split('\n'); } catch { return ''; }
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
    cwd: typeof dir === 'string' && dir.startsWith('/') ? dir : ws.find((w) => resolve(w) !== resolve(hooksDir)),
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
    case 'PreToolUse': return { ...base, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input };
    case 'PostToolUse': return { ...base, hook_event_name: p.error ? 'PostToolUseFailure' : 'PostToolUse', tool_name: tool, tool_input: input, error: p.error || undefined };
    case 'Stop':
      if (p.terminationReason === 'USER_CANCELED') return { ...base, hook_event_name: 'Interrupt' };
      if (p.terminationReason === 'ERROR') return { ...base, hook_event_name: 'StopFailure', error: p.error || undefined };
      return { ...base, hook_event_name: 'Stop', last_assistant_message: lastStep(p.transcriptPath, 'PLANNER_RESPONSE') };
    default: return null;
  }
}

/** agy's answer: the project note for SessionStart, nothing for anything else (see above). */
export function toAgy(body: Record<string, unknown>, hooksDir: string): string {
  if (body.hook_event_name !== 'SessionStart' || typeof body.cwd !== 'string') return '';
  const systemMessage = `The project you are working on is ${body.cwd}: run commands and edit files there. The workspace folder ${hooksDir} belongs to Agent Worlds, which watches this session: never read, edit or run commands in it.`;
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage } }] });
}
