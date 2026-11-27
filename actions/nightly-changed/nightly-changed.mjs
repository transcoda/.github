// Decides whether a scheduled workflow has anything new to test: true when this repository's branch
// moved since the workflow's last completed run on it (any outcome: a failure on the same commit
// would only fail again), or when the `main` of another watched repository got a commit since that
// run started. A manual run (workflow_dispatch) and a first run always run.
// Run by action.yml:
//   node nightly-changed.mjs
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_SHA, GITHUB_REF_NAME,
// GITHUB_WORKFLOW_REF (owner/repo/.github/workflows/x.yml@ref), WATCH (owner/repo per line),
// GITHUB_OUTPUT (gets `run=true` or `run=false`).
import { appendFileSync } from 'node:fs';
import { client } from '../../lib/github.mjs';
import { isMain } from '../../lib/main.mjs';

/** The workflow's file name from GITHUB_WORKFLOW_REF, which the runs endpoint takes as its id. */
export function workflowFile(workflowRef) {
  const file = /\/\.github\/workflows\/([^@/]+)@/.exec(workflowRef ?? '')?.[1];
  if (!file) throw new Error(`Cannot tell the workflow file from "${workflowRef}".`);
  return file;
}

/**
 * Whether to run, and why.
 * @returns {Promise<{ run: boolean, reason: string }>}
 */
export async function decide(api, ctx) {
  if (ctx.event === 'workflow_dispatch') return { run: true, reason: 'Started by hand: running.' };
  const { workflow_runs: runs } = await api(
    `/repos/${ctx.repo}/actions/workflows/${ctx.workflow}/runs?branch=${encodeURIComponent(ctx.branch)}&status=completed&per_page=1`,
  );
  const last = runs[0];
  if (!last) return { run: true, reason: `No earlier completed run of ${ctx.workflow}: running.` };
  if (last.head_sha !== ctx.sha) {
    return {
      run: true,
      reason: `${ctx.branch} moved since the last run (${last.head_sha.slice(0, 7)} → ${ctx.sha.slice(0, 7)}): running.`,
    };
  }
  const since = last.run_started_at;
  for (const other of ctx.watch) {
    const commits = await api(
      `/repos/${other}/commits?sha=main&since=${encodeURIComponent(since)}&per_page=1`,
    );
    if (commits.length > 0) {
      return { run: true, reason: `${other}'s main moved since the last run (${since}): running.` };
    }
  }
  const others =
    ctx.watch.length > 0 ? `, nor ${ctx.watch.map((o) => `${o}'s main`).join(', ')}` : '';
  return {
    run: false,
    reason: `Nothing to test: ${ctx.branch} is still at ${ctx.sha.slice(0, 7)} as in the last run${others} moved since ${since}.`,
  };
}

export async function main(env = process.env, fetchImpl = globalThis.fetch, log = console.log) {
  const watch = (env.WATCH ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const { run, reason } = await decide(client(env.GITHUB_TOKEN ?? '', fetchImpl), {
    event: env.GITHUB_EVENT_NAME,
    repo: env.GITHUB_REPOSITORY,
    sha: env.GITHUB_SHA,
    branch: env.GITHUB_REF_NAME,
    workflow: workflowFile(env.GITHUB_WORKFLOW_REF),
    watch,
  });
  log(reason);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${run}\n`);
  return run;
}

if (isMain(import.meta.url)) await main();
