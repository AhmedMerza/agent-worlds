import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../bin/aw-hook');
/** The stdio MCP server sessions message each other through (see bin/aw-mcp). */
/** The mailbox's tool names (see mcp.ts). */
export const MAILBOX_TOOLS = ['aw_agents', 'aw_send', 'aw_inbox'];
export const MCP_BRIDGE = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../bin/aw-mcp');

/** Hook timeouts (seconds). PermissionRequest is held by the server for up to HOLD_MS (3540 s), so its hook gets 3600 s. */
export const HOLD_TIMEOUT = 3600;
export const FAST_TIMEOUT = 10;
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];

/** The hook command line; a non-Claude agent is named after the script so the server knows who reports. */
export function hookCommand(agent?: string, hookPath = HOOK) {
  const cmd = /^[\w./-]+$/.test(hookPath) ? hookPath : `'${hookPath.replace(/'/g, `'\\''`)}'`;
  return agent ? `${cmd} ${agent}` : cmd;
}

export function hooksBlock(hookPath = HOOK, agent?: string, events: readonly string[] = HOOK_EVENTS) {
  const command = hookCommand(agent, hookPath);
  const hooks: Record<string, unknown> = {};
  for (const ev of events) {
    hooks[ev] = [{ hooks: [{ type: 'command', command, timeout: ev === 'PermissionRequest' ? HOLD_TIMEOUT : FAST_TIMEOUT }] }];
  }
  return { hooks };
}


/**
 * <home>/hooks.json: the same block, for sessions Agent Worlds starts itself
 * (`claude --settings <home>/hooks.json`), so they report even without a global install.
 * Next to it, <home>/claude-mcp.json (`--mcp-config`) gives them the mailbox (bin/aw-mcp).
 * Claude runs identical hook commands from several settings files only once, so a user who
 * also installed the block globally is not reported twice.
 */
export function writeHooksFile(home: string): string {
  const file = join(home, 'hooks.json');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  // The mailbox tools run without asking: they only talk to this server. Named one by one, so another MCP server
  // called "aw" (a repo's .mcp.json) gets no free pass.
  writeFileSync(tmp, JSON.stringify({ ...hooksBlock(), permissions: { allow: MAILBOX_TOOLS.map((t) => `mcp__aw__${t}`) } }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  const mcp = join(home, 'claude-mcp.json');
  writeFileSync(tmp, JSON.stringify({ mcpServers: { aw: { command: MCP_BRIDGE, args: ['claude'] } } }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, mcp);
  return file;
}
