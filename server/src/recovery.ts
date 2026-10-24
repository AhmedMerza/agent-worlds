import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isAgent, type AgentId } from './agents.ts';

export type RecoverableSession = {
  id: string; agent: AgentId; cwd: string; task: string | null; lastPrompt: string | null; updatedAt: number;
};

/** Conversations Agent Worlds was managing until they are explicitly ended. */
export class Recovery {
  private data = new Map<string, RecoverableSession>();
  private file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (Array.isArray(rows)) for (const r of rows) {
        if (r && typeof r === 'object' && typeof r.id === 'string' && isAgent(r.agent) && typeof r.cwd === 'string' && r.cwd.startsWith('/')) {
          this.data.set(r.id, { id: r.id, agent: r.agent, cwd: r.cwd, task: typeof r.task === 'string' ? r.task : null, lastPrompt: typeof r.lastPrompt === 'string' ? r.lastPrompt : null, updatedAt: Number(r.updatedAt) || 0 });
        }
      }
    } catch { /* first run or unreadable file */ }
  }

  list(): RecoverableSession[] { return [...this.data.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  get(id: string): RecoverableSession | undefined { return this.data.get(id); }
  upsert(s: RecoverableSession) {
    const old = this.data.get(s.id);
    if (s.id.startsWith('starting:') || (old && old.agent === s.agent && old.cwd === s.cwd && old.task === s.task && old.lastPrompt === s.lastPrompt)) return;
    this.data.set(s.id, s); this.save();
  }
  delete(id: string) { if (this.data.delete(id)) this.save(); }
  rename(from: string, to: string) {
    const old = this.data.get(from);
    if (!old) return;
    this.data.delete(from); this.data.set(to, { ...old, id: to }); this.save();
  }

  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.list()), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) { console.error('[agent-worlds] cannot save recoverable sessions', (e as Error).message); }
  }
}
