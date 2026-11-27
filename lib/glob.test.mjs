import assert from 'node:assert/strict';
import { it } from 'node:test';
import { globToRegExp, matcher } from './glob.mjs';

const matches = (pattern, path) => globToRegExp(pattern).test(path);

it('** spans directories, * and ? stay within one', () => {
  assert.ok(matches('apps/web/src/**', 'apps/web/src/pages/JobsPage.tsx'));
  assert.ok(matches('apps/**/*.ts', 'apps/x.ts'));
  assert.ok(matches('apps/**/*.ts', 'apps/a/b/x.ts'));
  assert.ok(matches('**/*.test.ts', 'x.test.ts'));
  assert.ok(matches('**/*.test.ts', 'a/b/x.test.ts'));
  assert.ok(!matches('apps/*.ts', 'apps/a/x.ts'));
  assert.ok(matches('src/?.ts', 'src/a.ts'));
  assert.ok(!matches('src/?.ts', 'src/ab.ts'));
});

it('braces give alternatives, and dots are literal', () => {
  assert.ok(matches('**/*.{ts,tsx}', 'a/b.tsx'));
  assert.ok(matches('**/*.{ts,tsx}', 'a/b.ts'));
  assert.ok(!matches('**/*.{ts,tsx}', 'a/b.css'));
  assert.ok(!matches('*.ts', 'abts'));
  assert.ok(matches('a+b/(c).ts', 'a+b/(c).ts'));
});

it('a matcher needs one include and no exclude to match; text input skips blanks and comments', () => {
  const m = matcher(`
    # the web app, not its tests
    apps/web/src/**
    !**/*.test.{ts,tsx}
    !apps/web/src/test/**
  `);
  assert.ok(m('apps/web/src/pages/JobsPage.tsx'));
  assert.ok(m('apps/web/src/styles.css'));
  assert.ok(!m('apps/web/src/pages/JobsPage.test.tsx'));
  assert.ok(!m('apps/web/src/test/render.tsx'));
  assert.ok(!m('apps/server/src/index.ts'));
  assert.throws(() => matcher(['!x']), /only exclusions/);
});
