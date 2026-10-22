import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { isAgent, type AgentId } from './agents.ts';

/**
 * A run carries one task through ordered steps, each a session on its own agent, all in one folder.
 * A step ends when its agent calls aw_handoff (or you move it on); a checkpoint step then waits for your OK.
 * A code review that asks for CHANGES sends the work back to the build step before it, up to MAX_ROUNDS times.
 * Kept in <home>/runs.json, so a restart (an update) picks them up: session ids and panes stay the same.
 */
export type StepKind = 'plan' | 'review-plan' | 'build' | 'review-code';
export type Step = {
  kind: StepKind; agent: AgentId; checkpoint: boolean;
  status: 'pending' | 'running' | 'handed';
  /** Where its session runs, until its first hook names the session. */
  pane: string | null; direct: string | null; sessionId: string | null;
  summary: string | null;
};
export type Run = {
  id: string; task: string; worldId: string; repo: string; worktree: boolean;
  /** The folder every step runs in: the repo, or the worktree the first step made. */
  dir: string | null;
  /** The last handoff written, for the next step; from: the step that wrote it (the one before, unless a review sent the work back). */
  handoff: { path: string; summary: string | null; from?: number } | null;
  steps: Step[]; current: number;
  /** Times a code review sent the work back to the build step, and the sessions of the steps it sent back (still the run's). */
  rounds: number; earlier: Pick<Step, 'pane' | 'direct' | 'sessionId'>[];
  /** waiting: a checkpoint, or a step that ended without a handoff, needs you. */
  status: 'running' | 'waiting' | 'done' | 'stopped' | 'failed';
  note: string | null; startedAt: number;
  /** The session that started the run with aw_spawn: every step's session is on its team. */
  parent?: string | null;
};

export const STEP_KINDS: Record<StepKind, { label: string; brief: (files: string) => string }> = {
  plan: { label: 'Plan', brief: (f) => `Your part: plan the work. Read the code you need, then write the plan to ${f}/plan.md. Do not change any code.` },
  'review-plan': { label: 'Review plan', brief: (f) => `Your part: review the plan in ${f}/plan.md against the code. Write your review to ${f}/plan-review.md, its first line APPROVED or CHANGES. If CHANGES, fix the plan in place and say what you changed. Do not change any code.` },
  build: { label: 'Build', brief: (f) => `Your part: implement the plan in ${f}/plan.md (read ${f}/plan-review.md too if it exists). Run the tests and commit your work.` },
  'review-code': { label: 'Review code', brief: (f) => `Your part: review the changes made for this task (git log and diff against where the branch started) against ${f}/plan.md. Do not change any code. Write your review to ${f}/code-review.md (replace any earlier one), its first line APPROVED or CHANGES. CHANGES sends the work back to the build step with your review, so list exactly what must change.` },
};
/** Times a code review can send the work back to the build step; after that, a CHANGES review waits for you. */
export const MAX_ROUNDS = 2;
const RUN_STATUSES: unknown[] = ['running', 'waiting', 'done', 'stopped', 'failed'];
export const isStepKind = (k: unknown): k is StepKind => typeof k === 'string' && Object.hasOwn(STEP_KINDS, k);

/** The folder, inside the run's working folder, where steps leave their files (kept out of git). */
export const RUN_FILES = (id: string) => `.aw/run-${id}`;

/** The first message of a step's session. */
export function stepPrompt(run: Run, i: number): string {
  const h = run.handoff;
  const s = run.steps[i];
  const from = h ? run.steps[h.from ?? i - 1] : null;
  return [
    `You are step ${i + 1} of ${run.steps.length} (${STEP_KINDS[s.kind].label}) in an Agent Worlds run: other coding agents do the other steps in this same folder.`,
    `The task: ${run.task}`,
    STEP_KINDS[s.kind].brief(RUN_FILES(run.id)),
    s.kind === 'build' && run.rounds ? `This is round ${run.rounds + 1}: the code review asked for changes. Make the ones listed in ${RUN_FILES(run.id)}/code-review.md, run the tests and commit.` : '',
    h && from ? `The step before you (${STEP_KINDS[from.kind].label}, ${from.agent}) left a handoff: read "${h.path}" first.${h.summary ? ` Its summary: ${h.summary}` : ''}` : '',
    'When your part is done, call the aw_handoff tool with a short summary for the next step. If you need the user, ask them instead.',
  ].filter(Boolean).join('\n\n');
}

export function newRun(o: { task: string; worldId: string; repo: string; worktree: boolean; steps: { kind: StepKind; agent: AgentId; checkpoint: boolean }[]; now: number; parent?: string | null }): Run {
  return {
    ...(o.parent ? { parent: o.parent } : {}),
    id: randomBytes(3).toString('hex'), task: o.task, worldId: o.worldId, repo: o.repo, worktree: o.worktree, dir: null, handoff: null,
    steps: o.steps.map((s) => ({ ...s, status: 'pending', pane: null, direct: null, sessionId: null, summary: null })),
    current: 0, rounds: 0, earlier: [], status: 'running', note: null, startedAt: o.now,
  };
}

/** Keep the run files out of git: `.aw/` in the repo's info/exclude (shared by its worktrees). A non-git folder is left alone. */
export async function excludeRunFiles(dir: string): Promise<void> {
  const out = await new Promise<string | null>((ok) => execFile('git', ['-C', dir, 'rev-parse', '--git-common-dir'], (e, o) => ok(e ? null : o.trim())));
  if (!out) return;
  const file = join(isAbsolute(out) ? out : join(dir, out), 'info', 'exclude');
  const has = await readFile(file, 'utf8').catch(() => '');
  if (has.split('\n').includes('.aw/')) return;
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${has && !has.endsWith('\n') ? '\n' : ''}# Agent Worlds run files\n.aw/\n`);
}

/** Finished runs kept in runs.json for this long, and at most MAX_RUNS of them (the oldest go first). Live runs always stay. */
const KEEP_FINISHED = 7 * 24 * 3600_000;
const MAX_RUNS = 50;

export function loadRuns(file: string): Run[] {
  let v: unknown;
  try { v = JSON.parse(readFileSync(file, 'utf8')); } catch { return []; }
  // A hand-edited or half-written file must not take the server down: keep only runs with the shape the code reads
  const okStep = (s: any) => !!s && ['pending', 'running', 'handed'].includes(s.status) && isStepKind(s.kind) && isAgent(s.agent);
  return (Array.isArray(v) ? v : []).filter((r): r is Run => !!r && typeof r.id === 'string' && RUN_STATUSES.includes(r.status)
    && Array.isArray(r.steps) && r.steps.length > 0 && r.steps.every(okStep)
    && Number.isInteger(r.current) && r.current >= 0 && r.current < r.steps.length)
    .map((r) => ({ ...r, rounds: Number.isInteger(r.rounds) ? r.rounds : 0, earlier: Array.isArray(r.earlier) ? r.earlier : [] })); // runs.json from before rounds
}

/** A review's verdict: the first line of its file says APPROVED or CHANGES (markdown around it is fine). Null when there is none. */
export async function reviewVerdict(file: string): Promise<'APPROVED' | 'CHANGES' | null> {
  const first = (await readFile(file, 'utf8').catch(() => '')).split('\n').find((l) => l.trim()) ?? '';
  const m = first.match(/^\W*(APPROVED|CHANGES)\b/i);
  return m ? (m[1].toUpperCase() as 'APPROVED' | 'CHANGES') : null;
}

export function saveRuns(file: string, runs: Map<string, Run>, now: number) {
  for (const [id, r] of runs) if (!['running', 'waiting'].includes(r.status) && now - r.startedAt > KEEP_FINISHED) runs.delete(id);
  const finished = [...runs.values()].filter((r) => !['running', 'waiting'].includes(r.status));
  for (const r of finished.slice(0, Math.max(0, finished.length - MAX_RUNS))) runs.delete(r.id);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file + '.tmp', JSON.stringify([...runs.values()]), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  } catch (e) { console.error('[agent-worlds] cannot save runs', (e as Error).message); }
}
