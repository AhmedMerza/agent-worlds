import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../bin/aw-hook');

/** Hook timeouts (seconds). PermissionRequest is held by the server for up to HOLD_MS (3540 s), so its hook gets 3600 s. */
const HOLD_TIMEOUT = 3600;
const FAST_TIMEOUT = 10;
export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];

export function hooksBlock(hookPath = HOOK) {
  const command = /^[\w./-]+$/.test(hookPath) ? hookPath : `'${hookPath.replace(/'/g, `'\\''`)}'`;
  const hooks: Record<string, unknown> = {};
  for (const ev of HOOK_EVENTS) {
    hooks[ev] = [{ hooks: [{ type: 'command', command, timeout: ev === 'PermissionRequest' ? HOLD_TIMEOUT : FAST_TIMEOUT }] }];
  }
  return { hooks };
}


/**
 * <home>/hooks.json: the same block, for sessions Agent Worlds starts itself
 * (`claude --settings <home>/hooks.json`), so they report even without a global install.
 * Claude runs identical hook commands from several settings files only once, so a user who
 * also installed the block globally is not reported twice.
 */
export function writeHooksFile(home: string): string {
  const file = join(home, 'hooks.json');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(hooksBlock(), null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}
