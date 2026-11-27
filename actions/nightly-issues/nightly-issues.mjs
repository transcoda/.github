// Turns a nightly run's test reports into GitHub issues: one per failing test, with the label (by
// default `nightly`). A test that already has an open issue gets a comment instead of a second issue;
// a test that passes again gets its issue closed. A run that failed before any report said why
// (install, build) gets one "the nightly run failed" issue. Moved from transcoda/transcoda's
// scripts/nightly-issues.ts; run by action.yml:
//   node nightly-issues.mjs
// Each report is vitest's or Playwright's JSON report (told apart by their shape).
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/name), REPORTS (one path per line), LABEL, RUN_URL,
// SHA, RUN_FAILED ("true" when a step failed), STEP_FAILED ("true" when a step that is not a test
// failed, whatever the tests did), TEST_ROOT (where the tests ran, to make vitest's paths relative;
// default: here). A missing report counts as "nothing ran there": none of its issues are closed,
// and the run counts as failed. DRY_RUN=true prints what it would do and writes nothing.
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { client } from '../../lib/github.mjs';
import { apply, describe, marker, openIssues } from '../../lib/issues.mjs';
import { isMain } from '../../lib/main.mjs';

/** The marker kind in an issue body: `<!-- nightly-test: <test id> -->`. */
export const KIND = 'nightly-test';
/** The id of the "the run failed before its tests" issue. */
export const RUN_ID = 'the nightly run';
/** The id of the one issue that stands in for more than {@link MAX_NEW} new failing tests. */
export const MANY_ID = 'many tests';
/** More new failures than this at once (a broken build, a changed page) get one issue, not one each. */
export const MAX_NEW = 10;
const MAX_ERROR = 3000;

/**
 * @typedef {{ id: string, passed: boolean, error: string }} TestResult
 *   id: `apps/web/src/x.test.ts > describe > test`, or `e2e/x.e2e.ts > [project] > test`;
 *   error: the failure's message, colour codes removed; empty for a pass.
 * @typedef {import('../../lib/issues.mjs').OpenIssue} OpenIssue
 * @typedef {import('../../lib/issues.mjs').Action} Action
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes start with ESC.
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

const clip = (s) =>
  s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR)}\n… (cut; the full output is in the run)` : s;

/** The vitest JSON reporter's results; a file that failed to load is one failing "test". */
export function parseVitest(report, root) {
  /** @type {TestResult[]} */
  const out = [];
  for (const file of report.testResults) {
    const path = relative(root, file.name);
    for (const t of file.assertionResults) {
      if (t.status !== 'passed' && t.status !== 'failed') continue;
      out.push({
        id: [path, ...(t.title ? [...(t.ancestorTitles ?? []), t.title] : [t.fullName])].join(
          ' > ',
        ),
        passed: t.status === 'passed',
        error: stripAnsi((t.failureMessages ?? []).join('\n')),
      });
    }
    if (file.status === 'failed' && !file.assertionResults.some((t) => t.status === 'failed')) {
      out.push({ id: `${path} (the file)`, passed: false, error: stripAnsi(file.message ?? '') });
    }
  }
  return out;
}

/** Playwright's JSON reporter: each test in each project; a flaky one (passed on retry) passes. */
export function parsePlaywright(report) {
  /** @type {TestResult[]} */
  const out = [];
  const walk = (suite, titles) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        if (t.status === 'skipped') continue;
        const path = [...titles, spec.title].join(' > ');
        const last = t.results.at(-1)?.error?.message ?? '';
        out.push({
          id: `e2e/${spec.file} > [${t.projectName}] > ${path}`,
          passed: t.status !== 'unexpected',
          error: stripAnsi(last),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  // The top suites are the files; their titles are already in each spec's `file`.
  for (const file of report.suites ?? []) walk(file, []);
  return out;
}

/** The issue title for a test id (GitHub allows 256 characters). */
export function titleOf(id) {
  const named = {
    [RUN_ID]: 'Nightly: the run failed outside its tests',
    [MANY_ID]: 'Nightly: many tests fail',
  };
  const title = named[id] ?? `Nightly: ${id}`;
  return title.length > 250 ? `${title.slice(0, 249)}…` : title;
}

/**
 * What to do with GitHub: create an issue for a failing test without one, comment on one that has
 * one, close the open issue of a test that passed. `runFailed` without a failing test means the run
 * broke outside its tests (or a report is missing): that gets the run issue. `stepFailed` (a step
 * that is not a test failed) gets it even when tests fail too. A passing run closes it.
 * @param {TestResult[]} results
 * @param {OpenIssue[]} open
 * @param {{ runFailed: boolean, stepFailed?: boolean, runUrl: string, sha: string }} ctx
 * @returns {Action[]}
 */
export function plan(results, open, ctx) {
  /** @type {Action[]} */
  const actions = [];
  const byId = new Map(open.map((i) => [i.id, i.number]));
  const failing = results.filter((r) => !r.passed);
  const where = `[run](${ctx.runUrl}), commit ${ctx.sha.slice(0, 7)}`;
  const fail = (id, error) => {
    const number = byId.get(id);
    const output = error ? `\n\n\`\`\`\n${clip(error)}\n\`\`\`` : '';
    if (number !== undefined) {
      actions.push({
        kind: 'comment',
        number,
        body: `Still failing in the nightly ${where}.${output}`,
      });
      return;
    }
    const whats = {
      [RUN_ID]:
        'The nightly run failed in a step that is not a test (install, build, fixtures or a check script): its log says which.',
      [MANY_ID]:
        'The nightly run found more failing tests than it opens issues for: look for one cause first (the build, a shared helper, a page every screenshot shows).',
    };
    const what = whats[id] ?? `The nightly run found this test failing:\n\n\`${id}\``;
    actions.push({
      kind: 'create',
      id,
      title: titleOf(id),
      body: `${what}\n\nFirst seen in the ${where}.${output}\n\nThe nightly closes this issue once it passes again.\n\n${marker(KIND, id)}`,
    });
  };
  const fresh = failing.filter((r) => !byId.has(r.id));
  if (fresh.length > MAX_NEW) {
    for (const r of failing) if (byId.has(r.id)) fail(r.id, r.error);
    const list = fresh.map((r) => `- \`${r.id}\``).join('\n');
    fail(MANY_ID, `${fresh.length} tests without an issue fail:\n${list}`);
  } else {
    for (const r of failing) fail(r.id, r.error);
  }
  if ((ctx.runFailed && failing.length === 0) || ctx.stepFailed) fail(RUN_ID, '');

  const passed = new Set(results.filter((r) => r.passed).map((r) => r.id));
  if (!ctx.runFailed && !ctx.stepFailed) passed.add(RUN_ID);
  if (failing.length === 0 && !ctx.runFailed) passed.add(MANY_ID);
  for (const issue of open) {
    if (passed.has(issue.id)) {
      actions.push({
        kind: 'close',
        number: issue.number,
        body: `Passes again in the nightly ${where}.`,
      });
    }
  }
  return actions;
}

/**
 * The results of every report: vitest's (it has `testResults`) or Playwright's (`suites`). A
 * report that is missing (null) or neither marks the run as failed.
 * @returns {{ results: TestResult[], missing: boolean }}
 */
export function readReports(reports, root) {
  /** @type {TestResult[]} */
  const results = [];
  let missing = false;
  for (const r of reports) {
    if (r && typeof r === 'object' && 'testResults' in r) {
      results.push(...parseVitest(r, root));
    } else if (r && typeof r === 'object' && 'suites' in r) {
      results.push(...parsePlaywright(r));
    } else {
      missing = true;
    }
  }
  return { results, missing };
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Reads the reports named in env.REPORTS and opens, updates and closes the issues. */
export async function main(env = process.env, fetchImpl = globalThis.fetch, log = console.log) {
  const paths = (env.REPORTS ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);
  if (paths.length === 0) throw new Error('No reports: set the reports input (one path per line).');
  const label = env.LABEL || 'nightly';
  const repo = env.GITHUB_REPOSITORY ?? '';
  const api = client(env.GITHUB_TOKEN ?? '', fetchImpl);
  const { results, missing } = readReports(paths.map(readJson), env.TEST_ROOT || process.cwd());
  const actions = plan(results, await openIssues(api, repo, label, KIND), {
    runFailed: env.RUN_FAILED === 'true' || missing,
    stepFailed: env.STEP_FAILED === 'true',
    runUrl: env.RUN_URL ?? '',
    sha: env.SHA ?? '',
  });
  log(`${results.length} tests, ${results.filter((r) => !r.passed).length} failing`);
  if (env.DRY_RUN === 'true') {
    for (const line of describe(actions)) log(line);
    return;
  }
  await apply(api, repo, label, actions, log);
}

if (isMain(import.meta.url)) await main();
