import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from './child.ts';
import { claudeJson } from './insights.ts';

/**
 * A voice capture: a recording, transcribed on this machine, split into items you review and file as issues.
 * Nothing is filed until you press Create issue on an item. Kept in <home>/captures.json; the audio lives in
 * <home>/captures/ until the capture is transcribed and extracted, so a restart can pick an unfinished one up again.
 */
export type ItemStatus = 'pending' | 'filing' | 'filed' | 'dropped' | 'check';
export type Item = { id: string; title: string; body: string; repo: string | null; status: ItemStatus; issueUrl?: string; error?: string };
export type CaptureStatus = 'transcribing' | 'extracting' | 'ready' | 'failed';
export type Capture = {
  id: string; createdAt: number; fromRepo?: string; audioPath?: string;
  status: CaptureStatus; attempts: number; error?: string;
  transcript?: string; language?: string; device?: string;
  items: Item[];
};
/** What the web gets: no transcript (fetched on demand, it can be large) and no server path. */
export type CaptureView = Omit<Capture, 'transcript' | 'audioPath'> & { hasTranscript: boolean };

export type Transcript = { text: string; language?: string; device?: string };
export type Transcribe = (audio: string) => Promise<Transcript>;
export type Extracted = { title: string; body: string; repo: string | null };
export type Extract = (transcript: string, repos: string[], fromRepo?: string) => Promise<Extracted[]>;
export type FileIssue = (repo: string, title: string, body: string) => Promise<string>;

/** Audio a phone or browser hands us: iPhone m4a/caf, Android 3gp/amr/ogg, MediaRecorder webm (Chrome) or mp4 (Safari). */
export const AUDIO_EXT = new Set(['m4a', 'mp4', 'caf', '3gp', 'amr', 'ogg', 'oga', 'opus', 'wav', 'mp3', 'webm', 'flac', 'aac']);
export const MAX_AUDIO = 500 * 1024 * 1024;
/** A capture whose job crashed this many times is marked failed instead of retried on every boot. */
export const MAX_ATTEMPTS = 2;
/** Captures with nothing left to do are dropped from captures.json after this long. */
const KEEP_DONE = 30 * 24 * 3600_000;
const TITLE_MAX = 250;
const BODY_MAX = 20_000;

const STATUSES: CaptureStatus[] = ['transcribing', 'extracting', 'ready', 'failed'];
const ITEM_STATUSES: ItemStatus[] = ['pending', 'filing', 'filed', 'dropped', 'check'];
const newId = () => `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/** The extension to save an upload under: from its name, else its mime type. Null when it isn't audio we take. */
export function audioExt(name: string | null, mime: string | null): string | null {
  const fromName = name?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  if (fromName && AUDIO_EXT.has(fromName)) return fromName;
  const sub = mime?.toLowerCase().match(/^(?:audio|video)\/(?:x-)?([a-z0-9]+)/)?.[1];
  const ext = sub === 'mpeg' ? 'mp3' : sub === 'mp4a' || sub === 'x-m4a' ? 'm4a' : sub === 'vorbis' ? 'ogg' : sub;
  return ext && AUDIO_EXT.has(ext) ? ext : null;
}

/** Stream a request body to a file, at most `max` bytes. On overflow or abort the partial file is removed. */
export async function saveStream(body: AsyncIterable<Buffer>, file: string, max: number): Promise<number | 'too-big'> {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const out = createWriteStream(file, { mode: 0o600 });
  // A disk that fills up (or a removed folder) must fail this upload, not throw out of the server: no listener = crash.
  let failed: Error | null = null;
  const broke = new Promise<never>((_, fail) => out.once('error', (e) => { failed = e; fail(e); }));
  broke.catch(() => {});
  let size = 0;
  try {
    for await (const c of body) {
      if (failed) throw failed;
      size += c.length;
      if (size > max) { out.destroy(); rmSync(file, { force: true }); return 'too-big'; }
      if (!out.write(c)) await Promise.race([new Promise((r) => out.once('drain', r)), broke]);
    }
    if (failed) throw failed;
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => e ? fail(e) : ok()));
    return size;
  } catch (e) { out.destroy(); rmSync(file, { force: true }); throw e; }
}

export function loadCaptures(file: string): Capture[] {
  let v: unknown;
  try { v = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  // A hand-edited or half-written file must not take the server down: keep only what has the shape the code reads
  const okItem = (i: any) => !!i && typeof i.id === 'string' && typeof i.title === 'string' && typeof i.body === 'string'
    && (i.repo === null || typeof i.repo === 'string') && ITEM_STATUSES.includes(i.status);
  return (Array.isArray(v) ? v : []).filter((c): c is Capture => !!c && typeof c.id === 'string' && Number.isFinite(c.createdAt)
    && STATUSES.includes(c.status) && Array.isArray(c.items) && c.items.every(okItem))
    .map((c) => ({ ...c, attempts: Number.isInteger(c.attempts) ? c.attempts : 0 }));
}

export const viewOf = ({ transcript, audioPath: _a, ...c }: Capture): CaptureView => ({ ...c, hasTranscript: !!transcript });

type Deps = {
  transcribe: Transcribe; extract: Extract; fileIssue: FileIssue;
  /** Repos an item may be filed in: every repo of every world, read fresh each time. */
  repos: () => string[];
  onChange: (c: CaptureView) => void; onRemove?: (id: string) => void;
  now?: () => number;
};

export class Captures {
  all = new Map<string, Capture>();
  /** One job at a time: transcription takes the whole GPU (or 16 cores). */
  private chain: Promise<void> = Promise.resolve();
  private file: string;
  readonly dir: string;
  private d: Deps;

  constructor(file: string, dir: string, deps: Deps) {
    this.file = file; this.dir = dir; this.d = deps;
    for (const c of loadCaptures(file)) {
      this.all.set(c.id, c);
      // Filing was cut off: the issue may exist. Never file again on its own; you check and decide.
      for (const i of c.items) if (i.status === 'filing') { i.status = 'check'; i.error = 'Agent Worlds restarted while filing this: check whether the issue was created.'; }
    }
    this.save();
    for (const c of this.all.values()) if (c.status === 'transcribing' || c.status === 'extracting') this.enqueue(c);
  }

  private now() { return (this.d.now ?? Date.now)(); }

  list(): CaptureView[] { return [...this.all.values()].sort((a, b) => b.createdAt - a.createdAt).map(viewOf); }

  /** Start processing a saved recording. */
  add(audioPath: string, fromRepo?: string): CaptureView {
    const c: Capture = { id: newId(), createdAt: this.now(), audioPath, status: 'transcribing', attempts: 0, items: [], ...(fromRepo ? { fromRepo } : {}) };
    this.all.set(c.id, c);
    this.changed(c);
    this.enqueue(c);
    return viewOf(c);
  }

  /** Run a failed capture again (its audio is still here). */
  retry(id: string): string | CaptureView {
    const c = this.all.get(id);
    if (!c) return 'no such capture';
    if (c.status !== 'failed') return 'only a failed capture can be retried';
    if (!c.audioPath && !c.transcript) return 'nothing left to retry from';
    c.status = c.transcript ? 'extracting' : 'transcribing'; c.attempts = 0; delete c.error;
    this.changed(c);
    this.enqueue(c);
    return viewOf(c);
  }

  remove(id: string): string | null {
    const c = this.all.get(id);
    if (!c) return 'no such capture';
    if (c.status === 'transcribing' || c.status === 'extracting') return 'still processing';
    if (c.items.some((i) => i.status === 'filing')) return 'an item is being filed';
    if (c.audioPath) rmSync(c.audioPath, { force: true });
    this.all.delete(id);
    this.save();
    this.d.onRemove?.(id);
    return null;
  }

  /** Edit an item's title, body or repo, or set it pending (keep as to-do) or dropped. */
  edit(id: string, itemId: string, patch: Record<string, unknown>): string | CaptureView {
    const c = this.all.get(id), i = c?.items.find((x) => x.id === itemId);
    if (!c || !i) return 'no such item';
    if (i.status === 'filing' || i.status === 'filed') return `already ${i.status}`;
    const { title, body, repo, status } = patch;
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX)) return `title must be 1-${TITLE_MAX} characters`;
    if (body !== undefined && (typeof body !== 'string' || body.length > BODY_MAX)) return `body must be at most ${BODY_MAX} characters`;
    if (repo !== undefined && repo !== null && !(typeof repo === 'string' && this.d.repos().includes(repo))) return 'not a repo of any world';
    if (status !== undefined && status !== 'pending' && status !== 'dropped') return 'status must be pending or dropped';
    if (title !== undefined) i.title = (title as string).trim();
    if (body !== undefined) i.body = body as string;
    if (repo !== undefined) i.repo = repo as string | null;
    if (status !== undefined) { i.status = status as ItemStatus; delete i.error; }
    this.changed(c);
    return viewOf(c);
  }

  /** File one item as an issue. The item is marked filing (and saved) before the CLI runs, so a second press is refused. */
  async fileItem(id: string, itemId: string): Promise<{ status: number; error?: string; capture?: CaptureView }> {
    const c = this.all.get(id), i = c?.items.find((x) => x.id === itemId);
    if (!c || !i) return { status: 404, error: 'no such item' };
    if (i.status !== 'pending') return { status: 409, error: i.status === 'check' ? 'check whether it was filed first, then set it back to pending' : `already ${i.status}` };
    if (!i.repo || !this.d.repos().includes(i.repo)) return { status: 400, error: 'pick a project first' };
    i.status = 'filing'; delete i.error;
    this.changed(c);
    try {
      i.issueUrl = await this.d.fileIssue(i.repo, i.title, i.body);
      i.status = 'filed';
    } catch (e) {
      // A CLI that was killed may already have created the issue: you check, it is never filed again on its own.
      i.status = (e as { maybeFiled?: boolean }).maybeFiled ? 'check' : 'pending';
      i.error = (e as Error).message.slice(0, 500);
    }
    this.changed(c);
    return i.status === 'filed' ? { status: 200, capture: viewOf(c) } : { status: 502, error: i.error, capture: viewOf(c) };
  }

  private enqueue(c: Capture) {
    this.chain = this.chain.then(() => this.process(c), () => this.process(c));
  }

  /** Never throws: a failure marks the capture failed (its audio stays, so it can be retried). */
  private async process(c: Capture) {
    if (this.all.get(c.id) !== c) return;
    if (c.attempts >= MAX_ATTEMPTS) { this.fail(c, `stopped after ${MAX_ATTEMPTS} attempts`); return; }
    c.attempts++;
    this.save();
    try {
      if (c.transcript === undefined) {
        if (!c.audioPath) throw new Error('the recording is missing');
        c.status = 'transcribing'; this.changed(c);
        const t = await this.d.transcribe(c.audioPath);
        c.transcript = t.text.trim();
        if (t.language) c.language = t.language;
        if (t.device) c.device = t.device;
      }
      c.status = 'extracting'; this.changed(c);
      const repos = this.d.repos();
      const found = c.transcript ? await this.d.extract(c.transcript, repos, c.fromRepo) : [];
      c.items = found.filter((f) => f.title?.trim()).map((f) => ({
        id: randomBytes(4).toString('hex'), title: f.title.trim().slice(0, TITLE_MAX), body: (f.body ?? '').slice(0, BODY_MAX),
        repo: f.repo && repos.includes(f.repo) ? f.repo : null, status: 'pending' as const,
      }));
      c.status = 'ready'; c.attempts = 0; delete c.error;
      if (c.audioPath) { rmSync(c.audioPath, { force: true }); delete c.audioPath; }
      this.changed(c);
    } catch (e) { this.fail(c, (e as Error).message); }
  }

  private fail(c: Capture, msg: string) {
    c.status = 'failed'; c.error = msg.slice(0, 500);
    this.changed(c);
  }

  private changed(c: Capture) {
    this.save();
    if (this.all.get(c.id) === c) this.d.onChange(viewOf(c));
  }

  private save() {
    const now = this.now();
    for (const [id, c] of this.all) {
      const done = c.status === 'ready' && c.items.every((i) => i.status === 'filed' || i.status === 'dropped');
      if ((done || c.status === 'failed') && now - c.createdAt > KEEP_DONE) {
        if (c.audioPath) rmSync(c.audioPath, { force: true });
        this.all.delete(id);
      }
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file + '.tmp', JSON.stringify([...this.all.values()]), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    } catch (e) { console.error('[agent-worlds] cannot save captures', (e as Error).message); }
  }

  /** Wait for queued jobs (tests). */
  idle() { return this.chain; }
}

// --- The real transcriber and extractor ---------------------------------------------------------------

const SCRIPT = fileURLToPath(new URL('../stt/transcribe.py', import.meta.url));
/** A 3-hour meeting on the CPU fallback (3.7x realtime) takes about 50 minutes. */
const TRANSCRIBE_TIMEOUT_MS = 3 * 3600_000;

/** Run stt/transcribe.py with the given Python (faster-whisper large-v3-turbo; GPU when it has room, else CPU). */
export const transcribeWith = (python: string): Transcribe => (audio) => new Promise((ok, fail) => {
  // A private folder: the transcript is someone's speech, and /tmp is shared.
  const dir = mkdtempSync(join(tmpdir(), 'aw-stt-'));
  const out = join(dir, 'out.json');
  const child = spawn(python, ['-I', SCRIPT, audio, out], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), TRANSCRIBE_TIMEOUT_MS);
  child.stderr!.on('data', (d) => { err = (err + d).slice(-4000); });
  child.on('error', (e) => { clearTimeout(timer); rmSync(dir, { recursive: true, force: true }); fail(new Error(`cannot run ${python}: ${e.message}. Set sttPython in config.json to a Python with faster-whisper.`)); });
  child.on('close', async (code, sig) => {
    clearTimeout(timer);
    try {
      if (code !== 0) throw new Error(`transcription failed (${code ?? sig}): ${err.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
      const r = JSON.parse(await readFile(out, 'utf8'));
      if (typeof r.text !== 'string') throw new Error('transcription wrote no text');
      ok({ text: r.text, language: r.language, device: r.device });
    } catch (e) { fail(e as Error); } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const EXTRACT_SYSTEM = 'You turn a spoken note or a meeting transcript into the work items it asks for. '
  + 'Answer only from the transcript. Do not use any tools. Write each title as a short imperative issue title, '
  + 'in the language the speaker used. The body says what is wanted and why, with any detail the speaker gave, and nothing invented. '
  + 'Small talk, opinions and things already done are not items.';
const EXTRACT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          project: { type: 'integer', description: 'The number of the project this item belongs to, from the list; -1 when the transcript does not make it clear.' },
        },
        required: ['title', 'body', 'project'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
});
/** Transcript pieces sent to one extraction call: about 8k tokens of English, fewer for Arabic. */
const CHUNK = 30_000;
const EXTRACT_TIMEOUT_MS = 5 * 60_000;

/** Split at sentence ends near the limit, so an item is rarely cut in half. */
export function chunks(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = Math.max(rest.lastIndexOf('. ', size), rest.lastIndexOf('؟ ', size), rest.lastIndexOf('? ', size), rest.lastIndexOf('\n', size));
    const at = cut > size / 2 ? cut + 1 : size;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** Extract items with `claude -p --model haiku`; the project is picked by number so two repos with one name can't mix. */
export const extractWith = (bin: string, run = claudeJson): Extract => async (transcript, repos, fromRepo) => {
  const list = repos.map((r, n) => `${n}: ${r.split('/').filter(Boolean).slice(-2).join('/')}`).join('\n');
  const hint = fromRepo && repos.includes(fromRepo) ? `\nThe user recorded this while working in project ${repos.indexOf(fromRepo)}; use it only when the transcript names no other project.` : '';
  const items: Extracted[] = [];
  for (const part of chunks(transcript)) {
    const r = await run(bin, EXTRACT_SYSTEM, EXTRACT_SCHEMA, `Projects:\n${list}${hint}\n\nTranscript:\n${part}`, EXTRACT_TIMEOUT_MS) as { items?: unknown };
    if (!Array.isArray(r.items)) throw new Error('unreadable reply: no items');
    for (const i of r.items as { title?: unknown; body?: unknown; project?: unknown }[]) {
      if (typeof i?.title !== 'string') continue;
      items.push({ title: i.title, body: typeof i.body === 'string' ? i.body : '', repo: Number.isInteger(i.project) ? repos[i.project as number] ?? null : null });
    }
  }
  return items;
};
