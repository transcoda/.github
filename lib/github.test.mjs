import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fakeGitHub } from './fake-github.mjs';
import { all, client } from './github.mjs';
import { apply, describe, idOf, marker, openIssues } from './issues.mjs';

it('the client sends the token and throws on an error status', async () => {
  const gh = fakeGitHub({ 'GET /x': { ok: 1 } });
  const api = client('t0k', gh.fetch);
  assert.deepEqual(await api('/x'), { ok: 1 });
  assert.equal(gh.calls[0].auth, 'Bearer t0k');
  await assert.rejects(api('/missing'), /GET \/missing: 404/);
});

it('all() pages until a short page', async () => {
  const full = Array.from({ length: 100 }, (_, i) => i);
  const gh = fakeGitHub({
    'GET /l?a=1&per_page=100&page=1': full,
    'GET /l?a=1&per_page=100&page=2': [100],
  });
  assert.equal((await all(client('t', gh.fetch), '/l?a=1')).length, 101);
});

it('a marker is found again by its kind only', () => {
  const body = `text\n\n${marker('nightly-test', 'a.test.ts > b')}`;
  assert.equal(body.endsWith('<!-- nightly-test: a.test.ts > b -->'), true);
  assert.equal(idOf(body, 'nightly-test'), 'a.test.ts > b');
  assert.equal(idOf(body, 'main-red'), null);
  assert.equal(idOf(null, 'main-red'), null);
});

it('openIssues keeps issues with a marker of the kind, not pull requests', async () => {
  const gh = fakeGitHub({
    'GET /repos/o/r/issues?state=open&labels=main-red&per_page=100&page=1': [
      { number: 1, body: marker('main-red', 'ci.yml') },
      { number: 2, body: 'no marker' },
      { number: 3, body: marker('main-red', 'x'), pull_request: {} },
      { number: 4, body: marker('nightly-test', 'y') },
    ],
  });
  assert.deepEqual(await openIssues(client('t', gh.fetch), 'o/r', 'main-red', 'main-red'), [
    { number: 1, id: 'ci.yml' },
  ]);
});

it('apply opens with the label, comments, and comments before closing', async () => {
  const gh = fakeGitHub({
    'POST /repos/o/r/issues': { number: 9 },
    'POST /repos/o/r/issues/5/comments': {},
    'POST /repos/o/r/issues/6/comments': {},
    'PATCH /repos/o/r/issues/6': {},
  });
  const lines = [];
  const actions = [
    { kind: 'create', id: 'a', title: 'T', body: 'B' },
    { kind: 'comment', number: 5, body: 'still' },
    { kind: 'close', number: 6, body: 'passes' },
  ];
  await apply(client('t', gh.fetch), 'o/r', 'lbl', actions, (l) => lines.push(l));
  assert.deepEqual(
    gh.calls.map((c) => c.key),
    [
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/5/comments',
      'POST /repos/o/r/issues/6/comments',
      'PATCH /repos/o/r/issues/6',
    ],
  );
  assert.deepEqual(gh.calls[0].body, { title: 'T', body: 'B', labels: ['lbl'] });
  assert.deepEqual(gh.calls[3].body, { state: 'closed', state_reason: 'completed' });
  assert.deepEqual(lines, ['opened #9: T', 'commented on #5', 'closed #6']);
  assert.deepEqual(describe(actions), ['would open: T', 'would comment #5', 'would close #6']);
});
