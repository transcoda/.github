import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { baselineErrors, countLines, parseArgs, parseRenames, sizeErrors } from './file-size.mjs';

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

describe('baselineErrors', () => {
  it('fails an entry the base did not have, or one raised since; lowered and kept ones pass', () => {
    const errors = baselineErrors(
      { 'a.ts': 9, 'b.ts': 20, 'c.ts': 30, 'd.ts': 40 },
      { 'a.ts': 8, 'b.ts': 25, 'c.ts': 30 },
      'list.json',
    ).map((e) => e.message);
    assert.deepEqual(errors, [
      'list.json raises a.ts from 8 to 9 lines; the numbers may only go down. Move code out of it instead.',
      'list.json adds d.ts; the allowlist only takes files away. Split the file instead.',
    ]);
  });

  it('compares a moved file with its old path, so a move alone adds nothing', () => {
    const renames = new Map([
      ['new/a.ts', 'old/a.ts'],
      ['new/b.ts', 'old/b.ts'],
      ['new/c.ts', 'old/c.ts'],
    ]);
    const errors = baselineErrors(
      { 'new/a.ts': 30, 'new/b.ts': 19, 'new/c.ts': 41, 'd.ts': 50 },
      { 'old/a.ts': 30, 'old/b.ts': 20, 'old/c.ts': 40 },
      'list.json',
      renames,
    ).map((e) => e.message);
    assert.deepEqual(errors, [
      'list.json raises new/c.ts (moved from old/c.ts) from 40 to 41 lines; the numbers may only go down. Move code out of it instead.',
      'list.json adds d.ts; the allowlist only takes files away. Split the file instead.',
    ]);
  });

  it('fails a moved file whose old path was not listed', () => {
    const errors = baselineErrors(
      { 'new/a.ts': 30 },
      {},
      'list.json',
      new Map([['new/a.ts', 'old/a.ts']]),
    );
    assert.match(errors[0].message, /adds new\/a\.ts;/);
  });
});

describe('parseRenames', () => {
  it('maps new paths to old ones and skips other changes', () => {
    const output = [
      'M',
      'kept.ts',
      'R100',
      'a.ts',
      'src/a.ts',
      'A',
      'added.ts',
      'R087',
      'b.ts',
      'lib/b.ts',
      'D',
      'gone.ts',
      '',
    ].join('\0');
    assert.deepEqual(
      parseRenames(output),
      new Map([
        ['src/a.ts', 'a.ts'],
        ['lib/b.ts', 'b.ts'],
      ]),
    );
    assert.deepEqual(parseRenames(''), new Map());
  });
});

describe('parseArgs', () => {
  it('needs a budget and a glob', () => {
    assert.deepEqual(parseArgs(['--max-lines', '5', '--base', 'abc', 'a/**']), {
      max: 5,
      allowlist: '',
      base: 'abc',
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

  it('exits 2 for globs that only exclude', () => {
    const r = run('--max-lines', '5', '!**/*.test.ts');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /only exclusions/);
  });
});

describe('the script with --base', () => {
  const repo = mkdtempSync(join(tmpdir(), 'file size base '));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.ts'), lines(1));
  git('add', '.');
  git('commit', '-q', '-m', 'before the allowlist');
  const noList = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'big.ts'), lines(8));
  writeFileSync(join(repo, 'list.json'), JSON.stringify({ 'big.ts': 8 }));
  git('add', '.');
  git('commit', '-q', '-m', 'allowlist');
  const base = git('rev-parse', 'HEAD');
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [script, '--max-lines', '5', '--allowlist', 'list.json', ...args, '**/*.ts'],
      {
        cwd: repo,
        encoding: 'utf8',
      },
    );

  it('fails a file that grew together with its number', () => {
    writeFileSync(join(repo, 'big.ts'), lines(9));
    writeFileSync(join(repo, 'list.json'), JSON.stringify({ 'big.ts': 9 }));
    assert.equal(run().status, 0);
    const r = run('--base', base);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /raises big\.ts from 8 to 9 lines/);
  });

  it('passes a file moved with its entry, and fails it once it grew', () => {
    writeFileSync(join(repo, 'big.ts'), lines(8));
    writeFileSync(join(repo, 'list.json'), JSON.stringify({ 'big.ts': 8 }));
    mkdirSync(join(repo, 'src'));
    git('mv', 'big.ts', 'src/big.ts');
    writeFileSync(join(repo, 'list.json'), JSON.stringify({ 'src/big.ts': 8 }));
    const moved = run('--base', base);
    assert.equal(moved.status, 0, moved.stderr);
    writeFileSync(join(repo, 'src/big.ts'), lines(9));
    writeFileSync(join(repo, 'list.json'), JSON.stringify({ 'src/big.ts': 9 }));
    const grew = run('--base', base);
    assert.equal(grew.status, 1);
    assert.match(grew.stderr, /raises src\/big\.ts \(moved from big\.ts\) from 8 to 9 lines/);
    git('mv', 'src/big.ts', 'big.ts');
    writeFileSync(join(repo, 'big.ts'), lines(8));
    writeFileSync(join(repo, 'list.json'), JSON.stringify({ 'big.ts': 8 }));
  });

  it('takes a base without the allowlist (the pull request that adds it) as no comparison', () => {
    assert.equal(run('--base', noList).status, 0);
  });

  it('exits 2 for a base it cannot find', () => {
    const r = run('--base', '0000000000000000000000000000000000000001');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /could not be fetched/);
  });
});
