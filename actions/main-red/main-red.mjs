// Keeps one issue open per workflow while its push runs on the default branch fail: opened on the
// first failure, commented on while it keeps failing, closed when a push run passes again.
// Run by action.yml from a `workflow_run` (completed) event:
//   node main-red.mjs
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, WORKFLOW_RUN (the event's workflow_run as JSON),
// DEFAULT_BRANCH, LABEL. A run that was not a push to the default branch, or that ended neither
// failed nor passed (cancelled, skipped), changes nothing.
import { client } from '../../lib/github.mjs';
import { apply, marker, openIssues } from '../../lib/issues.mjs';
import { isMain } from '../../lib/main.mjs';

/** The marker kind in an issue body: `<!-- main-red: <workflow file> -->`. */
export const KIND = 'main-red';
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

/**
 * What to do for one completed run. The issue is keyed by the workflow's file, so renaming the
 * workflow keeps its issue.
 * @param {{ event: string, head_branch: string, conclusion: string | null, name: string,
 *   path: string, html_url: string, head_sha: string }} run
 * @param {string} defaultBranch
 * @param {import('../../lib/issues.mjs').OpenIssue[]} open
 * @returns {import('../../lib/issues.mjs').Action[]}
 */
export function plan(run, defaultBranch, open) {
  if (run.event !== 'push' || run.head_branch !== defaultBranch) return [];
  const id = run.path.replace(/@.*$/, '');
  const number = open.find((i) => i.id === id)?.number;
  const where = `[run](${run.html_url}), commit ${run.head_sha.slice(0, 7)}`;
  if (FAILED.has(run.conclusion ?? '')) {
    if (number !== undefined) {
      return [
        { kind: 'comment', number, body: `Still failing on \`${defaultBranch}\`: ${where}.` },
      ];
    }
    return [
      {
        kind: 'create',
        id,
        title: `Red ${defaultBranch}: ${run.name} fails`.slice(0, 250),
        body: `The **${run.name}** workflow (\`${id}\`) failed on a push to \`${defaultBranch}\`: ${where}.\n\nIts log says which step. A failure that passed on the pull request is often a flaky test or a clash between two merges.\n\nThis issue gets a comment for every further failing run and is closed when the workflow passes on \`${defaultBranch}\` again.\n\n${marker(KIND, id)}`,
      },
    ];
  }
  if (run.conclusion === 'success' && number !== undefined) {
    return [{ kind: 'close', number, body: `Passes again on \`${defaultBranch}\`: ${where}.` }];
  }
  return [];
}

export async function main(env = process.env, fetchImpl = globalThis.fetch, log = console.log) {
  const run = JSON.parse(env.WORKFLOW_RUN || 'null');
  if (!run?.path) throw new Error('No workflow_run event: run this action on `workflow_run`.');
  const label = env.LABEL || 'main-red';
  const repo = env.GITHUB_REPOSITORY ?? '';
  const branch = env.DEFAULT_BRANCH || 'main';
  log(`${run.name} (${run.event} to ${run.head_branch}): ${run.conclusion}`);
  if (run.event !== 'push' || run.head_branch !== branch) {
    log(`Not a push to ${branch}: nothing to do.`);
    return;
  }
  const api = client(env.GITHUB_TOKEN ?? '', fetchImpl);
  const actions = plan(run, branch, await openIssues(api, repo, label, KIND));
  if (actions.length === 0) log('Nothing to do.');
  await apply(api, repo, label, KIND, actions, log);
}

if (isMain(import.meta.url)) await main();
