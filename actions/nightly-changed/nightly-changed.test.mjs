import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fakeGitHub } from '../../lib/fake-github.mjs';
import { main, workflowFile } from './nightly-changed.mjs';

const RUNS =
  'GET /repos/o/plugins/actions/workflows/nightly.yml/runs?branch=main&status=completed&per_page=1';
const SINCE = '2026-11-25T07:47:00Z';
const CORE = `GET /repos/o/core/commits?sha=main&since=${encodeURIComponent(SINCE)}&per_page=1`;
const env = {
  GITHUB_TOKEN: 't',
  GITHUB_REPOSITORY: 'o/plugins',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_SHA: 'bbbbbbb222',
  GITHUB_REF_NAME: 'main',
  GITHUB_WORKFLOW_REF: 'o/plugins/.github/workflows/nightly.yml@refs/heads/main',
  WATCH: 'o/core\n',
};
const lastRun = (head_sha) => ({ workflow_runs: [{ head_sha, run_started_at: SINCE }] });

async function decide(routes, over = {}) {
  const gh = fakeGitHub(routes);
  const lines = [];
  const output = join(mkdtempSync(join(tmpdir(), 'changed-')), 'out');
  const run = await main({ ...env, GITHUB_OUTPUT: output, ...over }, gh.fetch, (l) =>
    lines.push(l),
  );
  assert.equal(readFileSync(output, 'utf8'), `run=${run}\n`);
  return { run, line: lines.join('\n'), calls: gh.calls.map((c) => c.key) };
}

describe('nightly-changed', () => {
  it('a manual run always runs, without asking GitHub', async () => {
    const r = await decide({}, { GITHUB_EVENT_NAME: 'workflow_dispatch' });
    assert.equal(r.run, true);
    assert.deepEqual(r.calls, []);
  });

  it('runs when there is no earlier completed run', async () => {
    const r = await decide({ [RUNS]: { workflow_runs: [] } });
    assert.equal(r.run, true);
    assert.match(r.line, /No earlier completed run of nightly.yml/);
  });

  it('runs when this repository moved, without looking at the others', async () => {
    const r = await decide({ [RUNS]: lastRun('aaaaaaa111') });
    assert.equal(r.run, true);
    assert.match(r.line, /main moved since the last run \(aaaaaaa → bbbbbbb\)/);
    assert.deepEqual(r.calls, [RUNS]);
  });

  it('runs when a watched repository got a commit since the last run started', async () => {
    const r = await decide({ [RUNS]: lastRun('bbbbbbb222'), [CORE]: [{ sha: 'c' }] });
    assert.equal(r.run, true);
    assert.match(r.line, /o\/core's main moved since the last run/);
  });

  it('skips when nothing moved', async () => {
    const r = await decide({ [RUNS]: lastRun('bbbbbbb222'), [CORE]: [] });
    assert.equal(r.run, false);
    assert.match(r.line, /Nothing to test: main is still at bbbbbbb .* nor o\/core's main moved/);
  });

  it('without watched repositories, only this one counts', async () => {
    const r = await decide({ [RUNS]: lastRun('bbbbbbb222') }, { WATCH: '' });
    assert.equal(r.run, false);
    assert.deepEqual(r.calls, [RUNS]);
  });

  it('reads the workflow file from the workflow ref', () => {
    assert.equal(workflowFile('o/r/.github/workflows/nightly.yml@refs/heads/main'), 'nightly.yml');
    assert.throws(() => workflowFile(undefined), /workflow file/);
  });
});
