import { promisify } from 'node:util';
import { execFile } from './child.ts';
import { cliFor } from './issues.ts';

const run = promisify(execFile);
export type ForgeChange = { state: 'open' | 'closed' | 'merged'; headSha: string; mergedAt: string | null; url: string };
export type ForgeLookup = (repo: string, remote: string, branch: string) => Promise<ForgeChange | null>;

/** Read-only CLI adapter; #135 can reuse this shape for change status on cards. Ambiguity fails closed. */
export const branchChange: ForgeLookup = async (repo, remote, branch) => {
  const cli = cliFor(remote);
  const args = cli === 'gh'
    ? ['pr', 'list', `--repo=${remote}`, `--head=${branch}`, '--state=all', '--limit=100', '--json=state,headRefOid,mergedAt,url']
    : ['mr', 'list', `--repo=${remote}`, `--source-branch=${branch}`, '--all', '--per-page=100', '--output=json'];
  const { stdout } = await run(cli, args, { cwd: repo, timeout: 15_000, maxBuffer: 1 << 20,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GLAB_NO_PROMPT: '1' } });
  const rows: unknown = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const r = rows[0];
  const state = String(r.state).toLowerCase();
  const headSha = cli === 'gh' ? r.headRefOid : r.sha ?? r.diff_refs?.head_sha;
  const mergedAt = cli === 'gh' ? r.mergedAt : r.merged_at;
  const url = cli === 'gh' ? r.url : r.web_url;
  if (!['open', 'opened', 'closed', 'merged'].includes(state) || !/^[a-f0-9]{40,64}$/.test(headSha ?? '') || typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  return { state: state === 'opened' ? 'open' : state as ForgeChange['state'], headSha, mergedAt: typeof mergedAt === 'string' ? mergedAt : null, url };
};
