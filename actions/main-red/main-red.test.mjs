import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeGitHub } from '../../lib/fake-github.mjs';
import { idOf } from '../../lib/issues.mjs';
import { KIND, main, plan } from './main-red.mjs';

const run = (over = {}) => ({
  event: 'push',
  head_branch: 'main',
  conclusion: 'failure',
  name: 'CI',
  path: '.github/workflows/ci.yml',
  html_url: 'https://example.test/runs/1',
  head_sha: 'abcdef0123',
  ...over,
});

describe('plan', () => {
  it('opens an issue naming the workflow and the run on the first failure', () => {
    const [a] = plan(run(), 'main', []);
    assert.equal(a.kind, 'create');
    assert.equal(a.title, 'Red main: CI fails');
    assert.ok(a.body.includes('**CI** workflow (`.github/workflows/ci.yml`)'));
    assert.ok(a.body.includes('[run](https://example.test/runs/1), commit abcdef0'));
    assert.equal(idOf(a.body, KIND), '.github/workflows/ci.yml');
  });

  it('comments while it keeps failing, timed out or failing to start included', () => {
    const open = [{ number: 4, id: '.github/workflows/ci.yml' }];
    for (const conclusion of ['failure', 'timed_out', 'startup_failure']) {
      assert.deepEqual(plan(run({ conclusion }), 'main', open), [
        {
          kind: 'comment',
          number: 4,
          body: 'Still failing on `main`: [run](https://example.test/runs/1), commit abcdef0.',
        },
      ]);
    }
  });

  it('closes the issue when the workflow passes again, and only that workflow’s issue', () => {
    const open = [
      { number: 4, id: '.github/workflows/ci.yml' },
      { number: 5, id: '.github/workflows/docker.yml' },
    ];
    assert.deepEqual(
      plan(run({ conclusion: 'success' }), 'main', open).map((a) => [a.kind, a.number]),
      [['close', 4]],
    );
    assert.deepEqual(plan(run({ conclusion: 'success' }), 'main', []), []);
  });

  it('ignores cancelled runs, pull requests, other branches, and a ref after the path', () => {
    assert.deepEqual(plan(run({ conclusion: 'cancelled' }), 'main', []), []);
    assert.deepEqual(plan(run({ event: 'pull_request' }), 'main', []), []);
    assert.deepEqual(plan(run({ head_branch: 'feature' }), 'main', []), []);
    const [a] = plan(run({ path: '.github/workflows/ci.yml@refs/heads/main' }), 'main', []);
    assert.equal(a.id, '.github/workflows/ci.yml');
  });
});

describe('main', () => {
  const list = 'GET /repos/o/r/issues?state=open&labels=main-red&per_page=100&page=1';

  it('opens the issue with the label', async () => {
    const gh = fakeGitHub({ [list]: [], 'POST /repos/o/r/issues': { number: 12 } });
    const lines = [];
    await main(
      {
        GITHUB_TOKEN: 't',
        GITHUB_REPOSITORY: 'o/r',
        WORKFLOW_RUN: JSON.stringify(run()),
        DEFAULT_BRANCH: 'main',
      },
      gh.fetch,
      (l) => lines.push(l),
    );
    assert.deepEqual(lines, ['CI (push to main): failure', 'opened #12: Red main: CI fails']);
    assert.deepEqual(gh.calls[1].body.labels, ['main-red']);
  });

  it('does not call GitHub for a run that is not a push to the default branch', async () => {
    const gh = fakeGitHub({});
    await main(
      { WORKFLOW_RUN: JSON.stringify(run({ event: 'pull_request' })), DEFAULT_BRANCH: 'main' },
      gh.fetch,
      () => {},
    );
    assert.equal(gh.calls.length, 0);
  });

  it('needs a workflow_run event', async () => {
    await assert.rejects(
      main({ WORKFLOW_RUN: 'null' }, fakeGitHub({}).fetch, () => {}),
      /workflow_run/,
    );
  });
});
