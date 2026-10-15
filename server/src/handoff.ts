import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { glob } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session } from './store.ts';
import { AGENTS } from './agents.ts';
import { readTail, excerpt } from './transcript.ts';

/** Long handoffs keep their start and their most recent part. */
const HEAD = 4096;
const TAIL = 12_288;

function run(cmd: string, args: string[], cwd: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => done(err ? null : stdout.toString()));
  });
}

/** Kimi's wire log for `id`: <kimi home>/sessions/wd_* /session_<id>/agents/main/wire.jsonl. */
async function kimiWireLog(id: string, home: string): Promise<string | null> {
  const real = process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
  for (const base of [real, join(home, 'kimi-home')]) {
    if (!existsSync(base)) continue;
    try {
      for await (const f of glob(`sessions/wd_*/session_${id}/agents/main/wire.jsonl`, { cwd: base })) return join(base, f);
    } catch { /* unreadable home */ }
  }
  return null;
}

/**
 * Writes a handoff for "Continue in another agent" to <home>/handoffs/<session id>.md (never in the
 * repo) and returns its path. Mechanical only: what the store knows, the working-tree state, and the
 * conversation excerpt Claude's transcript gives us. Other agents' transcripts are only named;
 * the new agent reads the relevant parts itself.
 */
export async function writeHandoff(session: Session, home: string): Promise<string> {
  const dir = join(home, 'handoffs');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const parts: string[] = [];
  parts.push(`# Handoff from ${AGENTS[session.agent].name}`);
  parts.push('');
  parts.push(`Another agent worked on this and you are taking over, in the same folder. Pick up where it left off.`);
  parts.push('');
  parts.push(`- Agent: ${AGENTS[session.agent].name} (${session.agent})`);
  parts.push(`- Repo: ${session.repo}`);
  if (session.branch) parts.push(`- Branch: ${session.branch}${session.worktree ? ' (worktree)' : ''}`);
  parts.push(`- Folder: ${session.cwd}`);
  parts.push(`- Started: ${new Date(session.startedAt).toISOString()}`);
  if (session.task) parts.push('', '## Task', '', session.task);
  if (session.lastPrompt && session.lastPrompt !== session.task) parts.push('', '## Last thing asked', '', session.lastPrompt);
  if (session.log.length) {
    parts.push('', '## Recent steps', '');
    for (const l of session.log) parts.push(`- ${new Date(l.t).toISOString()} ${l.text}`);
  }
  const status = await run('git', ['status', '--short', '--branch'], session.cwd);
  if (status !== null) {
    const stat = (await run('git', ['diff', '--stat', 'HEAD'], session.cwd)) ?? '';
    parts.push('', '## Working tree', '', '```', status.trimEnd());
    if (stat.trim()) parts.push('', stat.trimEnd());
    parts.push('```');
  } else {
    parts.push('', '## Working tree', '', `${session.cwd} is not a git repo.`);
  }
  if (session.agent === 'claude' && session.transcriptPath) {
    try {
      const text = excerpt(await readTail(session.transcriptPath, 512 * 1024));
      if (text.trim()) parts.push('', '## Conversation (most recent part)', '', '```', text.trimEnd(), '```');
    } catch { /* transcript gone: the steps above still carry the story */ }
  } else if (session.agent === 'kimi') {
    const wire = session.id.startsWith('starting:') ? null : await kimiWireLog(session.id, home);
    parts.push('', '## Previous transcript', '',
      wire
        ? `The ${AGENTS.kimi.name} session's wire log is at ${wire}. Read the relevant parts yourself.`
        : `The ${AGENTS.kimi.name} session's wire log was not found; it lives under ~/.kimi-code/sessions/wd_*/session_${session.id}/agents/main/wire.jsonl. Look for it there if you need the conversation.`);
  } else if (session.logPath) {
    parts.push('', '## Previous transcript', '', `The ${AGENTS[session.agent].name} session's transcript is at ${session.logPath}. Read the relevant parts yourself.`);
  }
  let body = parts.join('\n') + '\n';
  if (body.length > HEAD + TAIL) body = `${body.slice(0, HEAD)}\n\n[... middle omitted ...]\n\n${body.slice(-TAIL)}`;
  const file = join(dir, `${session.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.md`);
  await writeFile(file, body, { mode: 0o600 });
  return file;
}
