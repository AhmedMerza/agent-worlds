import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchChange } from '../src/forge.ts';
import { tmp } from './fixtures.ts';

test('forge CLI adapters: GitHub and self-hosted GitLab state/head/time/url, exact branch and repo, fail closed', async () => {
  const bin = tmp('aw-forge-'), capture = join(bin, 'argv'), response = join(bin, 'response');
  for (const cli of ['gh', 'glab']) {
    const file = join(bin, cli);
    writeFileSync(file, `#!${process.execPath}\nconst fs=require('fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));const data=fs.readFileSync(${JSON.stringify(response)},'utf8');if(data==='fail')process.exit(1);console.log(data);`);
    chmodSync(file, 0o755);
  }
  const original = process.env.PATH; process.env.PATH = `${bin}:${original}`;
  const sha = 'a'.repeat(40), date = '2026-11-01T00:00:00Z';
  try {
    for (const remote of ['git@github.com:owner/repo.git', 'https://gitlab.example.com/group/repo.git']) {
      const github = remote.includes('github');
      for (const [state, expected] of [['OPEN', 'open'], ['CLOSED', 'closed'], ['MERGED', 'merged']] as const) {
        writeFileSync(response, JSON.stringify([github ? { state, headRefOid: sha, mergedAt: date, url: 'https://github.com/owner/repo/pull/1' }
          : { state: state === 'OPEN' ? 'opened' : state.toLowerCase(), sha, merged_at: date, web_url: 'https://gitlab.example.com/group/repo/-/merge_requests/1' }]));
        const result = await branchChange(bin, remote, 'aw/topic;$(false)');
        assert.deepEqual(result, { state: expected, headSha: sha, mergedAt: date, url: github ? 'https://github.com/owner/repo/pull/1' : 'https://gitlab.example.com/group/repo/-/merge_requests/1' });
        const args = JSON.parse(readFileSync(capture, 'utf8'));
        assert.ok(args.includes(`--repo=${remote}`)); assert.ok(args.includes(`${github ? '--head' : '--source-branch'}=aw/topic;$(false)`));
        assert.equal(args[0], github ? 'pr' : 'mr'); assert.equal(args[1], 'list');
      }
    }
    for (const reply of ['[]', '[{},{}]', '[{}]', '[{"state":"merged","headRefOid":"bad"}]']) {
      writeFileSync(response, reply); assert.equal(await branchChange(bin, 'git@github.com:owner/repo.git', 'aw/test'), null);
    }
    writeFileSync(response, 'fail'); await assert.rejects(branchChange(bin, 'git@github.com:owner/repo.git', 'aw/test'));
    writeFileSync(response, 'not-json'); await assert.rejects(branchChange(bin, 'git@github.com:owner/repo.git', 'aw/test'));
  } finally { process.env.PATH = original; }
});
