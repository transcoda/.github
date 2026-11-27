import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeGitHub } from '../../lib/fake-github.mjs';
import { hasImage, main, screenshotError } from './screenshots.mjs';

const PATHS = 'apps/web/src/**\n!**/*.test.{ts,tsx}\n!apps/web/src/test/**';
const SKIP = 'no screenshots needed';

describe('hasImage', () => {
  it('finds Markdown images, img and video tags, and attachment links', () => {
    assert.ok(hasImage('Before:\n![before](https://example.test/a.png)'));
    assert.ok(hasImage('![](<images/my shot.png>)'));
    assert.ok(hasImage('<img width="400" alt="after" src="https://example.test/b.png">'));
    assert.ok(hasImage("<IMG src='x.png'/>"));
    assert.ok(hasImage('<video src="https://example.test/c.mp4"></video>'));
    assert.ok(
      hasImage('https://github.com/user-attachments/assets/0f1e2d3c-aaaa-bbbb-cccc-1234567890ab'),
    );
  });

  it('ignores empty images, plain links and commented-out examples', () => {
    assert.ok(!hasImage(null));
    assert.ok(!hasImage(''));
    assert.ok(!hasImage('![before]()'));
    assert.ok(!hasImage('[a link](https://example.test/a.png)'));
    assert.ok(!hasImage('<img alt="no source">'));
    assert.ok(!hasImage('## Screenshots\n<!-- ![before](before.png) ![after](after.png) -->'));
    assert.ok(!hasImage('<!-- unclosed ![x](y.png)'));
  });
});

describe('screenshotError', () => {
  const pr = (over) => ({
    files: [],
    body: '',
    labels: [],
    paths: PATHS,
    skipLabel: SKIP,
    ...over,
  });

  it('fails a UI change without an image, listing the UI files', () => {
    const error = screenshotError(pr({ files: ['apps/web/src/pages/JobsPage.tsx', 'README.md'] }));
    assert.match(
      error,
      /changes the UI but its description has no screenshot:\n {2}apps\/web\/src\/pages\/JobsPage.tsx\nAdd before/,
    );
    assert.doesNotMatch(error, /README/);
    assert.match(error, /"no screenshots needed" label/);
  });

  it('passes with an image, with the label, or without UI files (tests do not count)', () => {
    const files = ['apps/web/src/styles.css'];
    assert.equal(
      screenshotError(pr({ files, body: '![after](https://example.test/a.png)' })),
      null,
    );
    assert.equal(screenshotError(pr({ files, labels: [SKIP] })), null);
    assert.equal(screenshotError(pr({ files: ['apps/web/src/pages/JobsPage.test.tsx'] })), null);
    assert.equal(screenshotError(pr({ files: ['apps/web/src/test/render.tsx'] })), null);
  });

  it('lists at most ten files', () => {
    const files = Array.from({ length: 12 }, (_, i) => `apps/web/src/c${i}.tsx`);
    assert.match(screenshotError(pr({ files })), /… and 2 more/);
  });
});

describe('main', () => {
  const FILES = 'GET /repos/o/r/pulls/7/files?per_page=100&page=1';
  const env = {
    GITHUB_TOKEN: 't',
    GITHUB_REPOSITORY: 'o/r',
    PR_NUMBER: '7',
    PATHS,
    PR_LABELS: '[]',
  };

  it('reads the changed files, a rename by both names, and fails without an image', async () => {
    const gh = fakeGitHub({
      [FILES]: [{ filename: 'docs/old-page.tsx', previous_filename: 'apps/web/src/pages/Old.tsx' }],
    });
    const lines = [];
    assert.equal(
      await main({ ...env, PR_BODY: 'No pictures.' }, gh.fetch, (l) => lines.push(l)),
      1,
    );
    assert.ok(lines.includes('  apps/web/src/pages/Old.tsx'));
    assert.match(lines.at(-1), /^::error::/);
  });

  it('passes with an image', async () => {
    const gh = fakeGitHub({ [FILES]: [{ filename: 'apps/web/src/pages/Jobs.tsx' }] });
    assert.equal(
      await main({ ...env, PR_BODY: '![a](https://example.test/a.png)' }, gh.fetch, () => {}),
      0,
    );
  });

  it('the label skips without asking GitHub', async () => {
    const gh = fakeGitHub({});
    assert.equal(await main({ ...env, PR_LABELS: JSON.stringify([SKIP]) }, gh.fetch, () => {}), 0);
    assert.equal(gh.calls.length, 0);
  });
});
