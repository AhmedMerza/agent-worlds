export type ConflictInput = { id: string; repo: string; cwd: string; branch: string | null; worktree: boolean; testing: boolean };
export type Conflict = { withId: string; reason: string };

/** Issue number in a branch name: "#53", "feat/53-thing", "fix-53-thing". */
export function issueOf(branch: string | null): string | null {
  if (!branch) return null;
  const m = branch.match(/#(\d+)/) ?? branch.match(/(?:^|[/_-])(\d{1,6})(?=[-_])/);
  return m ? m[1] : null;
}

/** Pairwise overlaps between sessions, keyed by session id. */
export function computeConflicts(list: ConflictInput[]): Map<string, Conflict[]> {
  const out = new Map<string, Conflict[]>(list.map((s) => [s.id, []]));
  // Only sessions in one repo can overlap (a folder belongs to one repo): compare within each repo, not all pairs.
  const byRepo = new Map<string, ConflictInput[]>();
  for (const s of list) { const a = byRepo.get(s.repo); if (a) a.push(s); else byRepo.set(s.repo, [s]); }
  const issues = new Map(list.map((s) => [s.id, issueOf(s.branch)]));
  for (const a of list) {
    for (const b of byRepo.get(a.repo)!) {
      if (a.id === b.id) continue;
      const reasons: string[] = [];
      if (a.cwd === b.cwd) reasons.push('same folder');
      else if (a.repo === b.repo && a.branch && a.branch === b.branch) reasons.push(`same branch ${a.branch}`);
      if (a.repo === b.repo && a.testing && b.testing) reasons.push('shared database: tests in both');
      const ia = issues.get(a.id);
      if (ia && a.repo === b.repo && ia === issues.get(b.id) && a.branch !== b.branch) reasons.push(`same issue #${ia}`);
      if (reasons.length) out.get(a.id)!.push({ withId: b.id, reason: reasons.join('; ') });
    }
  }
  return out;
}
