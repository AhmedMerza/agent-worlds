import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The login password for use away from this computer. Only an scrypt hash is stored (mode 0600). */
export class Password {
  private file: string;
  constructor(file: string) { this.file = file; }
  isSet(): boolean { return existsSync(this.file); }
  set(pw: string): void {
    const salt = randomBytes(16);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file, JSON.stringify({ salt: salt.toString('hex'), hash: scryptSync(pw, salt, 32).toString('hex') }) + '\n', { mode: 0o600 });
  }
  clear(): void { rmSync(this.file, { force: true }); }
  check(pw: string): boolean {
    try {
      const { salt, hash } = JSON.parse(readFileSync(this.file, 'utf8'));
      return timingSafeEqual(scryptSync(pw, Buffer.from(salt, 'hex'), 32), Buffer.from(hash, 'hex'));
    } catch { return false; }
  }
}

/**
 * Wrong-password brake for a login page that may be on the public internet. It counts failures for everyone
 * together (a tunnel hides the caller's address): 5 within 15 minutes locks logins for 15 minutes.
 */
export class LoginLimiter {
  private fails: number[] = [];
  private lockedUntil = 0;
  private now: () => number;
  constructor(now = Date.now) { this.now = now; }
  /** Milliseconds until logins open again, 0 when open. */
  locked(): number { return Math.max(0, this.lockedUntil - this.now()); }
  fail(): void {
    const t = this.now();
    this.fails = [...this.fails.filter((x) => t - x < 15 * 60_000), t];
    if (this.fails.length >= 5) { this.lockedUntil = t + 15 * 60_000; this.fails = []; }
  }
  ok(): void { this.fails = []; }
}

/** cloudflared on PATH or in ~/.local/bin, else null. */
export function findCloudflared(): string | null {
  for (const dir of [...(process.env.PATH ?? '').split(':'), join(homedir(), '.local', 'bin')]) {
    if (dir && existsSync(join(dir, 'cloudflared'))) return join(dir, 'cloudflared');
  }
  return null;
}

/** A Cloudflare quick tunnel (https://….trycloudflare.com) to this server. No account; the address changes each start. */
export class Tunnel {
  url: string | null = null;
  private child: ChildProcess | null = null;
  async start(bin: string, port: number, timeoutMs = 30_000): Promise<string> {
    if (this.url) return this.url;
    this.stop();
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.on('exit', () => { if (this.child === child) { this.child = null; this.url = null; } });
    return new Promise((ok, fail) => {
      let seen = '';
      const timer = setTimeout(() => { this.stop(); fail(new Error('cloudflared gave no address within 30 s')); }, timeoutMs);
      const read = (b: Buffer) => {
        seen = (seen + b.toString()).slice(-8192);
        const m = seen.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) { clearTimeout(timer); this.url = m[0]; ok(m[0]); }
      };
      child.stdout!.on('data', read);
      child.stderr!.on('data', read);
      child.once('error', (e) => { clearTimeout(timer); this.child = null; fail(e); });
      child.once('exit', (code) => { if (!this.url) { clearTimeout(timer); fail(new Error(`cloudflared exited (${code})`)); } });
    });
  }
  stop(): void { this.child?.kill(); this.child = null; this.url = null; }
  host(): string | null { return this.url ? new URL(this.url).host : null; }
}

export type AccessEntry = { at: number; device: string | null; ip: string; route: 'public link' | 'network' | 'this computer'; via: string; ok: boolean; agent: string };

/** Who signed in (or tried), from where and how; plus each device's last visit. Kept in <home>/access.json, newest 500. */
export class AccessLog {
  private file: string;
  entries: AccessEntry[] = [];
  seen: Record<string, number> = {};
  private dirty: NodeJS.Timeout | null = null;
  constructor(file: string) {
    this.file = file;
    try { const d = JSON.parse(readFileSync(file, 'utf8')); this.entries = d.entries ?? []; this.seen = d.seen ?? {}; } catch { /* first run */ }
  }
  add(e: AccessEntry): void {
    this.entries = [e, ...this.entries].slice(0, 500);
    if (e.ok && e.device) this.seen[e.device] = e.at;
    this.save(true);
  }
  /** A signed-in device made a request; saved at most once a minute. */
  touch(device: string, at = Date.now()): void {
    if (at - (this.seen[device] ?? 0) < 60_000) return;
    this.seen[device] = at;
    this.save(false);
  }
  private save(now: boolean): void {
    const write = () => {
      this.dirty = null;
      try {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        writeFileSync(this.file, JSON.stringify({ entries: this.entries, seen: this.seen }) + '\n', { mode: 0o600 });
      } catch (e) { console.error('[agent-worlds] cannot save access log', (e as Error).message); }
    };
    if (now) { if (this.dirty) clearTimeout(this.dirty); write(); }
    else this.dirty ??= setTimeout(write, 5_000).unref();
  }
  /** One row per device that signed in: first and last time, last address and how it got in. */
  devices(): { device: string; first: number; last: number; ip: string; route: string; via: string; agent: string }[] {
    const by = new Map<string, { device: string; first: number; last: number; ip: string; route: string; via: string; agent: string }>();
    for (const e of [...this.entries].reverse()) {
      if (!e.ok || !e.device) continue;
      const d = by.get(e.device);
      by.set(e.device, { device: e.device, first: d?.first ?? e.at, last: Math.max(this.seen[e.device] ?? 0, e.at), ip: e.ip, route: e.route, via: e.via, agent: e.agent });
    }
    return [...by.values()].sort((a, b) => b.last - a.last);
  }
}

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
/** The official release file for this system, or null when there is none to install automatically. */
export function cloudflaredAsset(platform = process.platform, arch = process.arch): string | null {
  const a = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!a) return null;
  if (platform === 'linux') return `cloudflared-linux-${a}`;
  if (platform === 'darwin') return `cloudflared-darwin-${a}.tgz`;
  return null;
}

/** Download cloudflared from Cloudflare's GitHub releases into `dir` (no admin rights), check it runs, return its path. */
export async function installCloudflared(dir = join(homedir(), '.local', 'bin'), base = RELEASES, asset = cloudflaredAsset()): Promise<string> {
  if (!asset) throw new Error(`no automatic install for ${process.platform}/${process.arch}; download it from Cloudflare`);
  const r = await fetch(`${base}/${asset}`, { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const data = Buffer.from(await r.arrayBuffer());
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'cloudflared');
  const tmp = `${bin}.${process.pid}.download`;
  writeFileSync(tmp, data, { mode: 0o755 });
  if (asset.endsWith('.tgz')) {
    await run('tar', ['-xzf', tmp, '-C', dir]);
    rmSync(tmp, { force: true });
  } else renameSync(tmp, bin);
  chmodSync(bin, 0o755);
  await run(bin, ['--version']);
  return bin;
}

const run = (cmd: string, args: string[]) => new Promise<void>((ok, fail) => {
  execFile(cmd, args, { timeout: 30_000 }, (err) => (err ? fail(new Error(`${cmd} ${args[0]} failed: ${err.message}`)) : ok()));
});
