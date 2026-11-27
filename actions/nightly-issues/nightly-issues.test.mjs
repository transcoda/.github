import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fakeGitHub } from '../../lib/fake-github.mjs';
import { idOf } from '../../lib/issues.mjs';
import {
  KIND,
  MANY_ID,
  MAX_NEW,
  main,
  parsePlaywright,
  parseVitest,
  plan,
  RUN_ID,
  readReports,
  titleOf,
} from './nightly-issues.mjs';

const ctx = { runFailed: false, runUrl: 'https://example.test/run/1', sha: 'abcdef0123' };
const pass = (id) => ({ id, passed: true, error: '' });
const fail = (id, error = 'boom') => ({ id, passed: false, error });
const pick = (list, keys) =>
  list.map((a) => Object.fromEntries(keys.filter((k) => k in a).map((k) => [k, a[k]])));

const vitest = {
  testResults: [
    {
      name: '/repo/plugins/a/src/a.test.ts',
      status: 'passed',
      assertionResults: [{ fullName: 'a works', title: 'works', status: 'passed' }],
    },
  ],
};
const playwright = {
  suites: [
    {
      title: 'x.e2e.ts',
      specs: [
        {
          title: 't',
          file: 'x.e2e.ts',
          tests: [{ projectName: 'p', status: 'expected', results: [{}] }],
        },
      ],
    },
  ],
};

describe('readReports', () => {
  it('reads each report by its shape, in any number (the plugins nightly has only vitest)', () => {
    assert.deepEqual(readReports([vitest], '/repo'), {
      results: [
        { id: 'plugins/a/src/a.test.ts > works', passed: true, error: '' },
        { id: 'plugins/a/src/a.test.ts (the file)', passed: true, error: '' },
      ],
      missing: false,
    });
    assert.equal(readReports([vitest, playwright], '/repo').results.length, 3);
  });

  it('a missing or unknown report marks the run failed', () => {
    assert.equal(readReports([vitest, null], '/repo').missing, true);
    assert.deepEqual(readReports([{ nope: 1 }], '/repo'), { results: [], missing: true });
  });
});

describe('parseVitest', () => {
  it('names each test by its file and full name, and a file that did not load as one failure', () => {
    const results = parseVitest(
      {
        testResults: [
          {
            name: '/repo/apps/web/src/a.test.ts',
            status: 'failed',
            assertionResults: [
              {
                fullName: 'A works',
                ancestorTitles: ['A'],
                title: 'works',
                status: 'passed',
                failureMessages: [],
              },
              {
                fullName: 'A breaks',
                status: 'failed',
                failureMessages: ['\u001b[31mAssertionError\u001b[39m: no'],
              },
              { fullName: 'A later', status: 'skipped' },
            ],
          },
          {
            name: '/repo/apps/server/src/b.test.ts',
            status: 'failed',
            message: 'Cannot find module x',
            assertionResults: [],
          },
        ],
      },
      '/repo',
    );
    assert.deepEqual(results, [
      { id: 'apps/web/src/a.test.ts > A > works', passed: true, error: '' },
      { id: 'apps/web/src/a.test.ts > A breaks', passed: false, error: 'AssertionError: no' },
      // It loaded: its tests ran.
      { id: 'apps/web/src/a.test.ts (the file)', passed: true, error: '' },
      { id: 'apps/server/src/b.test.ts (the file)', passed: false, error: 'Cannot find module x' },
    ]);
  });

  it('a file whose tests run again closes its "(the file)" issue; one that never ran does not', () => {
    const results = parseVitest(
      {
        testResults: [
          {
            name: '/repo/b.test.ts',
            status: 'passed',
            assertionResults: [{ fullName: 'b works', title: 'works', status: 'passed' }],
          },
          {
            name: '/repo/c.test.ts',
            status: 'skipped',
            assertionResults: [{ fullName: 'c', status: 'skipped' }],
          },
        ],
      },
      '/repo',
    );
    const open = [
      { number: 1, id: 'b.test.ts (the file)' },
      { number: 2, id: 'c.test.ts (the file)' },
    ];
    assert.deepEqual(
      plan(results, open, ctx).map((a) => [a.kind, a.number]),
      [['close', 1]],
    );
  });

  it('makes ids that come back out of the issue marker unchanged', () => {
    const [arrow, broken] = parseVitest(
      {
        testResults: [
          {
            name: '/repo/a.test.ts',
            status: 'failed',
            assertionResults: [
              { fullName: 'x', title: 'maps a --> b', status: 'failed', failureMessages: [] },
              { fullName: 'y', title: 'two\nlines', status: 'failed', failureMessages: [] },
            ],
          },
        ],
      },
      '/repo',
    );
    assert.equal(arrow.id, 'a.test.ts > maps a -- > b');
    assert.equal(broken.id, 'a.test.ts > two lines');
    for (const { id } of [arrow, broken]) {
      const [create] = plan([fail(id)], [], ctx);
      assert.equal(idOf(create.body, KIND), id);
    }
  });
});

describe('parsePlaywright', () => {
  it('names each test per project with its describe titles; flaky passes, skipped is left out', () => {
    const results = parsePlaywright({
      suites: [
        {
          title: '3-visual.e2e.ts',
          file: '3-visual.e2e.ts',
          specs: [
            {
              title: 'main pages',
              file: '3-visual.e2e.ts',
              tests: [
                { projectName: 'light', status: 'expected', results: [{}] },
                {
                  projectName: 'dark',
                  status: 'unexpected',
                  results: [{ error: { message: 'jobs.png: 12 pixels differ' } }],
                },
                { projectName: 'phone', status: 'flaky', results: [{ error: {} }, {}] },
                { projectName: 'other', status: 'skipped', results: [] },
              ],
            },
          ],
          suites: [
            {
              title: 'signed out',
              specs: [
                {
                  title: 'sign-in page',
                  file: '3-visual.e2e.ts',
                  tests: [{ projectName: 'light', status: 'expected', results: [{}] }],
                },
              ],
            },
          ],
        },
      ],
    });
    assert.deepEqual(results, [
      { id: 'e2e/3-visual.e2e.ts > [light] > main pages', passed: true, error: '' },
      {
        id: 'e2e/3-visual.e2e.ts > [dark] > main pages',
        passed: false,
        error: 'jobs.png: 12 pixels differ',
      },
      { id: 'e2e/3-visual.e2e.ts > [phone] > main pages', passed: true, error: '' },
      { id: 'e2e/3-visual.e2e.ts > [light] > signed out > sign-in page', passed: true, error: '' },
    ]);
  });
});

describe('plan', () => {
  it('opens an issue for a new failure, with the marker its test id is found by', () => {
    const [action] = plan([fail('a.test.ts > breaks')], [], ctx);
    assert.equal(action.kind, 'create');
    assert.equal(action.id, 'a.test.ts > breaks');
    assert.equal(action.title, 'Nightly: a.test.ts > breaks');
    assert.ok(action.body.includes('[run](https://example.test/run/1), commit abcdef0'));
    assert.ok(action.body.includes('```\nboom\n```'));
    // The marker is the one core's script wrote, so issues opened before the move are found.
    assert.ok(action.body.endsWith('<!-- nightly-test: a.test.ts > breaks -->'));
    assert.equal(idOf(action.body, KIND), 'a.test.ts > breaks');
  });

  it('comments on the open issue of a test that still fails, and closes the one that passes', () => {
    const actions = plan(
      [fail('a > still'), pass('b > fixed'), pass('c > never broke')],
      [
        { number: 7, id: 'a > still' },
        { number: 8, id: 'b > fixed' },
        { number: 9, id: 'd > did not run' },
      ],
      ctx,
    );
    assert.deepEqual(pick(actions, ['kind', 'number']), [
      { kind: 'comment', number: 7 },
      { kind: 'close', number: 8 },
    ]);
  });

  it('a run that failed without a failing test gets the run issue; a good run closes it', () => {
    assert.deepEqual(
      pick(plan([pass('a > ok')], [], { ...ctx, runFailed: true }), ['kind', 'id', 'title']),
      [{ kind: 'create', id: RUN_ID, title: 'Nightly: the run failed outside its tests' }],
    );
    assert.deepEqual(
      pick(plan([pass('a > ok')], [{ number: 3, id: RUN_ID }], ctx), ['kind', 'number']),
      [{ kind: 'close', number: 3 }],
    );
    // A failed run with failing tests: their issues say it, the run issue stays as it is.
    const both = plan([fail('a > no')], [{ number: 3, id: RUN_ID }], { ...ctx, runFailed: true });
    assert.deepEqual(pick(both, ['kind', 'id']), [{ kind: 'create', id: 'a > no' }]);
  });

  it('a failed step that is not a test gets the run issue even when tests fail too', () => {
    const both = plan([fail('a > no')], [], { ...ctx, runFailed: true, stepFailed: true });
    assert.deepEqual(
      both.map((a) => a.id),
      ['a > no', RUN_ID],
    );
    // Still failing: a comment, and the run issue stays open.
    const still = plan([pass('a > ok')], [{ number: 3, id: RUN_ID }], { ...ctx, stepFailed: true });
    assert.deepEqual(pick(still, ['kind', 'number']), [{ kind: 'comment', number: 3 }]);
  });

  it(`more than ${MAX_NEW} new failures get one issue listing them; known ones still get comments`, () => {
    const many = Array.from({ length: MAX_NEW + 1 }, (_, i) => fail(`t${i}`));
    const actions = plan([...many, fail('known')], [{ number: 5, id: 'known' }], ctx);
    assert.deepEqual(
      actions.map((a) => a.kind),
      ['comment', 'create'],
    );
    assert.equal(actions[1].id, MANY_ID);
    assert.equal(actions[1].title, 'Nightly: many tests fail');
    assert.ok(actions[1].body.includes('- `t10`'));
    // It closes once nothing fails.
    assert.deepEqual(
      pick(plan([pass('t0')], [{ number: 6, id: MANY_ID }], ctx), ['kind', 'number']),
      [{ kind: 'close', number: 6 }],
    );
  });

  it('keeps titles within what GitHub allows', () => {
    assert.ok(titleOf('x'.repeat(400)).length <= 256);
  });
});

describe('main', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nightly '));
  const report = join(dir, 'vitest.json');
  writeFileSync(
    report,
    JSON.stringify({
      testResults: [
        {
          name: join(dir, 'src/a.test.ts'),
          status: 'failed',
          assertionResults: [
            { fullName: 'a breaks', title: 'breaks', status: 'failed', failureMessages: ['no'] },
            { fullName: 'a works', title: 'works', status: 'passed' },
          ],
        },
      ],
    }),
  );
  const env = {
    GITHUB_TOKEN: 't',
    GITHUB_REPOSITORY: 'o/r',
    REPORTS: `${report}\n`,
    LABEL: 'nightly-plugins',
    TEST_ROOT: dir,
    RUN_URL: 'https://example.test/run/2',
    SHA: '1234567890',
    RUN_FAILED: 'true',
    STEP_FAILED: 'false',
  };
  const list = 'GET /repos/o/r/issues?state=open&labels=nightly-plugins&per_page=100&page=1';

  it('reads the reports, lists issues by the label, and opens, comments and closes', async () => {
    const gh = fakeGitHub({
      [list]: [{ number: 4, body: '<!-- nightly-test: src/a.test.ts > works -->' }],
      'POST /repos/o/r/issues': { number: 10 },
      'POST /repos/o/r/issues/4/comments': {},
      'PATCH /repos/o/r/issues/4': {},
    });
    const lines = [];
    await main(env, gh.fetch, (l) => lines.push(l));
    assert.deepEqual(lines, [
      '2 tests, 1 failing',
      'opened #10: Nightly: src/a.test.ts > breaks',
      'closed #4',
    ]);
    assert.deepEqual(gh.calls.find((c) => c.key === 'POST /repos/o/r/issues').body.labels, [
      'nightly-plugins',
    ]);
  });

  it('a missing report fails the run; DRY_RUN writes nothing', async () => {
    const gh = fakeGitHub({ [list]: [] });
    const lines = [];
    await main(
      {
        ...env,
        REPORTS: `${report}\n${join(dir, 'missing.json')}`,
        RUN_FAILED: 'false',
        DRY_RUN: 'true',
      },
      gh.fetch,
      (l) => lines.push(l),
    );
    assert.deepEqual(lines, ['2 tests, 1 failing', 'would open: Nightly: src/a.test.ts > breaks']);
    assert.equal(gh.calls.length, 1);
  });

  it('needs at least one report', async () => {
    await assert.rejects(main({ ...env, REPORTS: ' \n' }), /No reports/);
  });
});
