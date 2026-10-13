import { execFile } from 'node:child_process';
import { readdirSync, statSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Exit code that tells bin/agent-worlds to start the server again (EX_TEMPFAIL). */
export const RESTART_CODE = 75;

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SOURCES = [join(ROOT, 'server/src'), join(ROOT, 'web/src'), join(ROOT, 'web/index.html')];

/** Newest modification time among the files under `paths` (0 when none exist). */
export function newest(paths: string[]): number {
  let max = 0;
  for (const p of paths) {
    try {
      const st = statSync(p);
      if (!st.isDirectory()) { max = Math.max(max, st.mtimeMs); continue; }
      for (const e of readdirSync(p, { withFileTypes: true, recursive: true })) {
        if (e.isFile()) max = Math.max(max, statSync(join(e.parentPath, e.name)).mtimeMs);
      }
    } catch { /* gone or unreadable: ignore */ }
  }
  return max;
}

/** Calls `onNewer` once when the sources become newer than they were at startup. Returns a stop function. */
export function watchCode(onNewer: () => void, roots = SOURCES): () => void {
  const started = newest(roots);
  let timer: ReturnType<typeof setTimeout> | undefined, fired = false;
  const check = () => { clearTimeout(timer); timer = setTimeout(() => { if (!fired && newest(roots) > started) { fired = true; onNewer(); } }, 1000); };
  const watchers = roots.flatMap((r) => { try { return [watch(r, { recursive: true }, check)]; } catch { return []; } });
  return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
}

const run = (cmd: string, args: string[], cwd: string, timeout: number): Promise<string | null> => new Promise((done) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => done(err ? `${out}${errOut}`.trim().split('\n').slice(-15).join('\n') || err.message : null));
});

/** Gets the new code ready to run: rebuilds the web app when its sources are newer, then checks the server code loads. Returns an error or null. */
export async function prepareRestart(root = ROOT): Promise<string | null> {
  const web = join(root, 'web');
  if (newest([join(web, 'src'), join(web, 'index.html')]) > newest([join(web, 'dist/index.html')])) {
    const err = await run('npm', ['run', 'build'], web, 180_000);
    if (err) return `web build failed:\n${err}`;
  }
  const err = await run(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(join(root, 'server/src/server.ts')).href)})`], root, 30_000);
  return err ? `the new server code does not load:\n${err}` : null;
}
