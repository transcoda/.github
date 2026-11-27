import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { countLines, parseArgs, sizeErrors } from './file-size.mjs';

const script = fileURLToPath(new URL('./file-size.mjs', import.meta.url));
const lines = (n) => 'x\n'.repeat(n);

describe('countLines', () => {
  it('counts lines as an editor does', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\n'), 1);
    assert.equal(countLines('a\nb'), 2);
    assert.equal(countLines('a\n\n'), 2);
  });
});

describe('sizeErrors', () => {
  const check = (sizes, allowlist) =>
    sizeErrors(new Map(Object.entries(sizes)), allowlist, 10, 'list.json').map((e) => e.message);

  it('passes files within the budget and allowlisted files at their number', () => {
    assert.deepEqual(check({ 'a.ts': 10, 'big.ts': 30 }, { 'big.ts': 30 }), []);
  });

  it('fails a new file over the budget', () => {
    assert.deepEqual(check({ 'a.ts': 11 }, {}), [
      'a.ts has 11 lines, over the budget of 10. Split it into smaller files.',
    ]);
  });

  it('fails an allowlisted file that grew', () => {
    assert.match(
      check({ 'big.ts': 31 }, { 'big.ts': 30 })[0],
      /big.ts grew to 31 lines; list.json allows 30/,
    );
  });

  it('asks for a lower number when an allowlisted file shrank, and its removal within budget', () => {
    assert.deepEqual(check({ 'big.ts': 25 }, { 'big.ts': 30 }), [
      'big.ts shrank to 25 lines: lower its number in list.json from 30 to 25.',
    ]);
    assert.match(
      check({ 'big.ts': 10 }, { 'big.ts': 30 })[0],
      /down to 10 lines.*remove it from list.json/,
    );
  });

  it('fails an allowlist entry for a file that is gone', () => {
    assert.match(check({}, { 'gone.ts': 30 })[0], /lists gone.ts, which no longer exists/);
  });
});

describe('parseArgs', () => {
  it('needs a budget and a glob', () => {
    assert.deepEqual(parseArgs(['--max-lines', '5', 'a/**']), {
      max: 5,
      allowlist: '',
      globs: ['a/**'],
    });
    assert.throws(() => parseArgs(['a/**']), /--max-lines/);
    assert.throws(() => parseArgs(['--max-lines', '1.5', 'a']), /--max-lines/);
    assert.throws(() => parseArgs(['--max-lines', '5']), /at least one glob/);
    assert.throws(() => parseArgs(['--max', '5']), /Unknown option --max/);
  });
});

describe('the script', () => {
  const repo = mkdtempSync(join(tmpdir(), 'file size '));
  const git = (...args) => execFileSync('git', args, { cwd: repo });
  git('init', '-q');
  mkdirSync(join(repo, 'src'));
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, '.gitignore'), 'dist/\n');
  writeFileSync(join(repo, 'src/small.ts'), lines(3));
  writeFileSync(join(repo, 'src/big.ts'), lines(8));
  writeFileSync(join(repo, 'src/big.test.ts'), lines(50));
  writeFileSync(join(repo, 'dist/out.ts'), lines(50));
  writeFileSync(join(repo, 'list.json'), JSON.stringify({ 'src/big.ts': 8 }));
  git('add', 'src/small.ts', '.gitignore');
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: 'true' },
    });

  it('checks tracked and new files, not ignored ones; a multi-line glob argument excludes', () => {
    const r = run('--max-lines', '5', '--allowlist', 'list.json', '**/*.ts');
    // dist/out.ts is as big, but ignored.
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      '::error file=src/big.test.ts::src/big.test.ts has 50 lines, over the budget of 5. Split it into smaller files.\n',
    );
    const ok = run('--max-lines', '5', '--allowlist', 'list.json', 'src/**\n!**/*.test.ts\n');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout, '2 files within 5 lines (1 allowlisted at their current size).\n');
  });

  it('exits 2 on a bad allowlist or arguments', () => {
    assert.equal(run('--max-lines', '5', '--allowlist', 'nope.json', 'src/**').status, 2);
    writeFileSync(join(repo, 'bad.json'), JSON.stringify({ 'src/big.ts': '8' }));
    const r = run('--max-lines', '5', '--allowlist', 'bad.json', 'src/**');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs a whole number of lines/);
  });
});
