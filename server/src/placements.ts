import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Sessions moved to a world by hand (conversation id → world id), kept across restarts in <home>/placements.json. Also holds labels (labels.json). */
export class Placements {
  file: string;
  data: Record<string, string> = {};
  constructor(file: string) {
    this.file = file;
    try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }
  get(id: string): string | undefined { return Object.hasOwn(this.data, id) ? this.data[id] : undefined; }
  set(id: string, worldId: string | null) {
    if (worldId) this.data[id] = worldId; else delete this.data[id];
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) { console.error('[agent-worlds] cannot save placements', (e as Error).message); }
  }
}
