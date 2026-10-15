import { existsSync, writeFileSync, mkdirSync, renameSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { hookCommand, hooksBlock, HOOK_EVENTS, HOLD_TIMEOUT, FAST_TIMEOUT } from './hooks.ts';

/**
 * The agent CLIs a session can run. All of them report through the same aw-hook script with
 * Claude-shaped hook payloads (session_id, hook_event_name, tool_name, tool_input, ...), so the
 * store handles them alike; what differs is how the hooks get into each CLI and which features it has.
 * `decides`: the CLI waits on its PermissionRequest hook, so Allow/Deny can be answered from here.
 */
export const AGENTS = {
  claude: { name: 'Claude Code', bin: 'claude', alwaysAllow: true, modes: true, decides: true },
  // Codex has no Notification, PostToolUseFailure or StopFailure, and its PermissionRequest takes
  // allow/deny only (no updatedPermissions), so "always allow" stays with Claude.
  codex: { name: 'Codex', bin: 'codex', alwaysAllow: false, modes: false, decides: true },
  // Qwen Code >= 0.13 copies Claude's hooks, reply format included.
  qwen: { name: 'Qwen Code', bin: 'qwen', alwaysAllow: false, modes: false, decides: true },
  // Kimi Code fires PermissionRequest without waiting for the hook, so its prompts are answered in the terminal.
  kimi: { name: 'Kimi Code', bin: 'kimi', alwaysAllow: false, modes: false, decides: false },
} as const;
export type AgentId = keyof typeof AGENTS;
export const isAgent = (a: unknown): a is AgentId => typeof a === 'string' && Object.hasOwn(AGENTS, a);

/** Whether `bin` is on PATH (or is an existing path). */
export function installed(bin: string, path = process.env.PATH ?? ''): boolean {
  if (bin.includes('/')) return existsSync(bin);
  return path.split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

/** The configured default when it is installed, else Claude. */
export function defaultAgent(configured: string | undefined, has = (a: AgentId) => installed(AGENTS[a].bin)): AgentId {
  return isAgent(configured) && has(configured) ? configured : 'claude';
}

const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];

/**
 * Argv and env (beyond AGENT_WORLDS_HOME) that start `agent` reporting to the server at `home`.
 * Codex takes its hooks as `-c` overrides and asks once, in the terminal, to trust them;
 * the command never changes, so it does not ask again. Qwen reads them from a system
 * settings file we point it at.
 */
export function launchArgs(agent: AgentId, o: { home?: string; resume?: string; permissionMode?: string; task: string }): { args: string[]; env: Record<string, string> } {
  const task = o.task ? ['--', o.task] : [];
  if (agent === 'codex') {
    const cmd = JSON.stringify(hookCommand('codex'));
    const hooks = o.home ? CODEX_EVENTS.flatMap((ev) => ['-c', `hooks.${ev}=[{hooks=[{type="command",command=${cmd},timeout=${ev === 'PermissionRequest' ? HOLD_TIMEOUT : FAST_TIMEOUT}}]}]`]) : [];
    return { args: [...hooks, ...task], env: {} };
  }
  if (agent === 'kimi') {
    // Kimi takes no starting prompt (and drops keys typed before it draws), so the task only names the session.
    return { args: [], env: o.home ? { KIMI_CODE_HOME: writeKimiHome(o.home) } : {} };
  }
  if (agent === 'qwen') {
    // `-i` runs the task and stays interactive (a bare prompt would run once and exit).
    return { args: o.task ? ['-i', o.task] : [], env: o.home ? { QWEN_CODE_SYSTEM_SETTINGS_PATH: writeQwenSettings(o.home) } : {} };
  }
  const settings = o.home ? ['--settings', join(o.home, 'hooks.json')] : [];
  const resume = o.resume ? ['--resume', o.resume] : [];
  const mode = o.permissionMode ? ['--permission-mode', o.permissionMode] : [];
  return { args: [...resume, ...mode, ...settings, ...task], env: {} };
}

const KIMI_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Stop', 'StopFailure', 'Interrupt', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];

/**
 * Kimi reads hooks only from <KIMI_CODE_HOME>/config.toml, so its sessions get a home of their own:
 * links to everything in the user's (login, sessions, MCP, trust) next to a copy of their config.toml
 * with our [[hooks]] appended. Rewritten on every start, so config changes reach the next session.
 * Kimi caps hook timeouts at 600 s and its PermissionRequest is not held, so every hook is quick.
 */
export function writeKimiHome(home: string, real = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')): string {
  const dir = join(home, 'kimi-home');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = existsSync(real) ? readdirSync(real) : [];
  for (const n of names) {
    if (n === 'config.toml') continue;
    try { symlinkSync(join(real, n), join(dir, n)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  }
  const mine = names.includes('config.toml') ? readFileSync(join(real, 'config.toml'), 'utf8') : '';
  const command = JSON.stringify(hookCommand('kimi')); // a JSON string is a valid TOML basic string
  const hooks = KIMI_EVENTS.map((ev) => `[[hooks]]\nevent = "${ev}"\ncommand = ${command}\ntimeout = ${FAST_TIMEOUT}\n`).join('\n');
  const file = join(dir, 'config.toml');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${mine}\n\n# Added by Agent Worlds for the sessions it starts\n${hooks}`, { mode: 0o600 });
  renameSync(tmp, file);
  return dir;
}

function writeQwenSettings(home: string): string {
  const file = join(home, 'qwen-settings.json');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(hooksBlock(undefined, 'qwen', HOOK_EVENTS), null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}
