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
    this.save();
  }
  /** Every entry whose value is `from` now holds `to` (a lead's new id after /clear, in parents.json). */
  replaceValue(from: string, to: string) {
    let n = 0;
    for (const [k, v] of Object.entries(this.data)) if (v === from) { this.data[k] = to; n++; }
    if (n) this.save();
  }
  private save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) { console.error('[agent-worlds] cannot save placements', (e as Error).message); }
  }
}
