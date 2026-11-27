// The shared Biome config, run by the Biome this repository pins on a small consumer: the strict
// rules fire, config files and an override may default-export, and the Grit rules load from the
// package path a consumer uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const biome = join(here, '../node_modules/.bin/biome');

/** Lints a temp project with these files; returns "file rule" for each diagnostic. */
function lint(files) {
  const dir = mkdtempSync(join(tmpdir(), 'biome-base-'));
  // As a consumer: extend the base, add the Grit rules with its own includes, and its own override.
  const config = {
    extends: [join(here, 'base.json')],
    plugins: [
      { path: join(here, 'utc-dates.grit'), includes: ['src/**', '!**/*.test.ts'] },
      { path: join(here, 'test-cleanup.grit'), includes: ['**/*.test.tsx'] },
    ],
    overrides: [
      { includes: ['src/index.ts'], linter: { rules: { style: { noDefaultExport: 'off' } } } },
    ],
  };
  writeFileSync(join(dir, 'biome.json'), JSON.stringify(config));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const r = spawnSync(biome, ['lint', '--max-diagnostics=100', '.'], {
    cwd: dir,
    encoding: 'utf8',
  });
  const out = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(out, /configuration|Failed to|deserialize/i, out);
  return [...out.matchAll(/^(\S+?):\d+:\d+ (\S+)/gm)].map(([, file, rule]) => `${file} ${rule}`);
}

it('the strict rules are errors in any file, console only in src', () => {
  const found = lint({
    'src/a.ts': [
      "import { b } from './b';",
      'export async function f(): Promise<number> {',
      '  return 1;',
      '}',
      'export function g(x: any, y?: string): string {',
      '  f();',
      '  console.log(x);',
      '  return y! + b;',
      '}',
      '',
    ].join('\n'),
    'src/b.ts': 'export const b = 1;\nexport default b;\n',
    'scripts/run.ts': "console.log('fine in a script');\n",
  });
  assert.deepEqual(found.sort(), [
    'src/a.ts lint/correctness/useImportExtensions',
    'src/a.ts lint/nursery/noFloatingPromises',
    'src/a.ts lint/style/noNonNullAssertion',
    'src/a.ts lint/suspicious/noConsole',
    'src/a.ts lint/suspicious/noExplicitAny',
    'src/b.ts lint/style/noDefaultExport',
  ]);
});

it('config files and a consumer override may default-export; tests may not be skipped', () => {
  const found = lint({
    'vitest.config.ts': 'export default {};\n',
    'plugins/x/tsdown.config.mjs': 'export default {};\n',
    'src/index.ts': 'const plugin = {};\nexport default plugin;\n',
    'src/a.test.ts': "import { it } from 'vitest';\n\nit.skip('later', () => {});\n",
  });
  assert.deepEqual(found, ['src/a.test.ts lint/suspicious/noSkippedTests']);
});

it('the Grit rules load from the package and report', () => {
  const found = lint({
    'src/time.ts': 'export const hour = (d: Date): number => d.getHours();\n',
    'web/a.test.tsx': [
      "import { render } from '@testing-library/react';",
      "import { it } from 'vitest';",
      '',
      "it('renders', () => {",
      '  render(null);',
      '});',
      '',
    ].join('\n'),
  });
  assert.deepEqual(found.sort(), ['src/time.ts plugin', 'web/a.test.tsx plugin']);
});

it('test-cleanup takes cleanup passed or called, not a callback that only returns it', () => {
  const file = (hook) =>
    [
      "import { cleanup, render } from '@testing-library/react';",
      "import { afterEach, it } from 'vitest';",
      '',
      hook,
      '',
      "it('renders', () => {",
      '  render(null);',
      '});',
      '',
    ].join('\n');
  const found = lint({
    'web/passed.test.tsx': file('afterEach(cleanup);'),
    'web/called.test.tsx': file('afterEach(() => cleanup());'),
    'web/block.test.tsx': file('afterEach(() => {\n  cleanup();\n});'),
    'web/returned.test.tsx': file('afterEach(() => cleanup);'),
    'web/nested.test.tsx': file("describe('x', () => {\n  afterEach(cleanup);\n});"),
  });
  assert.deepEqual(found.sort(), ['web/nested.test.tsx plugin', 'web/returned.test.tsx plugin']);
});
