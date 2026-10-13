import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Config, World } from './config.ts';

export const PALETTE = ['#47b4a7', '#e0a03a', '#8a7bd8', '#d9644a', '#5b9bd5', '#c46aa6', '#7fae4e', '#c9b037'];
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const FS_MAX = 500;

type Result = [number, Record<string, unknown>];
const bad = (error: string): Result => [400, { error }];

/** Main repo of a git top-level directory, or an error message. Worktrees resolve to their main repo. */
export function repoRoot(path: string): Promise<{ repo: string } | { error: string }> {
  return new Promise((done) => {
    execFile('git', ['-C', path, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], { timeout: 5000 }, (err, out) => {
      if (err) return done({ error: `not a git repo: ${path}` });
      const [top, common] = out.toString().trim().split('\n');
      if (realpathSync(path) !== top) return done({ error: `not the top folder of a git repo: ${path} (the repo is ${top})` });
      done({ repo: basename(common) === '.git' ? dirname(common) : common });
    });
  });
}

const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'world';

/** Create, rename, recolour, re-repo, delete and reorder worlds; every change is saved to config.json. */
export class Worlds {
  cfg: Config;
  file: string;
  resolve: typeof repoRoot;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(cfg: Config, file: string, resolve = repoRoot) {
    this.cfg = cfg; this.file = file; this.resolve = resolve;
  }

  /** Changes run one at a time: repo checks are async and two requests must not interleave. */
  private serial(fn: () => Promise<Result>): Promise<Result> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  private async repos(raw: unknown, selfId: string | null, worlds: World[]): Promise<{ repos: string[] } | { err: Result }> {
    if (!Array.isArray(raw) || raw.some((p) => typeof p !== 'string')) return { err: bad('repos must be an array of paths') };
    if (raw.length > 200) return { err: bad('too many repos') };
    const out: string[] = [];
    for (const p of raw as string[]) {
      if (!isAbsolute(p)) return { err: bad(`repo path must be absolute: ${p}`) };
      if (!existsSync(p) || !statSync(p).isDirectory()) return { err: bad(`no such folder: ${p}`) };
      const r = await this.resolve(p);
      if ('error' in r) return { err: bad(r.error) };
      const owner = worlds.find((w) => w.id !== selfId && w.repos.includes(r.repo));
      if (owner) return { err: bad(`${r.repo} already belongs to the ${owner.name} world`) };
      if (!out.includes(r.repo)) out.push(r.repo);
    }
    return { repos: out };
  }

  private fields(b: Record<string, unknown>, partial: boolean): Result | null {
    if (b.name !== undefined || !partial) {
      if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 40) return bad('name must be 1-40 characters');
    }
    if (b.color !== undefined && (typeof b.color !== 'string' || !COLOR_RE.test(b.color))) return bad('color must be #rrggbb');
    return null;
  }

  /** Write worlds into config.json atomically, keeping every other key. */
  private save(worlds: World[]): Result | null {
    const err = saveConfigKey(this.file, 'worlds', worlds);
    if (err) return [500, { error: err }];
    this.cfg.worlds = worlds;
    return null;
  }

  create(b: Record<string, unknown>): Promise<Result> {
    return this.serial(async () => {
      const err = this.fields(b, false);
      if (err) return err;
      const worlds = this.cfg.worlds;
      const r = await this.repos(b.repos ?? [], null, worlds);
      if ('err' in r) return r.err;
      const repos = r.repos;
      const base = slug(b.name as string);
      let id = base;
      for (let n = 2; worlds.some((w) => w.id === id); n++) id = `${base}-${n}`;
      const used = new Set(worlds.map((w) => w.color.toLowerCase()));
      const color = (b.color as string) ?? PALETTE.find((c) => !used.has(c)) ?? PALETTE[worlds.length % PALETTE.length];
      const world: World = { id, name: (b.name as string).trim(), color, repos };
      return this.save([...worlds, world]) ?? [201, { world }];
    });
  }

  update(id: string, b: Record<string, unknown>): Promise<Result> {
    return this.serial(async () => {
      const cur = this.cfg.worlds.find((w) => w.id === id);
      if (!cur) return [404, { error: 'no such world' }];
      const err = this.fields(b, true);
      if (err) return err;
      const world: World = { ...cur };
      if (b.name !== undefined) world.name = (b.name as string).trim();
      if (b.color !== undefined) world.color = b.color as string;
      if (b.repos !== undefined) {
        const r = await this.repos(b.repos, id, this.cfg.worlds);
        if ('err' in r) return r.err;
        world.repos = r.repos;
      }
      return this.save(this.cfg.worlds.map((w) => (w.id === id ? world : w))) ?? [200, { world }];
    });
  }

  remove(id: string): Promise<Result> {
    return this.serial(async () => {
      if (!this.cfg.worlds.some((w) => w.id === id)) return [404, { error: 'no such world' }];
      return this.save(this.cfg.worlds.filter((w) => w.id !== id)) ?? [200, { ok: true }];
    });
  }

  order(b: Record<string, unknown>): Promise<Result> {
    return this.serial(async () => {
      const ids = b.ids;
      const have = this.cfg.worlds.map((w) => w.id);
      if (!Array.isArray(ids) || ids.length !== have.length || new Set(ids).size !== ids.length || !ids.every((i) => have.includes(i))) {
        return bad('ids must list every world id exactly once');
      }
      return this.save((ids as string[]).map((i) => this.cfg.worlds.find((w) => w.id === i)!)) ?? [200, { ok: true }];
    });
  }

  /** Folder browser for picking repos: sub-directories only, no hidden ones, sorted, at most 500. */
  list(path: string | null): Result {
    let dir = path;
    if (!dir) {
      const parents = this.cfg.worlds.flatMap((w) => w.repos).map((r) => dirname(r));
      const counts = new Map<string, number>();
      for (const p of parents) counts.set(p, (counts.get(p) ?? 0) + 1);
      dir = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? homedir();
      if (!existsSync(dir)) dir = homedir();
    }
    if (!isAbsolute(dir)) return bad('path must be absolute');
    let real: string;
    try { real = realpathSync(dir); if (!statSync(real).isDirectory()) throw 0; } catch { return bad(`no such folder: ${dir}`); }
    let names: string[];
    try {
      names = readdirSync(real, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('.') && (d.isDirectory() || (d.isSymbolicLink() && isDir(join(real, d.name)))))
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (e) { return [403, { error: `cannot read ${real}: ${(e as NodeJS.ErrnoException).code ?? 'error'}` }]; }
    const entries = names.slice(0, FS_MAX).map((name) => {
      const p = join(real, name);
      return { name, path: p, isRepo: existsSync(join(p, '.git')) };
    });
    return [200, { path: real, parent: real === '/' ? null : dirname(real), entries, truncated: names.length > FS_MAX }];
  }
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** Set one top-level key of config.json atomically, keeping every other key. Returns an error message or null. */
export function saveConfigKey(file: string, key: string, value: unknown): string | null {
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return `${file} is not valid JSON; not changing it`; }
  }
  raw[key] = value;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) { return `cannot save config: ${(e as Error).message}`; }
  return null;
}
