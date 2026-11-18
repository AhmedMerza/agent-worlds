import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.ts';
import { parseConfig } from '../src/config.ts';
import { Captures, audioExt, chunks, extractWith, type Capture, type CaptureView } from '../src/captures.ts';
import { cliFor, issueUrl, fileIssue } from '../src/issues.ts';
import { tmp } from './fixtures.ts';

const TOKEN = 'c'.repeat(64);
const H = { 'x-aw-token': TOKEN };
const J = { ...H, 'content-type': 'application/json' };

async function boot(opts: Record<string, unknown> = {}) {
  const repo = tmp(), other = tmp(), home = tmp();
  const cfg = { ...parseConfig({ worlds: [{ id: 'w', name: 'W', repos: [repo, other] }] }), port: 0 };
  const app = startServer(cfg, TOKEN, {
    home, procRoot: join(tmp(), 'none'),
    deps: { repoInfo: async (cwd: string) => ({ repo: cwd, branch: 'main', worktree: false, top: cwd }), branchOf: async () => 'main', tmuxSessionOf: async () => 'aw-x' },
    transcribe: async () => ({ text: 'Fix the login button. Also add dark mode to settings.', language: 'en', device: 'cuda' }),
    extract: async (_t: string, repos: string[]) => [{ title: 'Fix the login button', body: 'It does nothing on staging.', repo: repos[0] }, { title: 'Add dark mode', body: '', repo: '/not/a/repo' }],
    ...opts,
  });
  await app.listen();
  const port = (app.server.address() as { port: number }).port;
  return { app, home, repo, other, base: `http://127.0.0.1:${port}`, port };
}

const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timed out'); };
const list = async (base: string) => ((await (await fetch(`${base}/api/captures`, { headers: H })).json()) as { captures: CaptureView[] }).captures;

test('capture: upload → transcribe → extract → review list; audio removed, transcript kept off the snapshot', async () => {
  const { app, base, repo, port, home } = await boot();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: `aw_token=${TOKEN}`, origin: `http://127.0.0.1:${port}` } });
  const frames: any[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once('open', r));
  try {
    const r = await fetch(`${base}/api/captures?name=note.m4a&fromRepo=${encodeURIComponent('/elsewhere')}`, { method: 'POST', headers: { ...H, 'content-type': 'audio/mp4' }, body: new Uint8Array(2048) });
    assert.equal(r.status, 200);
    const { capture } = await r.json() as { capture: CaptureView };
    assert.equal(capture.fromRepo, undefined, 'a fromRepo outside the worlds is ignored');
    await until(async () => (await list(base))[0]?.status === 'ready');
    const [c] = await list(base);
    assert.deepEqual(c.items.map((i) => [i.title, i.repo, i.status]), [['Fix the login button', repo, 'pending'], ['Add dark mode', null, 'pending']], 'an unknown repo from the extractor becomes null');
    assert.equal(c.hasTranscript, true);
    assert.equal((c as any).transcript, undefined);
    assert.equal((c as any).audioPath, undefined);
    const saved = JSON.parse(readFileSync(join(home, 'captures.json'), 'utf8')) as Capture[];
    assert.equal(saved[0].audioPath, undefined, 'audio deleted once ready');
    assert.match((await (await fetch(`${base}/api/captures/${c.id}/transcript`, { headers: H })).json() as { transcript: string }).transcript, /login button/);
    assert.ok(frames.some((f) => f.type === 'capture' && f.capture.status === 'ready' && f.capture.transcript === undefined), 'progress is broadcast without the transcript');
    assert.ok(frames.find((f) => f.type === 'snapshot').captures, 'snapshot carries captures');
  } finally { ws.close(); await app.close(); }
});

test('capture upload: refuses non-audio, empty and oversized bodies', async () => {
  const { app, base } = await boot();
  try {
    assert.equal((await fetch(`${base}/api/captures?name=x.sh`, { method: 'POST', headers: { ...H, 'content-type': 'text/plain' }, body: 'x' })).status, 415);
    assert.equal((await fetch(`${base}/api/captures?name=x.wav`, { method: 'POST', headers: H, body: new Uint8Array(0) })).status, 400);
    assert.equal((await fetch(`${base}/api/captures?name=x.wav`, { method: 'POST', headers: { ...H, 'content-length': String(501 * 1024 * 1024) }, body: 'x', duplex: 'half' } as RequestInit).catch(() => ({ status: 413 }))).status, 413);
    assert.equal((await fetch(`${base}/api/captures`, { method: 'POST', headers: H, body: 'x' })).status, 415, 'no name, no audio mime');
  } finally { await app.close(); }
});

test('filing: needs a project in the worlds, files once, a second press is refused, a CLI error keeps it pending', async () => {
  const filed: string[][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let fail = false;
  const { app, base, repo, other } = await boot({
    fileIssue: async (r: string, t: string, b: string) => { filed.push([r, t, b]); await gate; if (fail) throw new Error('glab failed: 401'); return 'https://gitlab.example/g/p/-/issues/7'; },
  });
  try {
    await fetch(`${base}/api/captures?name=n.webm`, { method: 'POST', headers: H, body: 'abc' });
    await until(async () => (await list(base))[0]?.status === 'ready');
    const [c] = await list(base);
    const [a, b] = c.items;
    const file = (id: string) => fetch(`${base}/api/captures/${c.id}/items/${id}/file`, { method: 'POST', headers: H });
    const patch = (id: string, body: object) => fetch(`${base}/api/captures/${c.id}/items/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify(body) });

    assert.equal((await file(b.id)).status, 400, 'no project picked');
    assert.equal((await patch(b.id, { repo: '/etc' })).status, 400, 'a repo outside the worlds is refused');
    assert.equal((await patch(b.id, { title: '' })).status, 400);
    assert.equal((await patch(b.id, { status: 'filed' })).status, 400, 'filed is set by filing only');

    const first = file(a.id);
    await until(async () => (await list(base))[0].items[0].status === 'filing');
    assert.equal((await file(a.id)).status, 409, 'second press while filing');
    assert.equal((await patch(a.id, { title: 'changed' })).status, 409, 'no edits while filing');
    release();
    assert.equal((await first).status, 200);
    assert.deepEqual(filed, [[repo, 'Fix the login button', 'It does nothing on staging.']]);
    const done = (await list(base))[0].items[0];
    assert.deepEqual([done.status, done.issueUrl], ['filed', 'https://gitlab.example/g/p/-/issues/7']);
    assert.equal((await file(a.id)).status, 409, 'already filed');

    fail = true;
    assert.equal((await patch(b.id, { repo: other, title: '-x leading dash' })).status, 200);
    assert.equal((await file(b.id)).status, 502);
    const kept = (await list(base))[0].items[1];
    assert.deepEqual([kept.status, kept.error], ['pending', 'glab failed: 401']);
    assert.equal((await patch(b.id, { status: 'dropped' })).status, 200);
  } finally { release(); await app.close(); }
});

test('restart: an unfinished capture runs again, a crash loop stops, a cut-off filing becomes check', async () => {
  const home = tmp(), file = join(home, 'captures.json'), audio = join(home, 'a.wav'), looped = join(home, 'b.wav');
  writeFileSync(audio, 'x'); writeFileSync(looped, 'x');
  const base = { createdAt: Date.now(), items: [] };
  writeFileSync(file, JSON.stringify([
    { ...base, id: 'again', status: 'transcribing', attempts: 1, audioPath: audio },
    { ...base, id: 'loop', status: 'transcribing', attempts: 2, audioPath: looped },
    { ...base, id: 'cut', status: 'ready', attempts: 0, items: [{ id: 'i', title: 't', body: '', repo: '/r', status: 'filing' }] },
    { ...base, id: 'old', createdAt: 0, status: 'ready', attempts: 0, items: [{ id: 'i', title: 't', body: '', repo: '/r', status: 'filed' }] },
    { id: 'junk' },
  ]));
  let runs = 0;
  const caps = new Captures(file, join(home, 'captures'), {
    transcribe: async () => { runs++; return { text: 'hello' }; }, extract: async () => [], fileIssue: async () => '',
    repos: () => ['/r'], onChange: () => {},
  });
  await caps.idle();
  assert.equal(runs, 1, 'only the capture under the attempt cap runs');
  assert.equal(caps.all.get('again')!.status, 'ready');
  assert.deepEqual(caps.all.get('again')!.items, [], 'nothing found is ready with no items, not an error');
  assert.equal(caps.all.get('loop')!.status, 'failed');
  assert.equal(caps.all.get('cut')!.items[0].status, 'check');
  assert.ok(!caps.all.has('old') && !caps.all.has('junk'), 'old finished captures and malformed rows are dropped');
  assert.ok(existsSync(looped) && !existsSync(audio), 'a failed capture keeps its audio, a ready one drops it');
  assert.equal(typeof caps.retry('loop'), 'object');
  await caps.idle();
  assert.equal(caps.all.get('loop')!.status, 'ready');
});

test('transcription failure: capture failed with the reason, audio kept for retry', async () => {
  const { app, base } = await boot({ transcribe: async () => { throw new Error('cannot run python'); } });
  try {
    await fetch(`${base}/api/captures?name=n.ogg`, { method: 'POST', headers: H, body: 'abc' });
    await until(async () => (await list(base))[0]?.status === 'failed');
    const [c] = await list(base);
    assert.match(c.error!, /cannot run python/);
    assert.equal((await fetch(`${base}/api/captures/${c.id}`, { method: 'DELETE', headers: H })).status, 200);
    assert.deepEqual(await list(base), []);
  } finally { await app.close(); }
});

test('audioExt: name first, then mime; Safari mp4 and Android amr accepted, scripts refused', () => {
  assert.equal(audioExt('Voice 012.M4A', null), 'm4a');
  assert.equal(audioExt(null, 'audio/webm;codecs=opus'), 'webm');
  assert.equal(audioExt('blob', 'audio/mp4'), 'mp4');
  assert.equal(audioExt('rec.amr', 'application/octet-stream'), 'amr');
  assert.equal(audioExt(null, 'audio/mpeg'), 'mp3');
  assert.equal(audioExt('x.sh', 'text/plain'), null);
});

test('cliFor and issueUrl: github remotes use gh; the address is read out of glab chatter', () => {
  assert.equal(cliFor('git@github.com:AhmedMerza/agent-worlds.git\n'), 'gh');
  assert.equal(cliFor('https://github.com/a/b.git'), 'gh');
  assert.equal(cliFor('git@gitlab.com:x/y.git'), 'glab');
  assert.equal(cliFor('https://git.company.example/github.com/y.git'), 'glab', 'github.com in a path is not GitHub');
  assert.equal(issueUrl('Creating issue in g/p\n#7 Fix it (just now)\n https://gitlab.com/g/p/-/issues/7\n'), 'https://gitlab.com/g/p/-/issues/7');
  assert.equal(issueUrl('https://github.com/a/b/issues/12\n'), 'https://github.com/a/b/issues/12');
  assert.throws(() => issueUrl('error: 401'), /no issue address/);
});

test('extract: long transcripts go in pieces, projects by number, an out-of-range number is no project', async () => {
  const calls: string[] = [];
  const run = async (_b: string, _s: string, _sc: string, input: string) => { calls.push(input); return { items: [{ title: 'T', body: 'B', project: calls.length === 1 ? 1 : 9 }] }; };
  const text = 'Do the thing now. '.repeat(3000);
  assert.ok(chunks(text).every((c) => c.length <= 30_000) && chunks(text).join(' ').length >= text.trim().length - chunks(text).length);
  const items = await extractWith('claude', run)(text, ['/a/one', '/b/two'], '/b/two');
  assert.equal(calls.length, chunks(text).length);
  assert.match(calls[0], /0: a\/one\n1: b\/two/);
  assert.match(calls[0], /working in project 1/);
  assert.deepEqual(items[0], { title: 'T', body: 'B', repo: '/b/two' });
  assert.equal(items[1].repo, null);
});

test('fileIssue files in upstream when the repo has one, not in the fork origin points at', async () => {
  const repo = tmp(), bin = tmp(), log = join(bin, 'args');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'http://gitlab.example/me/app.git']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'upstream', 'http://gitlab.example/team/app.git']);
  writeFileSync(join(bin, 'glab'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\necho 'https://gitlab.example/team/app/-/issues/3'\n`);
  chmodSync(join(bin, 'glab'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.equal(await fileIssue(repo, '-x title', 'body'), 'https://gitlab.example/team/app/-/issues/3');
    assert.ok(readFileSync(log, 'utf8').split('\n').includes('--repo=http://gitlab.example/team/app.git'));
    execFileSync('git', ['-C', repo, 'remote', 'remove', 'upstream']);
    await fileIssue(repo, 't', 'b');
    assert.ok(readFileSync(log, 'utf8').split('\n').includes('--repo=http://gitlab.example/me/app.git'), 'origin when there is no upstream');
    // glab 1.85 prints a work_items address; and a reply with no address at all still counts as filed (exit 0 = created)
    writeFileSync(join(bin, 'glab'), `#!/bin/sh\necho ' - Creating issue in team/app' >&2\necho 'http://gitlab.example/team/app/-/work_items/4'\n`);
    assert.equal(await fileIssue(repo, 't', 'b'), 'http://gitlab.example/team/app/-/work_items/4');
    writeFileSync(join(bin, 'glab'), `#!/bin/sh\necho 'created'\n`);
    assert.equal(await fileIssue(repo, 't', 'b'), '');
  } finally { process.env.PATH = path; }
});
