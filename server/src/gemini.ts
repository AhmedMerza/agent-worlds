import { TOOL_NAMES } from './mcp.ts';

/**
 * Gemini CLI's hooks have their own event names and reply format, so its payloads are turned into the
 * Claude-shaped ones the store reads, and the store's PermissionRequest replies back into Gemini's.
 *
 * Gemini's BeforeTool fires only after its own confirmation prompt, so no hook can answer that prompt.
 * Sessions therefore run with --approval-mode yolo (no prompt of its own), and a BeforeTool for any tool
 * Gemini would have asked about is held here as a PermissionRequest until you allow or deny it.
 */
const EVENTS: Record<string, string> = {
  SessionStart: 'SessionStart', BeforeAgent: 'UserPromptSubmit', BeforeTool: 'PreToolUse', AfterTool: 'PostToolUse',
  AfterAgent: 'Stop', SessionEnd: 'SessionEnd',
};
// No PreCompress: Gemini fires it on turns that compress nothing, which would show "Compacting…" for nothing.
export const GEMINI_EVENTS = Object.keys(EVENTS);

/** Built-in tools under the names the store knows them by, so risk, test and work-dir checks apply. */
const TOOLS: Record<string, string> = {
  run_shell_command: 'Bash', write_file: 'Write', replace: 'Edit', read_file: 'Read', read_many_files: 'Read',
  glob: 'Glob', grep_search: 'Grep', list_directory: 'LS', web_fetch: 'WebFetch', google_web_search: 'WebSearch',
};
/** What Gemini runs without asking in its default mode (its policies/read-only.toml), plus its own questions and our mailbox. */
const FREE = new Set(['glob', 'grep_search', 'list_directory', 'read_file', 'read_many_files', 'google_web_search', 'write_todos',
  'ask_user', 'exit_plan_mode', ...TOOL_NAMES.flatMap((t) => [`aw__${t}`, `mcp_aw_${t}`, `mcp__aw__${t}`])]);

/** The Claude-shaped payload for a Gemini hook payload; null for an event the store has no use for. */
export function fromGemini(p: Record<string, unknown>): Record<string, unknown> | null {
  const ev = EVENTS[p.hook_event_name as string];
  if (!ev) return null;
  const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
  const out: Record<string, unknown> = { ...p, hook_event_name: ev };
  if (tool) out.tool_name = TOOLS[tool] ?? tool;
  if (ev === 'PreToolUse' && !FREE.has(tool)) out.hook_event_name = 'PermissionRequest';
  if (ev === 'PostToolUse' && (p.tool_response as { error?: unknown } | undefined)?.error) out.hook_event_name = 'PostToolUseFailure';
  if (ev === 'Stop') out.last_assistant_message = p.prompt_response;
  return out;
}

/**
 * Gemini's answer to a held BeforeTool. Only an explicit allow lets the tool run (empty output = no objection):
 * a timeout, an Esc, a new prompt or the session ending all deny, since Gemini has no prompt of its own to fall back on.
 */
export function toGemini(out: string): string {
  let d: { behavior?: unknown; message?: unknown } = {};
  try { d = JSON.parse(out).hookSpecificOutput?.decision ?? {}; } catch { /* '' or '{}' */ }
  if (d.behavior === 'allow') return '';
  return JSON.stringify({ decision: 'deny', reason: typeof d.message === 'string' ? d.message : 'Not approved in Agent Worlds, so it did not run.' });
}
