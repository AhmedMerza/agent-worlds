import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { AgentId } from './agents.ts';

/**
 * A run carries one task through ordered steps, each a session on its own agent, all in one folder.
 * A step ends when its agent calls aw_handoff (or you move it on); a checkpoint step then waits for your OK.
 * Kept in memory: a server restart forgets runs, while their sessions live on in tmux.
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
  /** The last handoff written, for the next step. */
  handoff: { path: string; summary: string | null } | null;
  steps: Step[]; current: number;
  /** waiting: a checkpoint, or a step that ended without a handoff, needs you. */
  status: 'running' | 'waiting' | 'done' | 'stopped' | 'failed';
  note: string | null; startedAt: number;
};

export const STEP_KINDS: Record<StepKind, { label: string; brief: (files: string) => string }> = {
  plan: { label: 'Plan', brief: (f) => `Your part: plan the work. Read the code you need, then write the plan to ${f}/plan.md. Do not change any code.` },
  'review-plan': { label: 'Review plan', brief: (f) => `Your part: review the plan in ${f}/plan.md against the code. Write your review to ${f}/plan-review.md, its first line APPROVED or CHANGES. If CHANGES, fix the plan in place and say what you changed. Do not change any code.` },
  build: { label: 'Build', brief: (f) => `Your part: implement the plan in ${f}/plan.md (read ${f}/plan-review.md too if it exists). Run the tests and commit your work.` },
  'review-code': { label: 'Review code', brief: (f) => `Your part: review the changes made for this task (git log and diff against where the branch started) against ${f}/plan.md. Fix real bugs you find and commit. Write your review to ${f}/code-review.md.` },
};
export const isStepKind = (k: unknown): k is StepKind => typeof k === 'string' && Object.hasOwn(STEP_KINDS, k);

/** The folder, inside the run's working folder, where steps leave their files (kept out of git). */
export const RUN_FILES = (id: string) => `.aw/run-${id}`;

/** The first message of a step's session. */
export function stepPrompt(run: Run, i: number): string {
  const h = run.handoff;
  const s = run.steps[i];
  return [
    `You are step ${i + 1} of ${run.steps.length} (${STEP_KINDS[s.kind].label}) in an Agent Worlds run: other coding agents do the other steps in this same folder.`,
    `The task: ${run.task}`,
    STEP_KINDS[s.kind].brief(RUN_FILES(run.id)),
    h ? `The step before you (${STEP_KINDS[run.steps[i - 1].kind].label}, ${run.steps[i - 1].agent}) left a handoff: read "${h.path}" first.${h.summary ? ` Its summary: ${h.summary}` : ''}` : '',
    'When your part is done, call the aw_handoff tool with a short summary for the next step. If you need the user, ask them instead.',
  ].filter(Boolean).join('\n\n');
}

export function newRun(o: { task: string; worldId: string; repo: string; worktree: boolean; steps: { kind: StepKind; agent: AgentId; checkpoint: boolean }[]; now: number }): Run {
  return {
    id: randomBytes(3).toString('hex'), task: o.task, worldId: o.worldId, repo: o.repo, worktree: o.worktree, dir: null, handoff: null,
    steps: o.steps.map((s) => ({ ...s, status: 'pending', pane: null, direct: null, sessionId: null, summary: null })),
    current: 0, status: 'running', note: null, startedAt: o.now,
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
