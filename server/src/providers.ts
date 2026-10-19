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
export type ProviderId = keyof typeof PROVIDERS;
export const isProvider = (p: unknown): p is ProviderId => typeof p === 'string' && Object.hasOwn(PROVIDERS, p);
export const KEY_RE = /^[\x21-\x7e]{8,500}$/;
export const MODEL_RE = /^[\w.\/:@+-]{1,200}$/;

/** <home>/keys.json (0600): API keys by provider. Never sent to a client or logged. */
export function readKeys(home: string): Partial<Record<ProviderId, string>> {
  try {
    const v = JSON.parse(readFileSync(join(home, 'keys.json'), 'utf8'));
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => isProvider(k) && typeof x === 'string'));
  } catch { return {}; }
}

/** Saves (or with null, forgets) a provider's key. The session settings files holding the old key go too. */
export function saveKey(home: string, id: ProviderId, key: string | null) {
  const keys = readKeys(home);
  if (key === null) delete keys[id]; else keys[id] = key;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'keys.json'), tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  for (const f of readdirSync(home)) if (f.startsWith(`qwen-${id}-`)) rmSync(join(home, f), { force: true });
}
