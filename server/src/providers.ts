import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Model providers a Qwen Code session can use instead of whatever the user set up in ~/.qwen.
 * `auth` is Qwen's auth type; `model` is the default when none is given.
 */
export const PROVIDERS = {
  openrouter: { name: 'OpenRouter', auth: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', keyUrl: 'https://openrouter.ai/keys' },
  gemini: { name: 'Gemini API', auth: 'gemini', baseUrl: undefined, model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  anthropic: { name: 'Anthropic', auth: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
} as const;
export type ProviderInfo = { name: string; auth: string; baseUrl?: string; model: string; keyUrl?: string; custom?: true };
export const KEY_RE = /^[\x21-\x7e]{8,500}$/;
export const MODEL_RE = /^[\w.\/:@+-]{1,200}$/;
export const PROVIDER_ID_RE = /^[a-z0-9-]{1,40}$/;

/** Writes `data` to <home>/<name> (0600, by rename so a reader never sees half a file). */
function writeJson(home: string, name: string, data: unknown) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, name), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}
const readJson = (home: string, name: string): Record<string, unknown> => {
  try { const v = JSON.parse(readFileSync(join(home, name), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/**
 * <home>/servers.json: OpenAI-compatible servers the user added (a friend's llama.cpp, vLLM, LM Studio...),
 * by id. Each one is a provider like the built-in ones; its key, if it needs one, goes in keys.json.
 */
export function readServers(home: string): Record<string, { name: string; baseUrl: string; model: string }> {
  return Object.fromEntries(Object.entries(readJson(home, 'servers.json')).filter(([id, s]: [string, any]) =>
    PROVIDER_ID_RE.test(id) && !Object.hasOwn(PROVIDERS, id) && typeof s?.name === 'string' && typeof s.baseUrl === 'string' && typeof s.model === 'string')) as any;
}

/** The built-in providers plus the user's servers. */
export function allProviders(home: string): Record<string, ProviderInfo> {
  const servers = Object.entries(readServers(home)).map(([id, s]) => [id, { ...s, auth: 'openai', custom: true as const }]);
  return { ...PROVIDERS, ...Object.fromEntries(servers) };
}

/** A server's address as Qwen wants it (no trailing slash), or null unless it is a plain http(s) URL. */
export function serverUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return null;
    return u.href.replace(/\/+$/, '');
  } catch { return null; }
}

/** Saves a server under an id made from its name (the same name replaces it) and returns the id, or null if no id can be made. */
export function saveServer(home: string, s: { name: string; baseUrl: string; model: string }): string | null {
  const id = s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!PROVIDER_ID_RE.test(id) || Object.hasOwn(PROVIDERS, id)) return null;
  const servers = readServers(home);
  if (servers[id]) dropSettings(home, id); // a new address or model: the old session settings files are stale
  writeJson(home, 'servers.json', { ...servers, [id]: s });
  return id;
}

/** Forgets a server and its key. */
export function removeServer(home: string, id: string) {
  const { [id]: _, ...rest } = readServers(home);
  writeJson(home, 'servers.json', rest);
  saveKey(home, id, null);
}

/** <home>/keys.json (0600): API keys by provider. Never sent to a client or logged. */
export function readKeys(home: string): Record<string, string> {
  return Object.fromEntries(Object.entries(readJson(home, 'keys.json')).filter(([k, x]) => PROVIDER_ID_RE.test(k) && typeof x === 'string')) as Record<string, string>;
}

/** Saves (or with null, forgets) a provider's key. The session settings files holding the old key go too. */
export function saveKey(home: string, id: string, key: string | null) {
  const keys = readKeys(home);
  if (key === null) delete keys[id]; else keys[id] = key;
  writeJson(home, 'keys.json', keys);
  dropSettings(home, id);
}

/** Removes a provider's session settings files (qwen-<id>-<hash>.json, see agents.ts); not those of an id it is a prefix of. */
function dropSettings(home: string, id: string) {
  for (const f of readdirSync(home)) if (f.startsWith(`qwen-${id}-`) && /^[0-9a-f]{10}\.json$/.test(f.slice(`qwen-${id}-`.length))) rmSync(join(home, f), { force: true });
}
