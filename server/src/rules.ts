import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

type Input = Record<string, unknown>;

const RISKS: [RegExp, string][] = [
  [/\brm\s+(-{1,2}[\w-]+\s+)*(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(\s|$)/, 'deletes files recursively'],
  [/\bgit\s+push\b/, 'pushes to a remote'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|restore\b)/, 'discards local changes'],
  [/\b(artisan\s+)?(migrate(:[\w-]+)?|db:(wipe|seed))\b|\bsetup:upgrade\b|\bprisma\s+(migrate|db\s+push)\b|\b(drop|truncate)\s+(table|database|schema)\b/i, 'changes a database'],
  [/\bdeploy\b/i, 'runs a deploy'],
  [/\bsudo\b/, 'runs as root'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, 'pipes a download into a shell'],
  [/\b(mkfs|dd\s+if=)|>\s*\/dev\/sd/, 'writes to a disk device'],
  [/\bchmod\s+(-R\s+)?777\b/, 'makes files world-writable'],
];
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** A short reason when a request deserves a second look, else null. `root` is the session's project directory. */
export function riskOf(tool: string, input: Input, root?: string): string | null {
  if (tool === 'Bash' && typeof input.command === 'string') {
    for (const [re, why] of RISKS) if (re.test(input.command)) return why;
  }
  const path = input.file_path ?? input.notebook_path;
  if (root && WRITE_TOOLS.has(tool) && typeof path === 'string') {
    const abs = resolve(root, path);
    if (abs !== root && !abs.startsWith(root.endsWith('/') ? root : root + '/')) return 'writes outside the project';
  }
  return null;
}

type Suggestion = { type?: string; behavior?: string; rules?: { toolName?: string; ruleContent?: string }[] };
export type Rule = { toolName: string; ruleContent?: string };

/** The permission rule for this request: Claude's own suggestion when it made one, else an exact rule. */
export function ruleFor(tool: string, input: Input, suggestions: unknown): Rule {
  if (Array.isArray(suggestions)) {
    for (const s of suggestions as Suggestion[]) {
      const r = s?.type === 'addRules' && s.behavior === 'allow' ? s.rules?.[0] : undefined;
      if (r && typeof r.toolName === 'string') return typeof r.ruleContent === 'string' ? { toolName: r.toolName, ruleContent: r.ruleContent } : { toolName: r.toolName };
    }
  }
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  if (tool === 'Bash' && str('command')) return { toolName: 'Bash', ruleContent: str('command')! };
  const file = str('file_path') ?? str('notebook_path');
  // A leading "//" is an absolute path in rule syntax; "/x" would be relative to the settings file.
  if (file && file.startsWith('/')) return { toolName: WRITE_TOOLS.has(tool) ? 'Edit' : tool, ruleContent: '/' + file };
  if (tool === 'WebFetch' && str('url')) {
    try { return { toolName: 'WebFetch', ruleContent: 'domain:' + new URL(str('url')!).hostname }; } catch { /* fall through */ }
  }
  return { toolName: tool };
}

/** Why `rule` may not be saved to user-global settings, else null. A shell command can be reworded to slip past
 * riskOf, and a bare tool name allows every use of that tool, so neither goes "everywhere"; repo and world still can. */
export function whyNotEverywhere(rule: Rule, risky: string | null): string | null {
  if (risky) return `Not offered: this command ${risky}.`;
  if (rule.toolName === 'Bash') return 'Not offered for shell commands.';
  if (rule.ruleContent === undefined) return 'Not offered: it would allow every use of this tool.';
  return null;
}

export const ruleText = (r: Rule) => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`);

/** Add `rule` to permissions.allow of a settings file, keeping everything else. Atomic; refuses to touch invalid JSON. */
function allowSettings(file: string): { data: Record<string, unknown>; perms: Record<string, unknown>; allow: unknown[] } {
  let data: Record<string, unknown> = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim()) {
      try { data = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON; not changing it`); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} is not a JSON object; not changing it`);
    }
  }
  const perms = (data.permissions ?? {}) as Record<string, unknown>;
  if (typeof perms !== 'object' || Array.isArray(perms)) throw new Error(`${file}: "permissions" is not an object`);
  const allow = perms.allow ?? [];
  if (!Array.isArray(allow)) throw new Error(`${file}: "permissions.allow" is not an array`);
  return { data, perms, allow };
}

function writeSettings(file: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${randomBytes(4).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, file);
}

export function allowRules(file: string): string[] {
  return allowSettings(file).allow.filter((rule): rule is string => typeof rule === 'string');
}

export function addAllowRule(file: string, rule: string): void {
  const { data, perms, allow } = allowSettings(file);
  if (allow.includes(rule)) return;
  data.permissions = { ...perms, allow: [...allow, rule] };
  writeSettings(file, data);
}

/** Remove exactly one saved allowance, leaving other settings and other rules untouched. */
export function removeAllowRule(file: string, rule: string): boolean {
  if (!existsSync(file)) return false;
  const { data, perms, allow } = allowSettings(file);
  if (!allow.includes(rule)) return false;
  data.permissions = { ...perms, allow: allow.filter((item) => item !== rule) };
  writeSettings(file, data);
  return true;
}

/** How often each rule was allowed per repo, persisted in <home>/stats.json. */
export class Stats {
  file: string;
  data: Record<string, Record<string, number>> = {};
  constructor(file: string) {
    this.file = file;
    try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }
  get(repo: string, rule: string): number { return this.data[repo]?.[rule] ?? 0; }
  inc(repo: string, rule: string): number {
    const n = this.get(repo, rule) + 1;
    (this.data[repo] ??= {})[rule] = n;
    this.save();
    return n;
  }
  /** Keep world targets discoverable after a repo leaves the world or its session ends. */
  rememberRepos(repos: string[]): void {
    for (const repo of repos) this.data[repo] ??= {};
    this.save();
  }
  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (e) { console.error('[agent-worlds] cannot save stats', (e as Error).message); }
  }
}
