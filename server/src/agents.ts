import { existsSync, writeFileSync, mkdirSync, renameSync, readFileSync, readdirSync, symlinkSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GEMINI_EVENTS } from './gemini.ts';
import { MODEL_RE } from './providers.ts';
import { AGY_EVENTS, agyHooksDir } from './agy.ts';
import { hookCommand, hooksBlock, HOOK_EVENTS, HOLD_TIMEOUT, FAST_TIMEOUT, MCP_BRIDGE } from './hooks.ts';

/**
 * The agent CLIs a session can run. All of them report through the same aw-hook script with
 * Claude-shaped hook payloads (session_id, hook_event_name, tool_name, tool_input, ...), so the
 * store handles them alike (Gemini's and agy's are translated first, see gemini.ts and agy.ts); what differs is how the hooks get into each CLI and which features it has.
 * `decides`: Agent Worlds can answer PermissionRequest from the inbox.
 * `holds`: the CLI runs without prompts of its own, its tool hook held here instead: anything but an allow denies.
 * `task`: the CLI can be started with the task as its first prompt.
 */
export const AGENTS = {
  claude: { name: 'Claude Code', bin: 'claude', alwaysAllow: true, modes: true, decides: true, holds: false, task: true },
  // Return no decision from Codex's PermissionRequest hook so its own prompt stays usable.
  codex: { name: 'Codex', bin: 'codex', alwaysAllow: false, modes: false, decides: false, holds: false, task: true },
  // Qwen Code >= 0.13 copies Claude's hooks, reply format included, but drops a PermissionRequest hook after ~4 s
  // and only then draws its own prompt: answer at once so the prompt shows, and answer it in the terminal.
  qwen: { name: 'Qwen Code', bin: 'qwen', alwaysAllow: false, modes: false, decides: false, holds: false, task: true },
  // Kimi Code fires PermissionRequest without waiting for the hook, so its prompts are answered in the terminal.
  kimi: { name: 'Kimi Code', bin: 'kimi', alwaysAllow: false, modes: false, decides: false, holds: false, task: true },
  // Gemini CLI runs without prompts of its own: every tool it would ask about is held for you here (gemini.ts).
  gemini: { name: 'Gemini CLI', bin: 'gemini', alwaysAllow: false, modes: false, decides: true, holds: true, task: true },
  // Antigravity CLI too, held at its PreToolUse (agy.ts).
  agy: { name: 'Antigravity CLI', bin: 'agy', alwaysAllow: false, modes: false, decides: true, holds: true, task: true },
} as const;
export type AgentId = keyof typeof AGENTS;
export const isAgent = (a: unknown): a is AgentId => typeof a === 'string' && Object.hasOwn(AGENTS, a);

/**
 * The flag that picks a model, for the CLIs whose flag we know (Qwen's model comes from its provider). It goes in as
 * one `--model=<id>` argument: Gemini reads a separate value that starts with `-` as a flag of its own.
 */
export const MODEL_FLAG: Partial<Record<AgentId, string>> = { claude: '--model', codex: '--model', gemini: '--model' };
/** A model id a lead or the user may pick; never one starting with `-`, which a CLI could take for a flag. */
export const isModelId = (m: unknown): m is string => typeof m === 'string' && MODEL_RE.test(m) && !m.startsWith('-');

/**
 * Which agents (and models) leads may start with aw_spawn: agent id -> its allowed models, [] for any.
 * An agent not listed is off. Unset (null) means every agent, any model. Throws with a readable message.
 */
export type SpawnAgents = Partial<Record<AgentId, string[]>>;
export function parseSpawnAgents(raw: unknown): SpawnAgents {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('spawnAgents must be an object of agent id -> list of models');
  const out: SpawnAgents = {};
  for (const [id, models] of Object.entries(raw)) {
    if (!isAgent(id)) throw new Error(`spawnAgents: unknown agent ${id} (one of ${Object.keys(AGENTS).join(', ')})`);
    if (!Array.isArray(models) || models.some((m) => !isModelId(m))) throw new Error(`spawnAgents.${id} must be a list of model ids`);
    if (models.length && !MODEL_FLAG[id]) throw new Error(`spawnAgents.${id}: Agent Worlds cannot pick a model for ${AGENTS[id].name}, so its list must be empty`);
    out[id] = [...new Set(models as string[])];
  }
  return out;
}

/** Quote one string for POSIX sh. */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Whether `bin` is on PATH (or is an existing path). */
export function installed(bin: string, path = process.env.PATH ?? ''): boolean {
  if (bin.includes('/')) return existsSync(bin);
  return path.split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

/** The configured default when it is installed, else Claude. */
export function defaultAgent(configured: string | undefined, has = (a: AgentId) => installed(AGENTS[a].bin)): AgentId {
  return isAgent(configured) && has(configured) ? configured : 'claude';
}

/** The `aw` MCP server entry (bin/aw-mcp) in the mcpServers shape Claude, Qwen, Kimi and Gemini read. */
const mcpEntry = (agent: AgentId, bridge = MCP_BRIDGE) => ({ command: bridge, args: [agent] });

const CODEX_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];

/**
 * Argv and env (beyond AGENT_WORLDS_HOME) that start `agent` reporting to the server at `home`.
 * Codex takes its hooks as `-c` overrides and asks once, in the terminal, to trust them;
 * the command never changes, so it does not ask again. Qwen and Gemini read them from a system
 * settings file we point them at.
 */
export function launchArgs(agent: AgentId, o: { home?: string; resume?: string; permissionMode?: string; codexUnrestricted?: boolean; task: string; provider?: Provider; dir?: string; model?: string }): { args: string[]; env: Record<string, string> } {
  const task = o.task ? ['--', o.task] : [];
  const model = o.model && MODEL_FLAG[agent] ? [`${MODEL_FLAG[agent]}=${o.model}`] : [];
  if (agent === 'codex') {
    const access = ['--sandbox', o.codexUnrestricted ? 'danger-full-access' : 'workspace-write', '--ask-for-approval', 'on-request'];
    const cmd = JSON.stringify(hookCommand('codex'));
    const hooks = o.home ? CODEX_EVENTS.flatMap((ev) => ['-c', `hooks.${ev}=[{hooks=[{type="command",command=${cmd},timeout=${ev === 'PermissionRequest' ? HOLD_TIMEOUT : FAST_TIMEOUT}}]}]`]) : [];
    // Codex hands an MCP server only a few env vars unless told: the bridge needs the pane and our home.
    const mcp = o.home ? [`mcp_servers.aw.command=${JSON.stringify(MCP_BRIDGE)}`, 'mcp_servers.aw.args=["codex"]',
      'mcp_servers.aw.env_vars=["TMUX_PANE","AGENT_WORLDS_PTY","AGENT_WORLDS_HOME"]', 'mcp_servers.aw.default_tools_approval_mode="approve"'].flatMap((c) => ['-c', c]) : [];
    return { args: o.resume ? ['resume', ...access, ...hooks, ...mcp, o.resume] : [...access, ...hooks, ...mcp, ...model, ...task], env: {} };
  }
  if (agent === 'kimi') {
    // Kimi takes no starting prompt (and drops keys typed before it draws): createSession turns the
    // task into a `kimi -p` + `kimi -c` chain; here the task only names the session.
    // KIMI_CODE_TRUST_WORKSPACE skips its trust prompt: trust is per folder and remembered, but every
    // worktree session is a fresh folder, so the prompt would block the -p run before anything starts.
    return { args: o.resume ? ['--session', o.resume] : [], env: { KIMI_CODE_TRUST_WORKSPACE: 'true', ...(o.home ? { KIMI_CODE_HOME: writeKimiHome(o.home) } : {}) } };
  }
  if (agent === 'qwen') {
    // `-i` runs the task and stays interactive (a bare prompt would run once and exit).
    return { args: o.resume ? ['--resume', o.resume] : o.task ? ['-i', o.task] : [], env: o.home ? { QWEN_CODE_SYSTEM_SETTINGS_PATH: writeQwenSettings(o.home, o.provider) } : {} };
  }
  if (agent === 'gemini') {
    // yolo only where our hooks are then the one gate on its tools: with them installed, and in a folder with no
    // .gemini/settings.json of its own, which outranks ours and could switch hooks off. Elsewhere Gemini asks
    // first in its terminal, then the hook holds as well. Gemini also refuses yolo (and skips all hooks) in a
    // folder you haven't trusted, so there its own prompt is the gate.
    const task = o.task ? ['-i', o.task] : [];
    if (!o.home) return { args: task, env: {} };
    const yolo = o.dir !== undefined && !existsSync(join(o.dir, '.gemini', 'settings.json'));
    const g = writeGeminiHome(o.home);
    // Gemini saves trust by rename, which would replace our link with a copy: it writes the user's file itself.
    return { args: [...(yolo ? ['--approval-mode', 'yolo'] : []), ...model, ...(o.resume ? ['--resume', o.resume] : task)], env: { GEMINI_CLI_HOME: g.root, GEMINI_CLI_TRUSTED_FOLDERS_PATH: join(g.real, 'trustedFolders.json') } };
  }
  if (agent === 'agy') {
    // `-i` runs the task and stays interactive, like Qwen's. AGENT_WORLDS_DIR names the project to its hooks:
    // agy leaves a folder it has not been told to trust out of its workspace until it asks.
    // No prompts of its own only where our hooks are then the one gate on its tools: any .agents/hooks.json in the
    // project or a folder above it (ours too) is read alongside ours and can switch them off by name. Elsewhere agy's
    // own prompt gates its tools as well as the hook.
    const task = o.task ? ['-i', o.task] : [];
    if (!o.home) return { args: task, env: {} };
    const dir = writeAgyHooks(o.home);
    const yolo = o.dir !== undefined && !agyHooksAbove(o.dir) && !agyHooksAbove(dirname(dir));
    return { args: [...(yolo ? ['--dangerously-skip-permissions'] : []), '--add-dir', dir, ...(o.resume ? ['--conversation', o.resume] : task)], env: o.dir ? { AGENT_WORLDS_DIR: o.dir } : {} };
  }
  const settings = o.home ? ['--settings', join(o.home, 'hooks.json'), '--mcp-config', join(o.home, 'claude-mcp.json')] : [];
  const resume = o.resume ? ['--resume', o.resume] : [];
  const mode = o.permissionMode ? ['--permission-mode', o.permissionMode] : [];
  return { args: [...resume, ...mode, ...model, ...settings, ...task], env: {} };
}

const KIMI_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
  'Stop', 'StopFailure', 'Interrupt', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact', 'SessionEnd'];

/**
 * Fills `dir` with links to everything in the CLI's real home folder but `except` (the files we write ourselves),
 * and returns the names found there. Some files get saved by rename (Kimi's workspaces.json), which turns our
 * link into a private copy: it is linked again on the next start.
 */
function linkHome(real: string, dir: string, except: string[]): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const names = existsSync(real) ? readdirSync(real) : [];
  for (const n of names) {
    if (except.includes(n)) continue;
    const link = join(dir, n), target = join(real, n);
    const st = lstatSync(link, { throwIfNoEntry: false });
    if (st?.isSymbolicLink() && readlinkSync(link) === target) continue;
    if (st && !st.isFile() && !st.isSymbolicLink()) continue; // a folder the CLI made here: never deleted
    if (st) rmSync(link);
    symlinkSync(target, link);
  }
  return names;
}

/**
 * Kimi reads hooks only from <KIMI_CODE_HOME>/config.toml, so its sessions get a home of their own:
 * links to everything in the user's (login, sessions, MCP, trust) next to a copy of their config.toml
 * with our [[hooks]] appended. Rewritten on every start, so config changes reach the next session.
 * Kimi caps hook timeouts at 600 s and its PermissionRequest is not held, so every hook is quick.
 */
export function writeKimiHome(home: string, real = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')): string {
  const dir = join(home, 'kimi-home');
  const names = linkHome(real, dir, ['config.toml', 'mcp.json']);
  const mine = names.includes('config.toml') ? readFileSync(join(real, 'config.toml'), 'utf8') : '';
  const command = JSON.stringify(hookCommand('kimi')); // a JSON string is a valid TOML basic string
  const hooks = KIMI_EVENTS.map((ev) => `[[hooks]]\nevent = "${ev}"\ncommand = ${command}\ntimeout = ${FAST_TIMEOUT}\n`).join('\n');
  const file = join(dir, 'config.toml');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${mine}\n\n# Added by Agent Worlds for the sessions it starts\n${hooks}`, { mode: 0o600 });
  renameSync(tmp, file);
  // Their MCP servers plus ours
  let servers: Record<string, unknown> = {};
  try {
    const v = JSON.parse(readFileSync(join(real, 'mcp.json'), 'utf8')).mcpServers;
    if (v && typeof v === 'object' && !Array.isArray(v)) servers = v;
  } catch { /* none, or unreadable */ }
  rmSync(join(dir, 'mcp.json'), { force: true }); // a link to theirs, from before Agent Worlds wrote its own
  writeSettings(dir, 'mcp.json', { mcpServers: { ...servers, aw: mcpEntry('kimi') } });
  return dir;
}

/** Writes `data` to <home>/<name> (0600, by rename so a starting CLI never reads half a file). */
function writeSettings(home: string, name: string, data: unknown): string {
  const file = join(home, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** A model provider for one Qwen session, resolved from providers.ts, with its key. */
export type Provider = { id: string; auth: string; baseUrl?: string; model: string; key: string };

/**
 * Qwen's system settings layer wins over ~/.qwen, so a provider picked for a session goes there and the
 * user's own settings are never touched. The key reaches Qwen through the file's env block under a name of
 * our own, so an OPENAI_API_KEY in the user's shell or a .env file cannot shadow it, and it never shows in argv.
 * One file per provider and model: sessions starting at once with the same choice write the same bytes.
 */
function writeQwenSettings(home: string, provider?: Provider): string {
  // trust: Qwen calls the mailbox tools without asking
  const base = { ...hooksBlock(undefined, 'qwen', HOOK_EVENTS), mcpServers: { aw: { ...mcpEntry('qwen'), trust: true } } };
  if (!provider) return writeSettings(home, 'qwen-settings.json', base);
  const name = `qwen-${provider.id}-${createHash('sha1').update(provider.model).digest('hex').slice(0, 10)}.json`;
  return writeSettings(home, name, {
    ...base,
    security: { auth: { selectedType: provider.auth } },
    model: { name: provider.model },
    modelProviders: { [provider.auth]: [{ id: provider.model, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), envKey: 'AGENT_WORLDS_PROVIDER_KEY' }] },
    env: { AGENT_WORLDS_PROVIDER_KEY: provider.key },
  });
}

/**
 * Gemini reads settings from <GEMINI_CLI_HOME>/.gemini (a system settings file only counts when root owns its
 * folder, since 0.64). So its sessions get a home of their own, like Kimi's: links to everything in the user's
 * ~/.gemini (login, history, extensions, trusted folders) next to a settings.json that is theirs plus our hooks
 * and mailbox, with hooks forced on. Rewritten on every start. Hook timeouts are in milliseconds.
 */
export function writeGeminiHome(home: string, real = join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini')): { root: string; real: string } {
  const root = join(home, 'gemini-home'), dir = join(root, '.gemini');
  // Started from inside one of these sessions, GEMINI_CLI_HOME is ours: linking it onto itself would lose the login.
  if (resolve(real) === resolve(dir)) real = join(homedir(), '.gemini');
  linkHome(real, dir, ['settings.json']);
  const read = (f: string): Record<string, any> => {
    try {
      const v = JSON.parse(readFileSync(f, 'utf8'));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch { return {}; } // none, or unreadable
  };
  const mine = read(join(real, 'settings.json'));
  // Gemini saves the sign-in choice into this copy: keep it, or it asks again every session.
  const auth = mine.security?.auth?.selectedType ?? read(join(dir, 'settings.json')).security?.auth?.selectedType;
  const command = hookCommand('gemini');
  const hooks: Record<string, unknown[]> = { ...mine.hooks };
  for (const ev of GEMINI_EVENTS) {
    const theirs = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    hooks[ev] = [...theirs, { hooks: [{ type: 'command', command, timeout: (ev === 'BeforeTool' ? HOLD_TIMEOUT : FAST_TIMEOUT) * 1000 }] }];
  }
  writeSettings(dir, 'settings.json', {
    ...mine, hooks,
    hooksConfig: { ...mine.hooksConfig, enabled: true, disabled: [] },
    ...(auth ? { security: { ...mine.security, auth: { ...mine.security?.auth, selectedType: auth } } } : {}),
    mcpServers: { ...mine.mcpServers, aw: { ...mcpEntry('gemini'), trust: true } },
  });
  return { root, real };
}

/**
 * agy reads hooks from `.agents/hooks.json` in a workspace folder (or the user's ~/.gemini/config), so its
 * sessions get <home>/agy-hooks added as one, with our hooks in it. The hook payloads do not name their
 * event, so each hook command passes it on to aw-hook. Its timeouts are in seconds.
 */
export function writeAgyHooks(home: string): string {
  const dir = agyHooksDir(home);
  const command = (ev: string) => ({ type: 'command', command: `${hookCommand('agy')} ${ev}`, timeout: ev === 'PreToolUse' ? HOLD_TIMEOUT : FAST_TIMEOUT });
  // Tool events take a group with a matcher, the others a plain list of handlers
  const aw = Object.fromEntries(AGY_EVENTS.map((ev) => [ev, ev.endsWith('ToolUse') ? [{ matcher: '*', hooks: [command(ev)] }] : [command(ev)]]));
  writeSettings(join(dir, '.agents'), 'hooks.json', { aw });
  return dir;
}

/** Whether `dir` or a folder above it has an `.agents/hooks.json`, which agy reads too. */
export function agyHooksAbove(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, '.agents', 'hooks.json'))) return true;
    if (d === dirname(d)) return false;
  }
}
