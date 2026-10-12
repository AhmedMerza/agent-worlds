import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type World = { id: string; name: string; color: string; repos: string[] };
export type Config = {
  port: number; host: string; listen: string[]; extraHosts: string[]; worlds: World[];
  userSettingsPath: string; claudeBin: string; contextLimit: number;
};

export const DEFAULTS: Config = {
  port: 4317, host: '127.0.0.1', listen: ['127.0.0.1'], extraHosts: [], worlds: [],
  userSettingsPath: join(homedir(), '.claude', 'settings.json'), claudeBin: 'claude', contextLimit: 1_000_000,
};

export function homeDir(): string {
  return process.env.AGENT_WORLDS_HOME || join(homedir(), '.config', 'agent-worlds');
}

const realOrSelf = (p: string) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/** Parse and validate a config object. Throws with a readable message on bad input. */
export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new Error('config must be a JSON object');
  const r = raw as Record<string, unknown>;
  const cfg: Config = { ...DEFAULTS, worlds: [], extraHosts: [] };
  const str = (k: string) => {
    if (r[k] === undefined) return undefined;
    if (typeof r[k] !== 'string' || !r[k]) throw new Error(`${k} must be a non-empty string`);
    return r[k] as string;
  };
  if (r.port !== undefined) {
    if (!Number.isInteger(r.port) || (r.port as number) < 1 || (r.port as number) > 65535) throw new Error('port must be an integer 1-65535');
    cfg.port = r.port as number;
  }
  cfg.host = str('host') ?? cfg.host;
  cfg.listen = [cfg.host];
  if (r.listen !== undefined) {
    if (!Array.isArray(r.listen) || !r.listen.length || r.listen.some((h) => typeof h !== 'string' || !h)) throw new Error('listen must be a non-empty array of addresses');
    cfg.listen = r.listen as string[];
    cfg.host = cfg.listen[0];
  }
  const usp = str('userSettingsPath');
  if (usp) cfg.userSettingsPath = resolve(usp.replace(/^~(?=\/)/, homedir()));
  cfg.claudeBin = str('claudeBin') ?? cfg.claudeBin;
  if (r.contextLimit !== undefined) {
    if (!Number.isInteger(r.contextLimit) || (r.contextLimit as number) < 1000) throw new Error('contextLimit must be an integer >= 1000');
    cfg.contextLimit = r.contextLimit as number;
  }
  if (r.extraHosts !== undefined) {
    if (!Array.isArray(r.extraHosts) || r.extraHosts.some((h) => typeof h !== 'string')) throw new Error('extraHosts must be an array of strings');
    cfg.extraHosts = r.extraHosts as string[];
  }
  if (r.worlds !== undefined) {
    if (!Array.isArray(r.worlds)) throw new Error('worlds must be an array');
    const ids = new Set<string>();
    for (const w of r.worlds as Record<string, unknown>[]) {
      if (!w || typeof w.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(w.id)) throw new Error(`world id must match [a-z0-9-]: ${JSON.stringify(w?.id)}`);
      if (ids.has(w.id)) throw new Error(`duplicate world id: ${w.id}`);
      ids.add(w.id);
      if (!Array.isArray(w.repos) || w.repos.some((p) => typeof p !== 'string')) throw new Error(`world ${w.id}: repos must be an array of paths`);
      cfg.worlds.push({
        id: w.id,
        name: typeof w.name === 'string' ? w.name : w.id,
        color: typeof w.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(w.color) ? w.color : '#888888',
        repos: (w.repos as string[]).map(realOrSelf),
      });
    }
  }
  return cfg;
}

export function loadConfig(dir = homeDir()): Config {
  const file = join(dir, 'config.json');
  if (!existsSync(file)) return { ...DEFAULTS };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`${file}: invalid JSON (${(e as Error).message})`);
  }
  try { return parseConfig(raw); } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

/** Read the token, creating a random one (mode 0600) on first use. */
export function ensureToken(dir = homeDir()): string {
  const file = join(dir, 'token');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const t = randomBytes(32).toString('hex');
  writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

/** aw-hook reads this to find the server. */
export function writeEndpoint(cfg: Config, dir = homeDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const host = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  writeFileSync(join(dir, 'endpoint'), `http://${host.includes(':') ? `[${host}]` : host}:${cfg.port}\n`, { mode: 0o600 });
}

export const EXAMPLE_CONFIG = {
  port: 4317,
  host: '127.0.0.1',
  extraHosts: [],
  worlds: [
    { id: 'web', name: 'Web', color: '#47b4a7', repos: ['/path/to/repo-a', '/path/to/repo-b'] },
    { id: 'mobile', name: 'Mobile', color: '#e0a03a', repos: ['/path/to/repo-c'] },
    { id: 'tools', name: 'Tools', color: '#8a7bd8', repos: ['/path/to/repo-d'] },
  ],
};
